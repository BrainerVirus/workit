// Issue #309 on the Cursor hook process (hooks/workit-hook.ts): past its own
// deadline Cursor still gets its required permission answer, with the skip
// as agent_message. WORKIT_HOOK_DEADLINE_MS=1 lets start-up spend the budget.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const HOOK = path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks/workit-hook.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const dir = (make: () => string) => {
  const made = make();
  dirs.push(made);
  return made;
};

const runCursor = (payload: unknown, env: Record<string, string>) => {
  const child = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: child.status, json: JSON.parse(child.stdout), stderr: child.stderr };
};

test("Given a Cursor beforeShellExecution past the hook deadline, When Cursor runs the hook, Then it gets allow with the skip as agent_message and the skip is recorded", () => {
  const state = dir(() => mkdtempSync(path.join(tmpdir(), "workit-cursor-deadline-state-")));
  const cwd = dir(() => tempRoot("workit-cursor-deadline-"));
  const run = runCursor(fixture("cursor", "before-shell-execution", cwd), {
    WORKIT_HOOK_DEADLINE_MS: "1",
    WORKFLOW_TOOLKIT_STATE: state,
  });
  expect(run.status).toBe(0);
  expect(run.json).toEqual({
    permission: "allow",
    agent_message: "workit context skipped: host under load",
  });
  expect(JSON.parse(readFileSync(path.join(state, "hook-skips.jsonl"), "utf8"))).toMatchObject({
    host: "cursor",
    event: "shell.pre",
    outcome: "skip",
  });
});

test("Given a fast Cursor beforeShellExecution, When Cursor runs the hook, Then the hook answers without a skip", () => {
  const cwd = dir(() => tempRoot("workit-cursor-deadline-"));
  const state = dir(() => mkdtempSync(path.join(tmpdir(), "workit-cursor-deadline-state-")));
  const run = runCursor(
    fixture("cursor", "before-shell-execution", cwd, { command: "git status" }),
    { WORKFLOW_TOOLKIT_STATE: state },
  );
  expect(run.status).toBe(0);
  expect(run.json.agent_message ?? "").not.toContain("host under load");
  expect(run.stderr).not.toContain("host under load");
});
