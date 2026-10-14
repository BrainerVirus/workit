import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostPid, markerFile, type LiveMarker } from "@/packages/workit-core/src/core/live-session";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture } from "./hooks/hook-fixtures";

// #274: the live-session guard on every host. Another live agent session
// (its marker: session, host, pid, heartbeat) owns checkout X; a different
// session's edit or mutating git/shell command in X is denied through each
// host's own write/shell hook, naming the owner, its host and age and an
// unblock. Read-only commands stay allowed.

const roots: string[] = [];
let state: string;
let previousState: string | undefined;
let sleeper: ChildProcess;

beforeEach(() => {
  previousState = process.env.WORKFLOW_TOOLKIT_STATE;
  state = mkdtempSync(path.join(os.tmpdir(), "wk-live-state-"));
  roots.push(state);
  process.env.WORKFLOW_TOOLKIT_STATE = state;
});
afterEach(() => {
  if (previousState === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = previousState;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => sleeper?.kill());

/** A live process that is not this test run (the foreign owner). */
const foreignPid = (): number => {
  sleeper ??= spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  return sleeper.pid as number;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

const repo = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-live-repo-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, "src"));
  return root;
};

const own = (checkout: string, marker: Partial<LiveMarker> = {}) => {
  const file = markerFile(checkout);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session: "other-session",
      leads: ["other-session"],
      host: "opencode",
      pid: foreignPid(),
      machine: os.hostname(),
      checkout,
      heartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      ...marker,
    }),
  );
  return file;
};

const claudeShell = (cwd: string, command: string, session = "claude-session-1") =>
  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "pre-tool-use-bash", cwd, {
      session_id: session,
      tool_input: { command, description: "x" },
    }),
    {},
  ).json as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };

const decisionOf = (rendered: ReturnType<typeof claudeShell>) =>
  rendered.hookSpecificOutput?.permissionDecision ?? "none";

test("G another live session owns the checkout, W a Claude Code session edits or runs a mutating command, T denied naming owner, host, age and the unblock; reads stay allowed", () => {
  const root = repo();
  const file = own(root);

  const write = dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "pre-tool-use-write", root),
    {},
  ).json as ReturnType<typeof claudeShell>;
  expect(write.hookSpecificOutput?.permissionDecision).toBe("deny");
  const reason = write.hookSpecificOutput?.permissionDecisionReason ?? "";
  expect(reason).toContain("workit live-session guard");
  expect(reason).toContain(
    `${root} belongs to another live agent session, OpenCode session other-session`,
  );
  expect(reason).toContain("last active 3 min ago");
  expect(reason).toContain("git worktree add");
  expect(reason).toContain(`rm '${file}'`);
  expect(reason).toContain("WORKIT_LIVE_SESSION=override");

  for (const command of [
    "git commit -m x",
    "git switch main",
    "git reset --hard",
    "git stash",
    "echo x > src/a.ts",
    "workit git commit -m x",
  ])
    expect(decisionOf(claudeShell(root, command)), command).toBe("deny");
  for (const command of [
    "git status",
    "git log --oneline",
    "git diff",
    "git stash list",
    "cat src/a.ts",
    "git worktree add ../mine -b feature/mine",
    "echo x > /tmp/elsewhere.txt",
  ])
    expect(decisionOf(claudeShell(root, command)), command).not.toBe("deny");
  // A one-command override.
  expect(decisionOf(claudeShell(root, "WORKIT_LIVE_SESSION=override git commit -m x"))).not.toBe(
    "deny",
  );
});

test("G another live session owns the checkout, W Codex, Cursor, OpenCode and Pi sessions edit or commit there, T each host's own hook denies it", () => {
  const root = repo();
  own(root, { host: "claude_code", session: "claude-lead", leads: ["claude-lead"] });

  const codexWrite = dispatchHook(
    codexAdapter,
    fixture("codex", "pre-tool-use-apply-patch", root),
    {},
  ).json as ReturnType<typeof claudeShell>;
  expect(codexWrite.hookSpecificOutput?.permissionDecision).toBe("deny");
  expect(codexWrite.hookSpecificOutput?.permissionDecisionReason).toContain(
    "Claude Code session claude-lead",
  );
  const codexShell = dispatchHook(
    codexAdapter,
    fixture("codex", "pre-tool-use-bash", root, { tool_input: { command: "git commit -m x" } }),
    {},
  ).json as ReturnType<typeof claudeShell>;
  expect(codexShell.hookSpecificOutput?.permissionDecision).toBe("deny");

  const cursorWrite = dispatchHook(cursorAdapter, fixture("cursor", "pre-tool-use", root));
  expect(cursorWrite.exitCode).toBe(2);
  expect(JSON.stringify(cursorWrite.json)).toContain("workit live-session guard");
  const cursorShell = dispatchHook(
    cursorAdapter,
    fixture("cursor", "before-shell-execution", root, { command: "git merge main" }),
  );
  expect(cursorShell.exitCode).toBe(2);

  const opencode = (action: string, resource: string) => {
    const event = { sessionID: "ses_1", action, resources: [resource], effect: "allow" } as {
      sessionID: string;
      action: string;
      resources: string[];
      effect: string;
      message?: string;
    };
    evaluateShellPermission(root, event);
    return event;
  };
  expect(opencode("edit", "src/a.ts")).toMatchObject({
    effect: "deny",
    message: expect.stringContaining("workit live-session guard"),
  });
  expect(opencode("shell", "git rebase main").effect).toBe("deny");
  expect(opencode("shell", "git status").effect).toBe("allow");

  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pi-1" },
  };
  expect(
    enforceToolPolicy(
      { toolName: "write", input: { path: "src/a.ts", content: "x" } } as never,
      ctx as never,
    ),
  ).toEqual({ block: true, reason: expect.stringContaining("workit live-session guard") });
  expect(
    enforceToolPolicy(
      { toolName: "bash", input: { command: "git commit -m x" } } as never,
      ctx as never,
    ),
  ).toEqual({ block: true, reason: expect.stringContaining("workit live-session guard") });
  expect(
    enforceToolPolicy({ toolName: "bash", input: { command: "git log" } } as never, ctx as never),
  ).toBeUndefined();
});

test("G a session owns the checkout, W it, its subagents or a fanout worker of its lead write, T never denied", () => {
  const root = repo();
  own(root, { host: "claude_code", session: "lead-7", leads: ["lead-7"] });
  for (const session of ["lead-7", "lead-7:agent-3", "lead-7-w-api"])
    expect(decisionOf(claudeShell(root, "git commit -m x", session)), session).not.toBe("deny");
  // A subagent whose tool events carry another id (Cursor, Codex, OpenCode
  // children) runs in its lead's host process: same pid, same owner.
  own(root, {
    host: "cursor",
    session: "conv-lead",
    leads: ["conv-lead"],
    pid: hostPid("hook-process"),
  });
  const sub = dispatchHook(
    cursorAdapter,
    fixture("cursor", "before-shell-execution", root, {
      conversation_id: "conv-sub",
      command: "git commit -m x",
    }),
  );
  expect(sub.exitCode).toBe(0);
});

test("G the owner's process is gone or its heartbeat expired, W another session writes, T allowed and it becomes the owner", () => {
  const root = repo();
  const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  own(root, { pid: dead });
  expect(decisionOf(claudeShell(root, "git commit -m x"))).not.toBe("deny");

  const other = repo();
  own(other, { heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  expect(decisionOf(claudeShell(other, "touch src/a.ts"))).not.toBe("deny");
  // The writer claimed it: another session from a different process is now refused.
  const opencode = { sessionID: "ses_9", action: "edit", resources: ["src/a.ts"], effect: "allow" };
  evaluateShellPermission(other, opencode);
  expect(opencode.effect).toBe("deny");
});

test("G two worktrees of one repository, W the owner of one is live, T a session in the other worktree may write", () => {
  const root = repo();
  const tree = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  roots.push(tree);
  expect(git(root, "worktree", "add", "-q", tree, "-b", "feature/y").status).toBe(0);
  own(root);
  expect(decisionOf(claudeShell(realpathSync(tree), "git commit -m x"))).not.toBe("deny");
  expect(decisionOf(claudeShell(root, "git commit -m x"))).toBe("deny");
});

test("G a workspace with liveSessionGuard false, W another session writes in an owned checkout, T allowed", () => {
  const root = repo();
  own(root);
  const config = mkdtempSync(path.join(os.tmpdir(), "wk-live-config-"));
  roots.push(config);
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "repo", glob: `${root}/**`, liveSessionGuard: false }] }),
  );
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = config;
  try {
    expect(decisionOf(claudeShell(root, "git commit -m x"))).not.toBe("deny");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
  }
});

test("G the marker store is unreadable or a marker is corrupt, W a session writes, T the guard fails open", () => {
  const root = repo();
  const file = own(root);
  writeFileSync(file, "{not json");
  expect(decisionOf(claudeShell(root, "git commit -m x"))).not.toBe("deny");

  // The state dir is a file: nothing can be read or written there.
  const blocked = path.join(state, "as-file");
  writeFileSync(blocked, "x");
  process.env.WORKFLOW_TOOLKIT_STATE = blocked;
  expect(decisionOf(claudeShell(repo(), "git commit -m x"))).not.toBe("deny");
});

test("G an owned checkout and a free one, W the command changes directory first, T the guard judges the directory each git command and write runs in", () => {
  const owned = repo();
  own(owned);
  const free = repo();
  const tree = path.join(path.dirname(owned), `${path.basename(owned)}-own-wt`);
  roots.push(tree);
  expect(git(owned, "worktree", "add", "-q", tree, "-b", "feature/own").status).toBe(0);
  const mine = realpathSync(tree);
  // The deny's own advice: move to your worktree and commit there.
  expect(decisionOf(claudeShell(owned, `cd ${mine} && git commit -m x`))).not.toBe("deny");
  expect(decisionOf(claudeShell(owned, `git -C ${mine} commit -m x`))).not.toBe("deny");
  for (const command of [
    `cd ${owned} && git commit -m x`,
    `(cd ${owned}; git reset --hard)`,
    `pushd ${owned} && git stash`,
    `git -C ${owned} commit -m x`,
    `cd ${owned} && echo x > src/a.ts`,
    `cd ${owned} && touch src/a.ts`,
  ])
    expect(decisionOf(claudeShell(free, command)), command).toBe("deny");
  // A directory that cannot be known is skipped, never denied.
  expect(decisionOf(claudeShell(free, "cd $SOMEWHERE && git commit -m x"))).not.toBe("deny");
});

test("G an owned checkout, W git or workit runs through a shell, a substitution, env -i, git.exe or npx, T still denied", () => {
  const root = repo();
  own(root);
  for (const command of [
    "bash -c 'git commit -m x'",
    'sh -c "git reset --hard"',
    "echo $(git stash)",
    "env -i git commit -m x",
    "git.exe commit -m x",
    "npx workit git commit -m x",
    "npx -y @brainervirus/workit-cli git branch feature/y",
    "bash -c 'workit git commit -m x'",
    "echo x > .git/hooks/pre-commit",
  ])
    expect(decisionOf(claudeShell(root, command)), command).toBe("deny");
});

test("G an owned checkout, W help, dry runs or workit git sync run, T allowed; git commit -n still commits", () => {
  const root = repo();
  own(root);
  for (const command of [
    "git commit --help",
    "git reset -h",
    "git clean -n",
    "git clean -nd",
    "git add --dry-run .",
    "workit git commit --help",
    "workit git sync",
  ])
    expect(decisionOf(claudeShell(root, command)), command).not.toBe("deny");
  expect(decisionOf(claudeShell(root, "git commit -n -m x"))).toBe("deny");
});

test("G an owned checkout, W the override is not the guarded command's own prefix, T denied; used as its prefix, T allowed and a ledger row records it", () => {
  const root = repo();
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  own(root);
  for (const command of [
    "echo WORKIT_LIVE_SESSION=override; git commit -m x",
    "WORKIT_LIVE_SESSION=override true && git commit -m x",
    "echo 'WORKIT_LIVE_SESSION=override git commit -m x'; git commit -m y",
  ])
    expect(decisionOf(claudeShell(root, command)), command).toBe("deny");
  expect(decisionOf(claudeShell(root, "WORKIT_LIVE_SESSION=override git commit -m x"))).not.toBe(
    "deny",
  );
  const ledger = readLedger(root);
  expect(ledger.ok && ledger.value.rows.some((row) => row.type === "live_session.override")).toBe(
    true,
  );
});

test("G an owned and a free checkout, W writes follow popd, a ( … ) group or an unknown-target edit, T each is judged in the directory it runs in", () => {
  const owned = repo();
  own(owned);
  const free = repo();
  for (const command of [
    `pushd ${owned} && popd && echo x > src/a.ts`,
    `(cd ${owned}) && echo x > src/a.ts`,
    `cd ${owned} && cd ${free} && patch -p1 < fix.diff`,
  ])
    expect(decisionOf(claudeShell(free, command)), command).not.toBe("deny");
  for (const command of [
    `pushd ${free} && popd && touch src/a.ts`,
    `(cd ${owned}; echo x > src/a.ts)`,
    `cd ${owned} && patch -p1 < fix.diff`,
  ])
    expect(
      decisionOf(claudeShell(command.startsWith("pushd") ? owned : free, command)),
      command,
    ).toBe("deny");
});
