// S14 hook-fixture suite: every Claude Code event is piped through the real
// launcher (`node bin/workit-hook.mjs`, as hooks/hooks.json registers it) in
// both runtimes: the local pin (monorepo sources with bun) and the installed
// layout (bundled dist/). Outputs must satisfy the hook output schema pinned
// from Claude Code 2.1.288 and never answer `allow`.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fixture,
  startTask,
  tempRoot,
  withProtectedMain,
} from "@/test/workit-core/hooks/hook-fixtures";
import { installedPlugin, outputProblem, PLUGIN_DIR, runHook } from "./plugin-helpers";

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
  expect(context).toContain("/workit:steer");
  expect(readFileSync(envFile, "utf8")).toBe(
    "export WORKIT_HOST=claude_code\nexport WORKIT_SESSION_ID='claude-session-1'\n",
  );
});

test("given an unchanged task, UserPromptSubmit re-injects context only after it changed or the session restarted", () => {
  const cwd = root();
  const data = mkdtempSync(path.join(tmpdir(), "workit-claude-data-"));
  roots.push(data);
  const env = { CLAUDE_PLUGIN_DATA: data };
  const turn = () =>
    runHook(PLUGIN_DIR, fixture("claude-code", "user-prompt-submit", cwd), env).json as Specific;
  // No task bound: nothing to inject.
  expect(turn()).toEqual({});
  startTask(cwd, { host: "claude_code", actor: "claude-session-1" }, "per-turn task");
  expect(turn().hookSpecificOutput?.additionalContext).toContain("per-turn task");
  expect(turn()).toEqual({});
  // A new session start (or compaction) clears the per-session cache.
  runHook(
    PLUGIN_DIR,
    fixture("claude-code", "session-start-compact", cwd, { source: "startup" }),
    env,
  );
  expect(turn().hookSpecificOutput?.additionalContext).toContain("per-turn task");
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
  const noBun = runHook(PLUGIN_DIR, fixture("claude-code", "pre-tool-use-bash", root()), {
    WORKIT_CLAUDE_RUNTIME: "source",
    WORKIT_BUN: path.join(tmpdir(), "definitely-not-bun"),
  });
  expect(noBun.status).toBe(0);
  expect(noBun.json).toEqual({});
  expect(noBun.stderr).toContain("bun is required for the local pin");
});
