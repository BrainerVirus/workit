import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A reader that closes early (`workit … | head -1`) must end the output
// quietly: the released CLI runs on Node, where an EPIPE on stdout was an
// uncaught `write EPIPE` (logged as uncaught_failure, exit 1) or a raw stack
// trace. The test builds the CLI the way scripts/build.ts does and runs it
// under Node with stdout on a pipe.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-epipe-"));
const cli = path.join(scratch, "index.js");
const repo = path.join(scratch, "repo");
const home = path.join(scratch, "home");

const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  NO_COLOR: "1",
};

const LEDGER_ROWS = 3_000;

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    [
      "build",
      path.join(repoRoot, "packages/workit-cli/src/main.ts"),
      "--outfile",
      cli,
      "--target",
      "node",
      "--format",
      "esm",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const ledgerDir = path.join(repo, ".git/workit/ledger");
  mkdirSync(ledgerDir, { recursive: true });
  const rows = Array.from({ length: LEDGER_ROWS }, (_, index) =>
    JSON.stringify({
      v: 1,
      id: `epipe-${index}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      branch: "fix/epipe",
      head: null,
      base: null,
      baseSha: null,
      patchId: null,
      diffHash: null,
      tree: null,
      dirty: null,
      actor: { host: "claude_code", session: "s", agentId: null },
      type: "ruling",
      what: `ruling number ${index} with enough text to fill the pipe buffer quickly`,
      why: "seeded by epipe.test.ts",
      costIfWrong: "none",
    }),
  );
  writeFileSync(path.join(ledgerDir, "ledger.jsonl"), `${rows.join("\n")}\n`);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Run = { code: number | null; stdout: string; stderr: string };
/** read: drain stdout · first-line: close it like `| head -1` · closed: close it before the CLI writes. */
type Reader = "read" | "first-line" | "closed";

const runCli = (argv: string[], reader: Reader): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn("node", [cli, ...argv], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (reader === "closed") child.stdout.destroy();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (reader === "first-line" && stdout.includes("\n")) child.stdout.destroy();
    });
    child.stderr.on("data", (chunk: string) => void (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const ledgerList = ["ledger", "list", "--last", String(LEDGER_ROWS)];

test("a verb printing more than the pipe holds exits 0 with an empty stderr when the reader closes after one line", async () => {
  const full = await runCli(ledgerList, "read");
  expect(full.code).toBe(0);
  expect(full.stdout.length).toBeGreaterThan(256 * 1024);

  const cut = await runCli(ledgerList, "first-line");
  expect({ stderr: cut.stderr, code: cut.code }).toEqual({
    stderr: "",
    code: 0,
  });
});

test("a reader gone before the CLI writes leaves stderr empty, the router's own paths included", async () => {
  for (const argv of [["--version"], ["help"], ["ledger", "list"]]) {
    const result = await runCli(argv, "closed");
    expect({ argv, stderr: result.stderr, code: result.code }).toEqual({
      argv,
      stderr: "",
      code: 0,
    });
  }
});

test("a failing verb keeps its exit code whether its output is read or not", async () => {
  const read = await runCli(["ledger", "list", "--bogus"], "read");
  expect(read.code).toBe(2);
  expect(read.stderr).toContain("unknown option --bogus");

  const closed = await runCli(["ledger", "list", "--bogus"], "closed");
  expect(closed.code).toBe(2);
  expect(closed.stderr).toContain("unknown option --bogus");
  expect(closed.stderr).not.toContain("EPIPE");
});
