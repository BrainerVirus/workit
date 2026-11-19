// `gh … | workit pr edit --body-file -` (lead, 2026-11-18): the released CLI
// runs on Node, whose `process.stdin` getter (the TTY checks) leaves a pipe's
// fd 0 non-blocking, so a writer that has not written yet made the read fail
// with EAGAIN. readAllStdin waits for the writer instead.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-stdin-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const source = path.resolve(import.meta.dir, "../../packages/workit-cli/src/verbs/forge-common.ts");

test("Given a pipe whose writer is late and stdin already touched, When the body is read on Node, Then it is the piped text", async () => {
  const entry = path.join(scratch, "entry.ts");
  writeFileSync(
    entry,
    `import { readAllStdin } from ${JSON.stringify(source)};\nvoid process.stdin.isTTY;\nprocess.stdout.write(JSON.stringify(readAllStdin()));\n`,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: path.join(scratch, "out"),
    target: "node",
    format: "esm",
  });
  expect(built.success).toBe(true);
  const script = built.outputs[0].path;
  const run = spawnSync(
    "sh",
    ["-c", `(sleep 0.3; printf 'body from gh\\n') | node ${JSON.stringify(script)}`],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(run.stderr).toBe("");
  expect(JSON.parse(run.stdout)).toBe("body from gh\n");
});
