// `gh … | workit pr edit --body-file -` (lead, 2026-11-18): the released CLI
// runs on Node, whose `process.stdin` getter (the TTY checks) leaves a pipe's
// fd 0 non-blocking, so a writer that has not written yet made the read fail
// with EAGAIN. readAllStdin waits for the writer instead.
//
// CI run 45809121582 (2026-11-26): a read that got a first chunk and then hit
// EAGAIN before the writer closed lost that chunk (`readFileSync(0)` threw it
// away), so the body came back empty or truncated.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-stdin-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const source = path.resolve(import.meta.dir, "../../packages/workit-cli/src/verbs/forge-common.ts");

async function buildReader(name: string, body: string): Promise<string> {
  const entry = path.join(scratch, `${name}.ts`);
  writeFileSync(entry, `import { readAllStdin } from ${JSON.stringify(source)};\n${body}`);
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: path.join(scratch, name),
    target: "node",
    format: "esm",
  });
  expect(built.success).toBe(true);
  return built.outputs[0].path;
}

test("Given a writer that sends half, waits for the reader, then sends the rest, When the body is read on Node, Then no chunk is lost", async () => {
  const half = path.join(scratch, "half-written");
  const reading = path.join(scratch, "reading");
  // The reader starts only once the first half sits in the pipe, and the
  // writer holds the rest until the reader is inside readAllStdin, so the
  // first read gets the half and the next one meets an open, empty pipe.
  const script = await buildReader(
    "split",
    [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `void process.stdin.isTTY;`,
      `const pause = new Int32Array(new SharedArrayBuffer(4));`,
      `while (!existsSync(${JSON.stringify(half)})) Atomics.wait(pause, 0, 0, 10);`,
      `writeFileSync(${JSON.stringify(reading)}, "");`,
      `process.stdout.write(JSON.stringify(readAllStdin()));`,
      ``,
    ].join("\n"),
  );
  const writer = [
    `printf 'first half, '`,
    `: > ${JSON.stringify(half)}`,
    `while [ ! -e ${JSON.stringify(reading)} ]; do sleep 0.01; done`,
    `sleep 0.2`,
    `printf 'second half\\n'`,
  ].join("; ");
  const run = spawnSync("sh", ["-c", `(${writer}) | node ${JSON.stringify(script)}`], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(run.stderr).toBe("");
  expect(JSON.parse(run.stdout)).toBe("first half, second half\n");
});

test("Given a pipe whose writer is late and stdin already touched, When the body is read on Node, Then it is the piped text", async () => {
  const script = await buildReader(
    "late",
    `void process.stdin.isTTY;\nprocess.stdout.write(JSON.stringify(readAllStdin()));\n`,
  );
  const run = spawnSync(
    "sh",
    ["-c", `(sleep 0.3; printf 'body from gh\\n') | node ${JSON.stringify(script)}`],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(run.stderr).toBe("");
  expect(JSON.parse(run.stdout)).toBe("body from gh\n");
});
