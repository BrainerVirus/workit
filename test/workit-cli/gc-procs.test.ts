// #328: `workit gc --procs` refuses arguments it does not know (decider ruling
// 8: a caller built for another CLI never falls through to the task-store gc).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = async (argv: string[]) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-gcp-"));
  dirs.push(cwd);
  let stdout = "";
  const code = await main([...argv, "--json"], {
    cwd,
    env: { ...process.env, WORKIT_STATE_DIR: path.join(cwd, "state") },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  return { code, envelope: JSON.parse(stdout) };
};

test.each([
  [["gc", "--procs", "--apply", "--quiet"], "--quiet"],
  [["gc", "--procs", "--prune-recovery"], "--prune-recovery"],
  [["gc", "--procs", "--worktrees"], "--procs"],
])("Given `workit %p`, Then it exits 2 naming %s and stops nothing", async (argv, named) => {
  const { code, envelope } = await run(argv);
  expect(code).toBe(2);
  // The router refuses a flag no gc form names; gc itself refuses one another form takes.
  expect(envelope.error).toMatch(new RegExp(`^unknown (?:argument|option) ${named}\\b`, "u"));
});

test("Given no registered processes, When `workit gc --procs` runs, Then it reports no orphans", async () => {
  const { code, envelope } = await run(["gc", "--procs"]);
  expect(code).toBe(0);
  expect(envelope.data).toMatchObject({ orphans: [], stopped: [], apply: false });
});
