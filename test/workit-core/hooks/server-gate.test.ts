// Issue #328, hook side: a raw dev server is routed to `workit run --bg -- <cmd>`
// on all five hosts the way heavy commands are routed to the lease (rewritten on
// Claude Code, OpenCode and Pi; denied with the exact call on Codex and Cursor;
// a chain denied with the split), and a background process's RSS notice reaches
// its owner session once, on that host's channel.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { observeShellBefore, observeShellResult } from "@/packages/workit-opencode/src/v2/shell";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { noticeFile } from "@/packages/workit-core/src/core/procs";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { rawInvocations, workitCheckTail } from "@/packages/workit-core/src/hooks/raw-git";
import { heavyGate } from "@/packages/workit-core/src/hooks/heavy-gate";
import { procNoticeFile, takeProcNotice } from "@/packages/workit-core/src/hooks/server-gate";

const KEYS = [
  "PATH",
  "HOME",
  "WORKIT_STATE_DIR",
  "WORKIT_CONFIG_DIR",
  "WORKIT_CONFIG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];
let home: string;
let state: string;

beforeAll(() => {
  const bin = mkdtempSync(path.join(tmpdir(), "workit-server-bin-"));
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  home = mkdtempSync(path.join(tmpdir(), "workit-server-home-"));
  state = mkdtempSync(path.join(tmpdir(), "workit-server-state-"));
  const config = mkdtempSync(path.join(tmpdir(), "workit-server-config-"));
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  dirs.push(bin, home, state, config);
  for (const key of [
    "CLAUDE_PROJECT_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "WORKIT_CONFIG",
  ])
    delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
    HOME: home,
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});
afterEach(() => {
  rmSync(path.join(state, "procs"), { recursive: true, force: true });
  rmSync(path.join(home, ".claude"), { recursive: true, force: true });
});
afterAll(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-server-gate-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "feature/x");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

type ClaudeOut =
  | {
      permissionDecision?: string;
      permissionDecisionReason?: string;
      updatedInput?: Record<string, unknown>;
      additionalContext?: string;
    }
  | undefined;

const claude = (root: string, command: string, session = "session-1") =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: session,
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "run it" },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput as ClaudeOut;

const codex = (root: string, command: string, session = "session-1") =>
  handleCodexHook({
    session_id: session,
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  }).hookSpecificOutput as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };

const cursor = (root: string, command: string, session = "session-1") =>
  handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: session,
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string; agent_message?: string };

const pi = (root: string, command: string) => {
  const input = { command };
  const result = enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  return { result, command: input.command };
};

const opencode = (root: string, command: string) => {
  const input = { command };
  observeShellBefore(root, { tool: "shell", sessionID: "ses_1", id: "call-1", input }, new Map());
  const event = {
    sessionID: "ses_1",
    action: "shell",
    resources: [input.command],
    effect: "allow",
    message: undefined as string | undefined,
  };
  evaluateShellPermission(root, event);
  return { command: input.command, effect: event.effect, message: event.message };
};

const ROUTED = "workit run --bg -- ng serve --port 4200";

test("Given `ng serve --port 4200` on Claude Code, When PreToolUse runs, Then updatedInput is the workit run --bg call with no permissionDecision", () => {
  const output = claude(repo(), "ng serve --port 4200");
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput).toEqual({ command: ROUTED, description: "run it" });
  expect(output?.additionalContext).toContain("workit stop <id>");
});

test("Given the same on Codex and Cursor, When the hook runs, Then it is denied naming that exact call", () => {
  const root = repo();
  const codexOutput = codex(root, "ng serve --port 4200");
  expect(codexOutput.permissionDecision).toBe("deny");
  expect(codexOutput.permissionDecisionReason).toContain(`owned by this session: ${ROUTED} (`);
  const cursorOutput = cursor(root, "ng serve --port 4200");
  expect(cursorOutput.permission).toBe("deny");
  expect(cursorOutput.agent_message).toContain(`owned by this session: ${ROUTED} (`);
});

test("Given the same on OpenCode and Pi, When the shell hook runs, Then the command is rewritten in place and nothing is denied", () => {
  const root = repo();
  expect(opencode(root, "ng serve --port 4200")).toEqual({
    command: ROUTED,
    effect: "allow",
    message: undefined,
  });
  expect(pi(root, "ng serve --port 4200")).toEqual({ result: undefined, command: ROUTED });
});

test("Given `npm run dev && echo x`, When each host's hook runs, Then it is denied with the split naming workit run --bg, as heavy chains are", () => {
  const command = "npm run dev && echo x";
  const split = "Start it alone, now: `workit run --bg -- npm run dev`";
  const claudeOutput = claude(repo(), command);
  expect(claudeOutput?.permissionDecision).toBe("deny");
  expect(claudeOutput?.updatedInput).toBeUndefined();
  const piRun = pi(repo(), command);
  expect(piRun).toMatchObject({ command, result: { block: true } });
  const oc = opencode(repo(), command);
  expect(oc).toMatchObject({ command, effect: "deny" });
  for (const reason of [
    claudeOutput?.permissionDecisionReason,
    codex(repo(), command).permissionDecisionReason,
    cursor(repo(), command).agent_message,
    piRun.result?.reason,
    oc.message,
  ])
    expect(reason).toContain(split);
});

test("Given `ng build` and `vite build`, When the hooks run, Then they go to the heavy-check lease, not to run --bg", () => {
  const root = repo();
  for (const command of ["ng build", "vite build"]) {
    expect(claude(root, command)?.updatedInput?.command).toBe(`workit check --heavy -- ${command}`);
    expect(codex(root, command).permissionDecisionReason).toContain(
      `Run exactly: workit check --heavy -- ${command}`,
    );
  }
});

test("Given `docker compose up --build`, When the gate plans it, Then the server route wins over the lease", () => {
  expect(claude(repo(), "docker compose up --build")?.updatedInput?.command).toBe(
    "workit run --bg -- docker compose up --build",
  );
});

test("Given the routed command, When any host's hook sees it, Then it passes unchanged (no double wrap)", () => {
  const root = repo();
  expect(claude(root, ROUTED)?.updatedInput).toBeUndefined();
  expect(codex(root, ROUTED).permissionDecision).toBeUndefined();
  expect(cursor(root, ROUTED).permission).not.toBe("deny");
  expect(pi(root, ROUTED)).toEqual({ result: undefined, command: ROUTED });
  expect(opencode(root, ROUTED).command).toBe(ROUTED);
});

// --- the RSS notice ----------------------------------------------------------

const writeNotice = (session: string, id = "p1abc") => {
  const file = noticeFile(process.env, session);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session,
      notices: [
        {
          id,
          cmd: "ng serve",
          cwd: "/w/app",
          rssBytes: 3 * 1048576 * 1024,
          ceilingBytes: 2 * 1048576 * 1024,
          restart: `workit run --bg --restart ${id}`,
          at: "2026-11-18T00:00:00.000Z",
        },
      ],
    }),
  );
  return file;
};

test("Given the hooks' notice path, Then it is the registry's (core/procs.ts noticeFile) and the Claude Code launcher's copy", () => {
  for (const session of ["session-1", "lead:agent", "a/b c", ""])
    expect(procNoticeFile(process.env, session)).toBe(noticeFile(process.env, session));
  const launcher = readFileSync(
    path.resolve(import.meta.dir, "../../../packages/workit-claude-code/bin/workit-hook.mjs"),
    "utf8",
  );
  const copy = /const procNoticeFile = \(env, session\) =>\s*path\.join\(([\s\S]*?)\);/u.exec(
    launcher,
  )?.[1];
  const source = readFileSync(
    path.resolve(import.meta.dir, "../../../packages/workit-core/src/hooks/server-gate.ts"),
    "utf8",
  );
  const original = /path\.join\(([\s\S]*?)\);\n/u.exec(
    source.slice(source.indexOf("export const procNoticeFile")),
  )?.[1];
  expect(copy?.replace("workitStateDir(env)", "stateDir(env)")).toBe(original);
});

const readdirNames = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

test("Given a notice file for the session, When it is taken twice, Then the first take names the process, its use and the restart, and the second gets nothing", () => {
  const file = writeNotice("session-1");
  const text = takeProcNotice("session-1");
  expect(text).toContain("p1abc `ng serve` in /w/app: 3072 MB, past the 2048 MB ceiling");
  expect(text).toContain("`workit run --bg --restart p1abc`");
  expect(text).toContain("`workit stop p1abc`");
  expect(existsSync(file)).toBe(false);
  expect(takeProcNotice("session-1")).toBeNull();
  expect(readdirNames(path.dirname(file))).toEqual([]);
  expect(takeProcNotice(null)).toBeNull();
});

test("Given a notice file for another session, When this session's hook runs, Then it is left for its owner", () => {
  const file = writeNotice("other-session");
  expect(claude(repo(), "ls")?.additionalContext ?? "").not.toContain("p1abc");
  expect(existsSync(file)).toBe(true);
});

test("Given a notice file for the session, When the next Claude Code, Codex or Cursor hook runs, Then it delivers the notice once", () => {
  const root = repo();
  writeNotice("session-1");
  expect(claude(root, "ls")?.additionalContext).toContain("workit run --bg --restart p1abc");
  expect(claude(root, "ls")?.additionalContext ?? "").not.toContain("p1abc");
  writeNotice("session-1", "p2codex");
  expect(codex(root, "ls").additionalContext).toContain("workit run --bg --restart p2codex");
  expect(codex(root, "ls").additionalContext ?? "").not.toContain("p2codex");
  writeNotice("session-1", "p3cursor");
  expect(cursor(root, "ls").agent_message).toContain("workit run --bg --restart p3cursor");
  expect(cursor(root, "ls").agent_message ?? "").not.toContain("p3cursor");
});

test("Given a denied call, When the notice is pending, Then it waits for a call that runs", () => {
  const root = repo();
  writeNotice("session-1");
  const denied = codex(root, "ng serve");
  expect(denied.permissionDecision).toBe("deny");
  expect(denied.permissionDecisionReason).not.toContain("p1abc");
  expect(codex(root, "ls").additionalContext).toContain("p1abc");
});

test("Given a notice file for an OpenCode session, When its next shell result comes back, Then the notice rides it once", () => {
  const root = repo();
  writeNotice("ses_1");
  const result = (text: string) => {
    const event = {
      tool: "shell",
      sessionID: "ses_1",
      id: "call-1",
      input: { command: "ls" },
      status: "completed" as const,
      result: { content: text },
    };
    observeShellResult(root, event);
    return event.result.content;
  };
  expect(result("a.txt")).toContain("workit run --bg --restart p1abc");
  expect(result("a.txt")).toBe("a.txt");
});

// --- the gates see through `workit run --bg -- <cmd>` (procs-registry verifier) ---

test("Given `workit run --bg [flags] -- <cmd>`, When the shell reader unwraps Workit wrappers, Then it yields the inner command and its --cwd", () => {
  expect(workitCheckTail(["workit", "run", "--bg", "--port", "4200", "--", "git", "push"])).toEqual(
    { argv: ["git", "push"], cwd: null },
  );
  expect(workitCheckTail(["workit", "--cwd", "/w", "run", "--bg", "--", "ng", "serve"])).toEqual({
    argv: ["ng", "serve"],
    cwd: "/w",
  });
  expect(workitCheckTail(["workit", "run", "--bg", "--restart", "p1"])).toBeNull();
  expect(rawInvocations("workit run --bg --name x -- git push origin main")).toMatchObject([
    { tool: "git", args: ["push", "origin", "main"] },
  ]);
});

test("Given a gate bypass after `workit run --bg --`, When each host's hook runs, Then raw-git denies it like the raw form", () => {
  const root = repo();
  const command = "workit run --bg -- gh pr merge 1";
  expect(claude(root, command)?.permissionDecision).toBe("deny");
  expect(codex(root, command).permissionDecision).toBe("deny");
  expect(cursor(root, command).permission).toBe("deny");
  expect(pi(root, command).result?.block).toBe(true);
  expect(opencode(root, command).effect).toBe("deny");
  const branch = claude(root, "workit run --bg -- git checkout -b x");
  expect(branch?.permissionDecisionReason).toContain("branch_policy_denied");
});

test("Given an open product choice, When a write runs after `workit run --bg --`, Then the before-write gate denies it like raw touch", () => {
  const root = repo();
  mkdirSync(path.join(root, "src"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.policy({ action: "assess", productChoiceOpen: "yes" }).ok).toBe(true);
  for (const command of [
    "workit run --bg -- touch src/a.ts",
    "workit run --bg -- bash -c 'echo x > src/a.ts'",
  ]) {
    expect(claude(root, command)?.permissionDecisionReason, command).toContain("before-write gate");
    expect(cursor(root, command).permission, command).toBe("deny");
    expect(pi(root, command).result?.block, command).toBe(true);
    expect(opencode(root, command).effect, command).toBe("deny");
  }
});

test("Given `workit run --bg -- <heavy or server cmd>`, When the heavy gate plans it, Then it is left alone (the registry runs it, never a second wrap)", () => {
  const root = repo();
  for (const command of ["workit run --bg -- npm test", "workit run --bg -- npm run dev"])
    for (const host of ["claude_code", "codex_cli", "cursor", "opencode", "pi"] as const)
      expect(heavyGate(root, command, { host }).kind, `${host}: ${command}`).toBe("none");
});
