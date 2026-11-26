import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  flushStreams,
  trackWrites,
  withFailureLine,
  type Io,
} from "@/packages/workit-cli/src/output";
import { stripsWorkitKey } from "@/test/shared/helpers/env";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

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

/** A stream whose empty write calls back at once while an earlier write is still queued (Bun on a pipe). */
const bunLikePipe = () => {
  const pending: Array<() => void> = [];
  const listeners: Array<() => void> = [];
  const stream = {
    write: (chunk: string, done: () => void) => {
      if (chunk === "") done();
      else pending.push(done);
      return false;
    },
    on: (_event: "error" | "close", listener: () => void) => void listeners.push(listener),
  };
  return { stream, drain: () => pending.splice(0).forEach((done) => done()), listeners };
};

test("given a tracked stream with a large write still queued, when flushing, then it waits for that write although an empty write calls back at once", async () => {
  const pipe = bunLikePipe();
  trackWrites([pipe.stream]);
  const order: string[] = [];
  pipe.stream.write("x".repeat(200_000), () => order.push("written"));
  const flushed = flushStreams([pipe.stream], 5_000).then(() => order.push("flushed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual([]);
  pipe.drain();
  await flushed;
  expect(order).toEqual(["written", "flushed"]);
});

test("given a tracked stream whose reader is gone, when flushing, then the error or close ends the wait", async () => {
  const pipe = bunLikePipe();
  trackWrites([pipe.stream]);
  pipe.stream.write("never taken", () => {});
  const flushed = flushStreams([pipe.stream], 5_000);
  for (const listener of pipe.listeners) listener();
  const started = Date.now();
  await flushed;
  expect(Date.now() - started).toBeLessThan(1_000);
});

const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-output-pipe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("given --json output larger than a 64 KiB pipe, when the CLI runs with stdout as a pipe read late, then the reader gets all of it and it parses", () => {
  const repo = path.join(scratch, "repo");
  mkdirSync(repo);
  const entries = Array.from({ length: 1500 }, (_, i) => `- Entry ${i}: ${"z".repeat(80)}`);
  writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${entries.join("\n")}\n`,
  );
  const home = path.join(scratch, ".home");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!stripsWorkitKey(key) && !key.startsWith("XDG_")) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".state"),
    XDG_DATA_HOME: path.join(home, ".data"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    WORKIT_CONFIG: path.join(home, ".config", "workit"),
    GIT_CONFIG_GLOBAL: path.join(scratch, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  writeFileSync(env.GIT_CONFIG_GLOBAL as string, "");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  // A real pipe (`| { sleep; cat; }`, as in `workit … --json | jq`) whose
  // reader starts late: the CLI fills its 64 KiB and must wait for the reader
  // instead of exiting with the rest still queued.
  const run = spawnSync(
    "sh",
    [
      "-c",
      '{ "$0" "$@"; echo "exit=$?" >&2; } | { sleep 0.3; cat; }',
      process.execPath,
      path.join(REPO_ROOT, "packages/workit-cli/src/main.ts"),
      "changelog",
      "roll",
      "--preview",
      "--tag-prefix",
      "v",
      "--json",
    ],
    { cwd: repo, encoding: "utf8", env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(run.stderr).toContain("exit=0");
  const stdout = run.stdout;
  expect(stdout.length).toBeGreaterThan(128 * 1024);
  const parsed = JSON.parse(stdout) as { ok: boolean; data: { after: string } };
  expect(parsed.ok).toBe(true);
  expect(parsed.data.after).toContain("- Entry 1499: ");
});
