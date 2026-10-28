import { expect, test } from "bun:test";
import { flushStreams, withFailureLine, type Io } from "@/packages/workit-cli/src/output";

// #533: a non-zero exit never reaches the caller as silence, and output still
// queued on a piped stream is handed over before the process exits.

const capture = () => {
  const out = { stdout: "", stderr: "" };
  const io: Io = {
    json: false,
    cwd: "/",
    env: {},
    stdout: (text) => void (out.stdout += text),
    stderr: (text) => void (out.stderr += text),
  };
  return { io, out };
};

test("given a verb that exits non-zero without writing, when it returns, then one stderr line names the command and exit", async () => {
  const { io, out } = capture();
  const code = await withFailureLine(io, "pr", async () => 3);
  expect(code).toBe(3);
  expect(out).toEqual({ stdout: "", stderr: "workit: error: pr failed (exit 3)\n" });
});

test("given a verb that explains its own failure, when it returns non-zero, then nothing is added", async () => {
  const { io, out } = capture();
  const code = await withFailureLine(io, "pr", async (inner) => {
    inner.stderr("workit: not_ready: PR #1 is WAIT_CI\n");
    return 3;
  });
  expect(code).toBe(3);
  expect(out.stderr).toBe("workit: not_ready: PR #1 is WAIT_CI\n");
});

test("given a verb that succeeds silently, when it returns zero, then nothing is added", async () => {
  const { io, out } = capture();
  expect(await withFailureLine(io, "ledger", async () => 0)).toBe(0);
  expect(out).toEqual({ stdout: "", stderr: "" });
});

test("given a stream whose write completes later, when flushing, then it resolves only after the write callback", async () => {
  const order: string[] = [];
  let finish: (() => void) | undefined;
  const slow = {
    write: (_chunk: string, done: () => void) => {
      finish = () => {
        order.push("drained");
        done();
      };
      return false;
    },
  };
  const flushed = flushStreams([slow], 5_000).then(() => order.push("flushed"));
  await Promise.resolve();
  expect(order).toEqual([]);
  finish?.();
  await flushed;
  expect(order).toEqual(["drained", "flushed"]);
});

test("given a stream that never drains, when flushing, then it gives up after the timeout", async () => {
  const stuck = { write: () => false };
  const started = Date.now();
  await flushStreams([stuck], 20);
  expect(Date.now() - started).toBeLessThan(2_000);
});
