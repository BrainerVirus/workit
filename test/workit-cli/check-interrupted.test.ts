import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHandoff, readLedger } from "@/packages/workit-core/src/ledger";
import {
  checkEvidence,
  localCheckRows,
} from "@/packages/workit-core/src/core/policy/check-evidence";

// Retro 2026-11-17 C10: a host's tool timeout SIGTERMs a long `workit check`;
// the run was recorded `failed, exit 143` and agents reran it in the
// foreground. A run its caller stopped is `interrupted`: absent evidence.

setDefaultTimeout(60_000);

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const repo = (checks: Record<string, string[]>) => {
  const root = temp("wk-check-interrupted-");
  git(root, "init", "-q", "-b", "feature/x");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(path.join(root, ".workit", "checks.json"), JSON.stringify({ checks }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-interrupted",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: temp("wk-check-interrupted-state-"),
    WORKIT_CONFIG_DIR: temp("wk-check-interrupted-config-"),
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

const cli = (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(BUN, [MAIN, ...argv], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done, stdout: () => stdout };
};

const until = async (condition: () => boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const lastCheckRow = (root: string) => {
  const read = readLedger(root);
  if (!read.ok) throw new Error(read.error);
  return read.value.rows.findLast((row) => row.type === "check");
};

/** Prints "ready" once it runs, then sleeps far past the test. */
const SLEEPER = [BUN, "-e", "console.log('ready'); setTimeout(() => {}, 30000)"];

test.skipIf(process.platform === "win32")(
  "G a configured check that sleeps, W the caller sends workit SIGTERM, T the ledger row is interrupted with the signal, not failed, and stderr says to run it in the background",
  async () => {
    const { root, env } = repo({ sleepy: SLEEPER });
    const running = cli(root, ["check", "sleepy", "--full"], env);
    await until(() => running.stdout().includes("ready"));
    running.child.kill("SIGTERM");
    const result = await running.done;

    expect(result.code, result.stderr).toBe(143);
    expect(result.stderr).toContain(
      "interrupted by SIGTERM (the caller stopped it, likely a tool timeout): run long checks in the background",
    );
    expect(result.stderr).not.toContain("still unsatisfied");
    expect(lastCheckRow(root)).toMatchObject({
      type: "check",
      name: "sleepy",
      configured: true,
      result: "interrupted",
      signal: "SIGTERM",
    });
  },
);

/** Passes at once while .git/fast exists, else prints "ready" and sleeps. */
const SWITCHED = [
  BUN,
  "-e",
  "if (require('fs').existsSync('.git/fast')) process.exit(0); console.log('ready'); setTimeout(() => {}, 30000)",
];

test.skipIf(process.platform === "win32")(
  "G a passed run then a SIGTERM-interrupted one, W the handoff lists check results, T it shows the passed run marked with the later interruption",
  async () => {
    const { root, env } = repo({ switched: SWITCHED });
    writeFileSync(path.join(root, ".git", "fast"), "");
    expect((await cli(root, ["check", "switched"], env).done).code).toBe(0);
    rmSync(path.join(root, ".git", "fast"));
    const running = cli(root, ["check", "switched", "--full"], env);
    await until(() => running.stdout().includes("ready"));
    running.child.kill("SIGTERM");
    expect((await running.done).code).toBe(143);

    const brief = buildHandoff(root);
    if (!brief.ok) throw new Error(brief.error);
    expect(brief.value.checks).toEqual([
      expect.objectContaining({ name: "switched", result: "passed", interruptedSince: "SIGTERM" }),
    ]);
  },
);

test("G a command that exits 143 on its own, W no signal reached workit, T the row stays failed", async () => {
  const { root, env } = repo({ own: [BUN, "-e", "process.exit(143)"] });
  const result = await cli(root, ["check", "own"], env).done;

  expect(result.code).toBe(143);
  expect(result.stderr).not.toContain("interrupted by");
  const row = lastCheckRow(root);
  expect(row).toMatchObject({ result: "failed", exitCode: 143 });
  expect(row).not.toHaveProperty("signal");
});

const HEAD = "a".repeat(40);
const row = (result: string) => ({
  type: "check",
  observer: "workit_cli",
  name: "test",
  head: HEAD,
  dirty: false,
  configured: true,
  result,
});
const evidenceFor = (results: string[]) =>
  checkEvidence({
    lane: "full",
    head: HEAD,
    configured: ["test"],
    local: localCheckRows(results.map(row)),
    ci: [],
  }).needed[0];

test("G only an interrupted run on the head, W a gate reads freshness, T the check is missing, not failing or fresh", () => {
  expect(evidenceFor(["interrupted"])).toMatchObject({ name: "test", status: "missing" });
});

test("G a passed run then an interrupted one on the head, W a gate reads freshness, T the passed run still stands", () => {
  expect(evidenceFor(["passed", "interrupted"])).toMatchObject({ status: "fresh", via: "local" });
});

test("G a failed run then an interrupted one on the head, W a gate reads freshness, T the failed run still stands", () => {
  expect(evidenceFor(["failed", "interrupted"])).toMatchObject({ status: "failing" });
});
