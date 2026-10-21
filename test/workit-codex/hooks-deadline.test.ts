// Issue #309 on the Codex hook process (hooks/workit-hook.ts, the runtime entry):
// past its own deadline Codex gets its native PreToolUse shape naming the
// skip. WORKIT_HOOK_DEADLINE_MS=1 lets start-up spend the budget; no sleep.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const HOOK = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/workit-hook.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const dir = (make: () => string) => {
  const made = make();
  dirs.push(made);
  return made;
};

const runCodex = (payload: unknown, env: Record<string, string>) => {
  const cli: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete cli.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete cli.CODEX_ELECTRON_RESOURCES_PATH;
  const child = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: cli,
    timeout: 30_000,
  });
  return { status: child.status, json: JSON.parse(child.stdout), stderr: child.stderr };
};

const gitCommand = (cwd: string) =>
  fixture("codex", "pre-tool-use-bash", cwd, { tool_input: { command: "git status" } });

test("Given a Codex PreToolUse past the hook deadline, When Codex runs the hook, Then it gets PreToolUse output naming the skip and the skip is recorded", () => {
  const state = dir(() => mkdtempSync(path.join(tmpdir(), "workit-codex-deadline-state-")));
  const run = runCodex(gitCommand(dir(() => tempRoot("workit-codex-deadline-"))), {
    WORKIT_HOOK_DEADLINE_MS: "1",
    WORKFLOW_TOOLKIT_STATE: state,
  });
  expect(run.status).toBe(0);
  expect(run.json).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "workit context skipped: host under load",
    },
  });
  expect(JSON.parse(readFileSync(path.join(state, "hook-skips.jsonl"), "utf8"))).toMatchObject({
    host: "codex_cli",
    event: "shell.pre",
    outcome: "skip",
  });
});

test("Given a fast Codex PreToolUse, When Codex runs the hook, Then its output is the plain dispatch output", () => {
  const cwd = dir(() => tempRoot("workit-codex-deadline-"));
  const state = dir(() => mkdtempSync(path.join(tmpdir(), "workit-codex-deadline-state-")));
  const run = runCodex(gitCommand(cwd), { WORKFLOW_TOOLKIT_STATE: state });
  expect(run.status).toBe(0);
  expect(run.json).toEqual(dispatchHook(codexAdapter, gitCommand(cwd), {}).json);
  expect(run.stderr).not.toContain("host under load");
});
