import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeStaleCopies } from "@/packages/workit-cli/src/test-audit/mutate";

// `workit test-audit --mutate` and `--diff` against a throwaway git repo. The
// branch changes `isAdult` to `age >= 18` and its test only checks 30 and 5,
// so the boundary mutant (`>`) survives and the negation (`<`) is killed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = path.join(repoRoot, "packages/workit-cli/src/main.ts");
const SOURCE = "export const isAdult = (age: number): boolean => age >= 18;\n";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-mutate-fx-"));
  cleanup.push(root);
  const repo = path.join(root, "repo");
  const tmp = path.join(root, "tmp");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, "test"), { recursive: true });
  mkdirSync(tmp);
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "package.json"), '{ "name": "fx", "type": "module" }\n');
  writeFileSync(
    path.join(repo, "src", "age.ts"),
    "export const isAdult = (age: number): boolean => false;\n",
  );
  git("add", ".");
  git("commit", "-qm", "init");
  git("checkout", "-qb", "feature");
  writeFileSync(path.join(repo, "src", "age.ts"), SOURCE);
  writeFileSync(
    path.join(repo, "test", "age.test.ts"),
    `import { expect, test } from "bun:test";
import { isAdult } from "../src/age";
test("adults and children", () => {
  expect(isAdult(30)).toBe(true);
  expect(isAdult(5)).toBe(false);
});
test("smoke", () => {
  isAdult(1);
});
`,
  );
  return { repo, tmp, git };
}

const cli = (repo: string, tmp: string, args: string[]) =>
  spawnSync("bun", [main, "--cwd", repo, "test-audit", ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
    timeout: 60_000,
  });

const copiesIn = (tmp: string) =>
  readdirSync(tmp).filter((name) => name.startsWith("workit-mutate-"));

test("--diff audits only the test files changed against the base", () => {
  const { repo, tmp } = fixture();
  writeFileSync(
    path.join(repo, "test", "old.test.ts"),
    `test("t", () => { expect(true).toBe(true); });\n`,
  );
  spawnSync("git", ["add", "test/old.test.ts"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "old"], { cwd: repo });
  spawnSync("git", ["checkout", "-q", "main"], { cwd: repo });
  spawnSync("git", ["merge", "-q", "feature"], { cwd: repo });
  spawnSync("git", ["checkout", "-q", "feature"], { cwd: repo });
  const run = cli(repo, tmp, ["--diff", "main", "--json"]);
  const envelope = JSON.parse(run.stdout);
  expect(envelope.ok).toBe(true);
  expect(envelope.data.files).toBe(1);
  expect(
    envelope.data.findings.map((finding: { file: string; rule: string; line: number }) => [
      finding.file,
      finding.rule,
      finding.line,
    ]),
  ).toEqual([["test/age.test.ts", "assertion-free", 7]]);
});

test("--fail-on gates on findings at or above the level; below it the audit passes", () => {
  const { repo, tmp } = fixture();
  const gated = cli(repo, tmp, ["test", "--fail-on", "medium"]);
  expect(gated.status).toBe(1);
  expect(gated.stdout).toContain("test/age.test.ts:7  assertion-free");
  const envelope = JSON.parse(cli(repo, tmp, ["test", "--fail-on", "medium", "--json"]).stdout);
  expect([envelope.code, envelope.data.summary.bySeverity.medium]).toEqual(["failed", 1]);
  expect(cli(repo, tmp, ["test", "--fail-on", "high"]).status).toBe(0);
});

test("--mutate reports the surviving boundary mutant, exits 1 and leaves sources byte-identical", () => {
  const { repo, tmp, git } = fixture();
  const statusBefore = git("status", "--porcelain");
  const run = cli(repo, tmp, [
    "--mutate",
    "--diff",
    "main",
    "--test-cmd",
    "bun test {files}",
    "--json",
  ]);
  expect(run.status).toBe(1);
  const envelope = JSON.parse(run.stdout);
  expect(envelope.code).toBe("failed");
  const mutation = envelope.data.mutation;
  expect(mutation.counts).toEqual({
    killed: 1,
    survived: 1,
    timeout: 0,
    "no-tests": 0,
    skipped: 0,
  });
  expect(
    mutation.mutants.map(
      (mutant: { original: string; replacement: string; status: string; tests: string[] }) => [
        mutant.original,
        mutant.replacement,
        mutant.status,
        mutant.tests,
      ],
    ),
  ).toEqual([
    [">=", ">", "survived", ["test/age.test.ts"]],
    [">=", "<", "killed", ["test/age.test.ts"]],
  ]);
  expect(mutation.score).toBe(50);
  expect(readFileSync(path.join(repo, "src", "age.ts"), "utf8")).toBe(SOURCE);
  expect(git("status", "--porcelain")).toBe(statusBefore);
  expect(copiesIn(tmp)).toEqual([]);
});

test("the mutation copy is its own git repo on the same branch with the same dirty state", () => {
  const { repo, tmp } = fixture();
  const seen = path.join(tmp, "seen.txt");
  const command = `if [ -z "$WORKIT_MUTANT" ]; then git status --porcelain > '${seen}'; git rev-parse --abbrev-ref HEAD >> '${seen}'; fi; bun test {files}`;
  cli(repo, tmp, ["--mutate", "--diff", "main", "--test-cmd", command, "--json"]);
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout;
  expect(readFileSync(seen, "utf8")).toBe(`${status}feature\n`);
});

test("without --test-cmd, --mutate runs the configured `workit check test` command", () => {
  const { repo, tmp } = fixture();
  writeFileSync(path.join(repo, "workit.checks.json"), '{ "checks": { "test": "bun test" } }\n');
  const run = cli(repo, tmp, ["--mutate", "--diff", "main", "--json"]);
  const mutation = JSON.parse(run.stdout).data.mutation;
  expect([mutation.command, mutation.counts.killed, mutation.counts.survived]).toEqual([
    "bun test",
    1,
    1,
  ]);
});

test("--mutate with no related tests reports no-tests instead of running", () => {
  const { repo, tmp } = fixture();
  rmSync(path.join(repo, "test", "age.test.ts"));
  const run = cli(repo, tmp, [
    "--mutate",
    "--diff",
    "main",
    "--test-cmd",
    "bun test {files}",
    "--json",
  ]);
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout).data.mutation.counts["no-tests"]).toBe(2);
});

test("a red baseline stops --mutate before any mutant runs", () => {
  const { repo, tmp } = fixture();
  const run = cli(repo, tmp, ["--mutate", "--diff", "main", "--test-cmd", "exit 3", "--json"]);
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout).error).toContain("baseline");
  expect(copiesIn(tmp)).toEqual([]);
});

async function killMidMutant(signal: NodeJS.Signals) {
  const { repo, tmp, git } = fixture();
  const marker = path.join(tmp, "mutant-running");
  const statusBefore = git("status", "--porcelain");
  // The command parks inside the first mutant run so the kill lands while a
  // mutated file exists in the copy.
  const command = `if [ -n "$WORKIT_MUTANT" ]; then echo $$ > '${marker}'; sleep 30; fi; bun test {files}`;
  const child = spawn(
    "bun",
    [main, "--cwd", repo, "test-audit", "--mutate", "--diff", "main", "--test-cmd", command],
    {
      env: { ...process.env, TMPDIR: tmp },
      stdio: "ignore",
    },
  );
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker) || readFileSync(marker, "utf8").trim() === "") {
    if (Date.now() > deadline) throw new Error("mutant run never started");
    await Bun.sleep(50);
  }
  const shell = Number(readFileSync(marker, "utf8"));
  expect(copiesIn(tmp)).toHaveLength(1);
  const mutated = path.join(tmp, copiesIn(tmp)[0], "tree", "src", "age.ts");
  expect(readFileSync(mutated, "utf8")).not.toBe(SOURCE);
  child.kill(signal);
  await exited;
  try {
    process.kill(-shell, "SIGKILL"); // the parked test command, if still alive
  } catch {
    // already reaped
  }
  expect(readFileSync(path.join(repo, "src", "age.ts"), "utf8")).toBe(SOURCE);
  expect(git("status", "--porcelain")).toBe(statusBefore);
  return tmp;
}

test("SIGKILL mid-mutant leaves the sources byte-identical; the stale copy is removed on the next run", async () => {
  const tmp = await killMidMutant("SIGKILL");
  expect(copiesIn(tmp)).toHaveLength(1);
  expect(removeStaleCopies(tmp)).toBe(1);
  expect(copiesIn(tmp)).toEqual([]);
}, 60_000);

test("SIGTERM mid-mutant removes the copy and leaves the sources byte-identical", async () => {
  const tmp = await killMidMutant("SIGTERM");
  expect(copiesIn(tmp)).toEqual([]);
}, 60_000);
