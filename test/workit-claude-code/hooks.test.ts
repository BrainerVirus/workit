// S14 hook-fixture suite: every Claude Code event is piped through the real
// launcher (`node bin/workit-hook.mjs`, as hooks/hooks.json registers it) in
// both runtimes: the local pin (monorepo sources with bun) and the installed
// layout (bundled dist/). Outputs must satisfy the hook output schema pinned
// from Claude Code 2.1.288 and never answer `allow`.
import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fixture,
  startTask,
  tempRoot,
  withProtectedMain,
} from "@/test/workit-core/hooks/hook-fixtures";
import { installedPlugin, outputProblem, PLUGIN_DIR, runHook } from "./plugin-helpers";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { recordDecision } from "@/packages/workit-core/src/ledger";
import { resolveStore } from "@/packages/workit-core/src/store/paths";

/** Moves `taskId` forward, which changes its compact context. */
const progress = (root: string, taskId: string, nextAction: string) => {
  const done = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-02T00:00:00Z",
  }).task({
    schemaVersion: 1,
    action: "progress",
    taskId,
    progress: { summary: "progress", nextAction, blockers: [] },
  });
  if (!done.ok) throw new Error(done.error);
};

const FIXTURES = path.resolve(import.meta.dir, "../fixtures/hooks/claude-code");
const NAMES = readdirSync(FIXTURES).map((name) => name.replace(/\.json$/, ""));
const RUNTIMES = [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const;

const roots: string[] = [];
const root = () => {
  const dir = tempRoot("workit-claude-hooks-");
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

for (const [label, plugin] of RUNTIMES) {
  test(`[${label}] given the hook fixture suite, every event yields schema-valid output and never allow`, async () => {
    await withProtectedMain(() => {
      const cwd = root();
      startTask(cwd, { host: "claude_code", actor: "claude-session-1" }, "fixture task");
      for (const name of NAMES) {
        const payload = fixture("claude-code", name, cwd);
        const run = runHook(plugin(), payload);
        expect(run.status, `${name}: ${run.stderr}`).toBe(0);
        expect(outputProblem(String(payload.hook_event_name), run.json), name).toBeNull();
        expect(run.stdout, name).not.toContain('"allow"');
      }
    });
  }, 60_000);

  test(`[${label}] in a Workit workspace, raw gh pr merge is denied, a raw commit nudged and recorded, all schema-valid`, async () => {
    await withProtectedMain(() => {
      const cwd = root();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
      git("init", "-q", "-b", "feature/x");
      mkdirSync(path.join(cwd, ".git", "workit"), { recursive: true });
      const bash = (event: string, command: string) => {
        const payload = {
          ...fixture("claude-code", "pre-tool-use-bash", cwd),
          hook_event_name: event,
          tool_input: { command },
        };
        const run = runHook(plugin(), payload);
        expect(outputProblem(event, run.json), command).toBeNull();
        return (run.json as Specific).hookSpecificOutput;
      };
      // gh never reached the runtime before (launcher fast path): now it does.
      expect(bash("PreToolUse", "gh pr merge 3 --squash")?.permissionDecision).toBe("deny");
      expect(bash("PreToolUse", "git commit -m 'feat: x'")?.additionalContext).toContain(
        "workit git commit",
      );
      writeFileSync(path.join(cwd, "x.txt"), "x\n");
      git("add", "x.txt");
      git("commit", "-q", "-m", "feat: x");
      expect(bash("PostToolUse", "ls -la")).toBeUndefined();
      expect(bash("PostToolUse", "git commit -m 'feat: x'")).toBeUndefined();
      const ledger = readFileSync(
        path.join(cwd, ".git", "workit", "ledger", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"commit.recorded"');
      expect(ledger).toContain('"observer":"host_hook"');
      // A workit delivery verb passes the launcher fast path and names
      // workit-ship until the Skill tool loads it; a prompt names its skill.
      expect(bash("PreToolUse", "workit pr create --fill")?.additionalContext).toContain(
        "`workit:ship`",
      );
      const hook = (payload: Record<string, unknown>) =>
        runHook(plugin(), { ...fixture("claude-code", "pre-tool-use-bash", cwd), ...payload });
      const prompt = hook({ hook_event_name: "UserPromptSubmit", prompt: "brainstorm the API" });
      expect(outputProblem("UserPromptSubmit", prompt.json)).toBeNull();
      expect((prompt.json as Specific).hookSpecificOutput?.additionalContext).toContain(
        "`workit:shape`",
      );
      const skill = hook({ tool_name: "Skill", tool_input: { skill: "workit:ship" } });
      expect(skill.json).toEqual({});
      expect(bash("PreToolUse", "workit pr create --fill")).toBeUndefined();
    });
  }, 60_000);

  test(`[${label}] given a protected main, a Bash \`git checkout -b main\` is denied with protected_ref`, async () => {
    await withProtectedMain(() => {
      const run = runHook(plugin(), fixture("claude-code", "pre-tool-use-bash", root()));
      const output = (run.json as Specific).hookSpecificOutput;
      expect(output?.hookEventName).toBe("PreToolUse");
      expect(output?.permissionDecision).toBe("deny");
      expect(output?.permissionDecisionReason).toContain("protected_ref");
      // A compliant branch passes silently: the user's own permission rules decide.
      const allowed = runHook(
        plugin(),
        fixture("claude-code", "pre-tool-use-bash", root(), {
          tool_input: { command: "git switch -c feature/ok" },
        }),
      );
      expect(allowed.json).toEqual({});
    });
  }, 30_000);

  test(`[${label}] given an open product choice, code writes are denied with the unblock and plain shell commands take the fast path`, () => {
    const cwd = root();
    const core = new WorkitCore(new TaskStore(cwd), {
      root: cwd,
      caller: { host: "claude_code", actor: "claude-session-1" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    expect(core.policy({ action: "assess", productChoiceOpen: true }).ok).toBe(true);
    const write = runHook(plugin(), fixture("claude-code", "pre-tool-use-write", cwd));
    const output = (write.json as Specific).hookSpecificOutput;
    expect(output?.permissionDecision).toBe("deny");
    expect(output?.permissionDecisionReason).toContain("workit ledger decision");
    const shell = (command: string) =>
      runHook(
        plugin(),
        fixture("claude-code", "pre-tool-use-bash", cwd, { tool_input: { command } }),
      ).json as Specific;
    expect(shell("echo x > src/a.ts").hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(shell("ls -la")).toEqual({});
    expect(
      recordDecision(
        { cwd, actor: { host: "claude_code", session: "claude-session-1", agentId: null } },
        { what: "option A", why: "the user chose A" },
      ).ok,
    ).toBe(true);
    expect(runHook(plugin(), fixture("claude-code", "pre-tool-use-write", cwd)).json).toEqual({});
  }, 30_000);
}

test("given SessionStart source compact, context is restored with the Claude addendum and the session env is exported", () => {
  const cwd = root();
  const data = mkdtempSync(path.join(tmpdir(), "workit-claude-data-"));
  roots.push(data);
  const envFile = path.join(data, "session-env.sh");
  startTask(cwd, { host: "claude_code", actor: "claude-session-1" }, "restore after compaction");
  const run = runHook(PLUGIN_DIR, fixture("claude-code", "session-start-compact", cwd), {
    CLAUDE_ENV_FILE: envFile,
  });
  const context = (run.json as Specific).hookSpecificOutput?.additionalContext ?? "";
  expect(context).toContain("<workit-contract>");
  expect(context).toContain("<workit-task-context>");
  expect(context).toContain("restore after compaction");
  expect(context).toContain("/workit:shape");
  expect(readFileSync(envFile, "utf8")).toBe(
    "export WORKIT_HOST=claude_code\nexport WORKIT_SESSION_ID='claude-session-1'\n",
  );
});

test("given an unchanged task, UserPromptSubmit re-injects context only when it changed, never right after SessionStart", () => {
  const cwd = root();
  const turn = () =>
    runHook(PLUGIN_DIR, fixture("claude-code", "user-prompt-submit", cwd)).json as Specific;
  const start = (source: string) =>
    runHook(PLUGIN_DIR, fixture("claude-code", "session-start-compact", cwd, { source }))
      .json as Specific;
  // No task bound: nothing to inject.
  expect(turn()).toEqual({});
  const id = startTask(cwd, { host: "claude_code", actor: "claude-session-1" }, "per-turn task");
  // The task appeared after the session started: the next turn carries it once.
  expect(turn().hookSpecificOutput?.additionalContext).toContain("per-turn task");
  expect(turn()).toEqual({});
  // The task context changed: the next turn carries it, once.
  progress(cwd, id, "write the parser test");
  expect(turn().hookSpecificOutput?.additionalContext).toContain("write the parser test");
  expect(turn()).toEqual({});
  // SessionStart (startup or compaction restore) injects the context itself
  // and reseeds the digest: the context changed since the last turn, yet the
  // first turn after it does not resend it.
  for (const source of ["startup", "compact"]) {
    progress(cwd, id, `next after ${source}`);
    expect(start(source).hookSpecificOutput?.additionalContext).toContain(`next after ${source}`);
    expect(turn(), source).toEqual({});
  }
  // Digests of sessions untouched for a week are pruned on the next start.
  const location = resolveStore(cwd);
  if (location instanceof Error) throw location;
  const hooks = path.join(location.dir, "hooks");
  const stale = path.join(hooks, "turn-old-session.json");
  writeFileSync(stale, '{"digest":"x"}\n');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, eightDaysAgo, eightDaysAgo);
  start("startup");
  expect(existsSync(stale)).toBe(false);
  expect(readdirSync(hooks).filter((name) => name.startsWith("turn-"))).toHaveLength(1);
});

test("a protected-branch deny is structured JSON on stdout with exit 0 and nothing on stderr", async () => {
  await withProtectedMain(() => {
    for (const plugin of [PLUGIN_DIR, installedPlugin()]) {
      const run = runHook(plugin, fixture("claude-code", "pre-tool-use-bash", root()));
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout.trim().split("\n")).toHaveLength(1);
      expect(outputProblem("PreToolUse", run.json)).toBeNull();
      expect(run.json).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("branch_policy_denied"),
        },
      });
    }
  });
}, 30_000);

test("SubagentStart gives the worktree implementer write guidance and keeps other agents read-only", () => {
  const cwd = root();
  const context = (agent_type: string) =>
    (
      runHook(PLUGIN_DIR, fixture("claude-code", "subagent-start", cwd, { agent_type }))
        .json as Specific
    ).hookSpecificOutput?.additionalContext ?? "";
  for (const agent of ["workit:implementer"]) {
    const text = context(agent);
    expect(text, agent).toContain("working in its own git worktree");
    expect(text, agent).toContain("policy-compliant branch");
    expect(text, agent).not.toContain("read-only");
    // Claude Code's worktree isolation refuses a wrapper naming git: plain git
    // up front, workit for the non-git verbs, never a renamed dodge.
    expect(text, agent).toContain("Run git as plain, separate commands inside your worktree");
    expect(text, agent).toContain("never `workit git …`");
    expect(text, agent).toContain("how-claude-code-enforces-isolation");
    expect(text, agent).toContain("`workit check`, `workit ledger`, `workit pr`");
    expect(text, agent).toContain("Never dodge that check by renaming");
    expect(text, agent).not.toContain("workit git branch");
  }
  // Any agent running in a .claude/worktrees/ checkout gets the same git rule first.
  const worktree = path.join(cwd, ".claude", "worktrees", "agent-1");
  mkdirSync(worktree, { recursive: true });
  const explorer = (
    runHook(
      PLUGIN_DIR,
      fixture("claude-code", "subagent-start", worktree, { agent_type: "general-purpose" }),
    ).json as Specific
  ).hookSpecificOutput?.additionalContext;
  expect(explorer?.startsWith("Run git as plain, separate commands")).toBe(true);
  expect(context("Explore")).not.toContain("Run git as plain");
  // Only the Workit plugin's own implementer: a bare or another plugin's
  // `implementer` cannot be told apart from an unrelated agent.
  for (const agent of [
    "workit:reviewer",
    "workit:verifier",
    "Explore",
    "implementer",
    "other:implementer",
  ])
    expect(context(agent), agent).toContain("read-only/agent-guided");
  // The plugin's judges get their own session for verdicts (author != verifier).
  for (const agent of ["workit:reviewer", "workit:verifier"])
    expect(context(agent), agent).toContain("--session claude-session-1:agent-1");
  expect(context("Explore")).not.toContain("--session");
});

test("a malformed payload or a missing bundle fails open with an empty decision and a diagnostic", () => {
  const bad = runHook(PLUGIN_DIR, "{not json");
  expect(bad.status).toBe(0);
  expect(bad.json).toEqual({});
  expect(bad.stderr).toContain("invalid JSON hook input");
  // An installed layout whose dist/ is missing (a broken package).
  const broken = path.join(mkdtempSync(path.join(tmpdir(), "workit-claude-broken-")), "workit");
  roots.push(path.dirname(broken));
  cpSync(path.join(PLUGIN_DIR, "bin"), path.join(broken, "bin"), { recursive: true });
  const missing = runHook(broken, fixture("claude-code", "pre-tool-use-bash", root()));
  expect(missing.status).toBe(0);
  expect(missing.json).toEqual({});
  expect(missing.stderr).toContain("is missing");
  // A dist/ that cannot be imported (corrupt or truncated bundle).
  mkdirSync(path.join(broken, "dist"));
  writeFileSync(path.join(broken, "dist", "workit-hook.js"), "export const = ;\n");
  const corrupt = runHook(broken, fixture("claude-code", "pre-tool-use-bash", root()));
  expect(corrupt.status).toBe(0);
  expect(corrupt.json).toEqual({});
  expect(corrupt.stderr).toContain("Claude Code hook unavailable: cannot load");
  const noBun = runHook(PLUGIN_DIR, fixture("claude-code", "pre-tool-use-bash", root()), {
    WORKIT_CLAUDE_RUNTIME: "source",
    WORKIT_BUN: path.join(tmpdir(), "definitely-not-bun"),
  });
  expect(noBun.status).toBe(0);
  expect(noBun.json).toEqual({});
  expect(noBun.stderr).toContain("bun is required for the local pin");
});
