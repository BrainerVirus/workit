import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mutantsFor, removeStaleCopies } from "@/packages/workit-cli/src/test-audit/mutate";

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** An untracked source that is a symlink to a real file outside the repository. */
function linkOutside(repo: string) {
  const outside = path.join(path.dirname(repo), "outside", "real.ts");
  mkdirSync(path.dirname(outside), { recursive: true });
  const text = "export const gt = (a: number, b: number): boolean => a > b;\n";
  writeFileSync(outside, text);
  symlinkSync(outside, path.join(repo, "src", "link.ts"));
  writeFileSync(
    path.join(repo, "test", "link.test.ts"),
    `import { expect, test } from "bun:test";\nimport { gt } from "../src/link";\ntest("gt", () => { expect(gt(2, 1)).toBe(true); });\n`,
  );
  return { outside, text };
}

async function killMidMutant(signal: NodeJS.Signals) {
  const { repo, tmp, git } = fixture();
  const { outside, text } = linkOutside(repo);
  const marker = path.join(tmp, "mutant-running");
  const statusBefore = git("status", "--porcelain");
  // The command parks inside the first mutant of the symlinked source, so the
  // kill lands while that file is mutated in the copy.
  const command = `if [ -n "$WORKIT_MUTANT" ] && ! grep -q "a > b" src/link.ts; then echo $$ > '${marker}'; sleep 30; fi; bun test {files}`;
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
  const tree = path.join(tmp, copiesIn(tmp)[0], "tree");
  // The mutant lives in the copy's own regular file, never behind the link.
  expect(lstatSync(path.join(tree, "src", "link.ts")).isFile()).toBe(true);
  expect(readFileSync(path.join(tree, "src", "link.ts"), "utf8")).not.toBe(text);
  expect(readFileSync(outside, "utf8")).toBe(text);
  child.kill(signal);
  await exited;
  // A killed process can take a moment to be reaped by init.
  for (let wait = 0; wait < 40 && alive(shell); wait += 1) await Bun.sleep(50);
  const shellAlive = alive(shell);
  try {
    process.kill(-shell, "SIGKILL"); // the parked test command, if still alive
  } catch {
    // already reaped
  }
  expect(readFileSync(outside, "utf8")).toBe(text);
  expect(readFileSync(path.join(repo, "src", "age.ts"), "utf8")).toBe(SOURCE);
  expect(git("status", "--porcelain")).toBe(statusBefore);
  return { tmp, shellAlive };
}

test("SIGKILL mid-mutant leaves sources and a symlinked outside file byte-identical; the stale copy is removed on the next run", async () => {
  const { tmp } = await killMidMutant("SIGKILL");
  expect(copiesIn(tmp)).toHaveLength(1);
  expect(removeStaleCopies(tmp)).toBe(1);
  expect(copiesIn(tmp)).toEqual([]);
}, 60_000);

test("SIGTERM mid-mutant kills the running tests, removes the copy and leaves the symlink target byte-identical", async () => {
  const { tmp, shellAlive } = await killMidMutant("SIGTERM");
  expect(shellAlive).toBe(false);
  expect(copiesIn(tmp)).toEqual([]);
}, 60_000);

test("a full --mutate run never writes through a symlinked source", () => {
  const { repo, tmp } = fixture();
  const { outside, text } = linkOutside(repo);
  const run = cli(repo, tmp, [
    "--mutate",
    "--diff",
    "main",
    "--test-cmd",
    "bun test {files}",
    "--json",
  ]);
  const mutation = JSON.parse(run.stdout).data.mutation;
  expect(
    mutation.mutants.some(
      (mutant: { file: string; status: string }) =>
        mutant.file === "src/link.ts" && mutant.status === "killed",
    ),
  ).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe(text);
});

test("each mutant starts from the original file: the previous mutant is restored first", () => {
  const { repo, tmp } = fixture();
  const seen = path.join(tmp, "seen");
  mkdirSync(seen);
  const command = `if [ -n "$WORKIT_MUTANT" ]; then cp src/age.ts '${seen}'/"$WORKIT_MUTANT".ts; fi; bun test {files}`;
  cli(repo, tmp, ["--mutate", "--diff", "main", "--test-cmd", command, "--json"]);
  expect(
    readdirSync(seen)
      .toSorted()
      .map((file) => readFileSync(path.join(seen, file), "utf8")),
  ).toEqual([SOURCE.replace(">=", ">"), SOURCE.replace(">=", "<")]);
});

test("a timed-out mutant has its whole process group killed", () => {
  const { repo, tmp } = fixture();
  const pids = path.join(tmp, "pids");
  const command = `if [ -n "$WORKIT_MUTANT" ]; then sleep 60 & echo $! >> '${pids}'; wait; fi; bun test {files}`;
  const run = cli(repo, tmp, [
    "--mutate",
    "--diff",
    "main",
    "--test-cmd",
    command,
    "--timeout",
    "1",
    "--json",
  ]);
  expect(JSON.parse(run.stdout).data.mutation.counts.timeout).toBe(2);
  const grandchildren = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  expect(grandchildren).toHaveLength(2);
  expect(grandchildren.filter(alive)).toEqual([]);
}, 60_000);

test("workspace links in the copy point at the copy, and tool caches are not shared", () => {
  const { repo, tmp, git } = fixture();
  mkdirSync(path.join(repo, "packages", "lib"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(
    path.join(repo, "packages", "lib", "package.json"),
    '{ "name": "@fx/lib", "main": "index.ts" }\n',
  );
  writeFileSync(
    path.join(repo, "packages", "lib", "index.ts"),
    "export const double = (n: number): number => n;\n",
  );
  git("add", ".");
  git("commit", "-qm", "lib");
  writeFileSync(
    path.join(repo, "packages", "lib", "index.ts"),
    "export const double = (n: number): number => n * 2;\n",
  );
  mkdirSync(path.join(repo, "node_modules", "@fx"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules", ".cache"));
  symlinkSync("../../packages/lib", path.join(repo, "node_modules", "@fx", "lib"));
  writeFileSync(
    path.join(repo, "test", "lib.test.ts"),
    `import { expect, test } from "bun:test";\nimport { double } from "@fx/lib";\ntest("double", () => { expect(double(3)).toBe(6); });\n`,
  );
  rmSync(path.join(repo, "test", "age.test.ts"));
  // No {files}: every mutant runs the whole suite, which imports through the link.
  const command = "touch node_modules/.cache/written && bun test";
  const run = cli(repo, tmp, ["--mutate", "--diff", "main", "--test-cmd", command, "--json"]);
  const mutation = JSON.parse(run.stdout).data.mutation;
  const lib = mutation.mutants.filter(
    (mutant: { file: string }) => mutant.file === "packages/lib/index.ts",
  );
  expect(lib.map((mutant: { status: string }) => mutant.status)).toEqual(["killed"]);
  expect(existsSync(path.join(repo, "node_modules", ".cache", "written"))).toBe(false);
}, 60_000);

test("string concatenation and templates are never arithmetic mutants", () => {
  const source =
    'export const f = (a: number, b: string) => [a + 1, b + "x", `${b}` + b, a - 1];\n';
  expect(
    mutantsFor(source, "f.ts", "all").map((mutant) => `${mutant.original}->${mutant.replacement}`),
  ).toEqual(["+->-", "-->+"]);
});

test("removeStaleCopies keeps copies of live processes and skips unreadable entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-stale-"));
  cleanup.push(root);
  const live = path.join(root, "workit-mutate-live");
  mkdirSync(live);
  writeFileSync(path.join(live, ".workit-mutate.pid"), String(process.pid));
  const dead = path.join(root, "workit-mutate-dead");
  mkdirSync(dead);
  writeFileSync(path.join(dead, ".workit-mutate.pid"), "999999999");
  writeFileSync(path.join(root, "workit-mutate-file"), "not a dir");
  expect(removeStaleCopies(root)).toBe(1);
  expect(readdirSync(root).toSorted()).toEqual(["workit-mutate-file", "workit-mutate-live"]);
  expect(removeStaleCopies(path.join(root, "missing"))).toBe(0);
});

test("--diff handles changed paths with spaces and non-ASCII names", () => {
  const { repo, tmp, git } = fixture();
  const dir = path.join(repo, "test", "sp ace");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "ñandú.test.ts"), `test("x", () => { expect(1).toBe(1); });\n`);
  git("add", "-A");
  git("commit", "-qm", "odd paths");
  writeFileSync(path.join(dir, "ñandú.test.ts"), `test("x", () => { expect(2).toBe(2); });\n`);
  const run = cli(repo, tmp, ["--diff", "HEAD", "--json"]);
  expect(
    JSON.parse(run.stdout).data.findings.map((finding: { file: string }) => finding.file),
  ).toEqual(["test/sp ace/ñandú.test.ts"]);
});

test("with no workit.checks.json, --mutate runs the detected default `workit check test` would run", () => {
  const { repo, tmp } = fixture();
  writeFileSync(
    path.join(repo, "package.json"),
    '{ "name": "fx", "type": "module", "scripts": { "test": "bun test" } }\n',
  );
  writeFileSync(path.join(repo, "bun.lock"), "");
  const mutation = JSON.parse(cli(repo, tmp, ["--mutate", "--diff", "main", "--json"]).stdout).data
    .mutation;
  expect([mutation.command, mutation.counts.killed, mutation.counts.survived]).toEqual([
    "bun run test",
    1,
    1,
  ]);
});

test("with no test check at all, --mutate is unavailable and says how to fix it", () => {
  const { repo, tmp } = fixture();
  const run = cli(repo, tmp, ["--mutate", "--diff", "main", "--json"]);
  expect([run.status, JSON.parse(run.stdout).code]).toEqual([5, "unavailable"]);
});
