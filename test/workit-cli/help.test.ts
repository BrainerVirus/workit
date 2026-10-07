import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASK_ACTIONS } from "@/packages/workit-cli/src/task";
import {
  FAMILY_ACTIONS,
  TASK_FAMILY_NAMES,
  VERBS,
  type VerbEntry,
} from "@/packages/workit-cli/src/verbs/registry";

// `-h`/`--help` and `help <verb> [<sub>]` answer from the registry before any
// verb loads, and the registry's usage lines name exactly the flags each
// verb's parser accepts.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliSrc = path.join(repoRoot, "packages/workit-cli/src");
const mainEntry = path.join(cliSrc, "main.ts");

// ---------------------------------------------------------------------------
// The flags a verb's parser accepts, read from its source. Every parser style
// in the CLI: parseFlags specs (`name: "value"`), node:util parseArgs options
// (`name: { type: … }`), and hand parsers comparing argv against literals
// (`"--all"`, `"-m"`, `startsWith("--hosts=")`). Arrays that start with a
// non-flag word are argv for git/npm, not flags, and are skipped.

/** `file` or `file#function` (that function's body only), relative to the CLI source. */
const PARSERS: Record<string, string[]> = {
  init: ["verbs/init.ts"],
  upgrade: ["upgrade.ts#runUpgradeCommand"],
  launch: ["upgrade.ts#runLaunchCommand"],
  doctor: ["verbs/doctor.ts"],
  gc: ["verbs/gc.ts"],
  uninstall: ["verbs/uninstall.ts"],
  grant: ["verbs/grant.ts"],
  ...Object.fromEntries(TASK_FAMILY_NAMES.map((name) => [name, ["task.ts#parseTaskArgs"]])),
  check: ["verbs/check.ts"],
  pr: ["verbs/pr.ts"],
  ci: ["verbs/ci.ts"],
  git: ["verbs/git.ts"],
  "verify-delivery": ["verbs/verify-delivery.ts"],
  stack: ["verbs/stack.ts"],
  fanout: ["verbs/fanout.ts"],
  ledger: ["verbs/ledger.ts"],
  "test-audit": ["verbs/test-audit.ts"],
  knowledge: ["verbs/knowledge.ts"],
  youtrack: ["verbs/youtrack.ts"],
  changelog: ["verbs/changelog.ts"],
  handoff: ["verbs/handoff.ts", "task.ts#parseHandoffArgs"],
};
PARSERS.task = [...PARSERS.task, "verbs/task.ts"];

// Flags a parser names but does not accept for this verb.
const NOT_ACCEPTED: Record<string, string[]> = {
  // parseTaskArgs reads --judge/--ref only when the family is policy.
  ...Object.fromEntries(
    TASK_FAMILY_NAMES.filter((name) => name !== "policy").map((name) => [
      name,
      ["--judge", "--ref"],
    ]),
  ),
  // `git push` names --force/-f only to refuse them.
  git: ["--force", "-f"],
};

const GLOBAL = new Set(["--json", "--cwd", "--help", "-h"]);

const functionBody = (source: string, name: string): string => {
  const start = source.search(new RegExp(`function ${name}\\(`, "u"));
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end);
};

const parserFlags = (verb: string): Set<string> => {
  const flags = new Set<string>();
  for (const ref of PARSERS[verb]) {
    const [file, fn] = ref.split("#");
    const whole = readFileSync(path.join(cliSrc, file), "utf8");
    const source = (fn ? functionBody(whole, fn) : whole)
      .replace(/\/\/[^\n]*/gu, "")
      .replace(/\[\s*"(?!-)[^"]*"[^\]]*\]/gu, "");
    const keyed =
      /[{,]\s*("?)([a-z][a-z0-9-]*)\1:\s*(?:"(?:value|boolean|list)"|\{\s*type:\s*"(?:string|boolean)")/gu;
    for (const match of source.matchAll(keyed)) flags.add(`--${match[2]}`);
    for (const match of source.matchAll(/"(--[a-z][a-z0-9-]*)=?"/gu)) flags.add(match[1]);
    for (const match of source.matchAll(/"(-[a-zA-Z])"/gu)) flags.add(match[1]);
  }
  for (const flag of [...GLOBAL, ...(NOT_ACCEPTED[verb] ?? [])]) flags.delete(flag);
  return flags;
};

const usageLines = (entry: VerbEntry): string[] => [
  entry.usage,
  ...(entry.subcommands ?? []).map((sub) => sub.usage),
];

const documentedFlags = (entry: VerbEntry): Set<string> => {
  const flags = new Set<string>();
  for (const line of usageLines(entry))
    for (const match of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*|-[a-zA-Z])(?![\w])/gu))
      flags.add(match[1]);
  for (const flag of GLOBAL) flags.delete(flag);
  return flags;
};

test("given every verb, then each flag its parser accepts is named in its usage, and no other", () => {
  expect(Object.keys(PARSERS).toSorted()).toEqual(VERBS.map((entry) => entry.name).toSorted());
  for (const entry of VERBS) {
    const accepted = [...parserFlags(entry.name)].toSorted();
    const documented = [...documentedFlags(entry)].toSorted();
    expect(documented, `workit ${entry.name}: usage vs parser`).toEqual(accepted);
  }
  // The extractor sees every parser style (a silent empty set would pass above
  // only if the usage were empty too).
  expect([...parserFlags("git")]).toEqual(
    expect.arrayContaining(["--carry", "--message", "-m", "-a", "--expect", "-u"]),
  );
  expect([...parserFlags("ledger")]).toContain("--cost-if-wrong");
  expect([...parserFlags("upgrade")]).toContain("--hosts");
  expect([...parserFlags("test-audit")]).toContain("--max-mutants");
  expect([...parserFlags("policy")]).toContain("--judge");
  expect([...parserFlags("evidence")]).not.toContain("--judge");
});

test("given the task families, then help lists exactly the actions the family grammar accepts", () => {
  for (const name of TASK_FAMILY_NAMES) {
    expect(Object.keys(FAMILY_ACTIONS[name]).toSorted(), name).toEqual(
      [...TASK_ACTIONS[name]].toSorted(),
    );
    const subs = VERBS.find((entry) => entry.name === name)!.subcommands!.map((sub) => sub.name);
    for (const action of TASK_ACTIONS[name]) expect(subs, `${name} ${action}`).toContain(action);
  }
});

// ---------------------------------------------------------------------------
// Behavior: a scratch repository with a task and a ledger row; no help request
// may change a byte of it (or of the isolated home).

let root = "";
let cwd = "";
let env: Record<string, string> = {};

const cli = (argv: string[]) => {
  const result = Bun.spawnSync(["bun", mainEntry, ...argv], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const cliAsync = async (argv: string[]) => {
  const child = Bun.spawn(["bun", mainEntry, ...argv], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { argv, code, stdout, stderr };
};

const snapshot = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const file = path.join(current, name);
      const rel = path.relative(dir, file);
      if (statSync(file).isDirectory()) {
        out.set(rel, "dir");
        walk(file);
      } else out.set(rel, createHash("sha1").update(readFileSync(file)).digest("hex"));
    }
  };
  walk(dir);
  return out;
};

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wk-help-"));
  const home = path.join(root, "home");
  cwd = path.join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      WORKFLOW_TOOLKIT_CONFIG: path.join(home, ".config", "workit"),
      WORKFLOW_TOOLKIT_STATE: path.join(home, ".local", "state", "workit"),
      WORKIT_SESSION_ID: "help-test-session",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }).filter(
      (pair): pair is [string, string] =>
        pair[0] !== "WORKFLOW_WORKSPACE_ROOT" && pair[1] !== undefined,
    ),
  );
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(["git", ...args], { cwd, env }).exitCode).toBe(0);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "chore: seed");
  expect(cli(["task", "start", "seed objective"]).code).toBe(0);
  expect(cli(["ledger", "decision", "seed decision", "--why", "seed"]).code).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every verb, and every subcommand (and alias) of it, as help targets. */
const targets = (): Array<{ words: string[]; expected: string }> =>
  VERBS.flatMap((entry) => [
    { words: [entry.name], expected: `usage: workit ${entry.name}` },
    ...(entry.subcommands ?? []).flatMap((sub) =>
      [sub.name, ...(sub.aliases ?? [])].map((word) => ({
        words: [entry.name, word],
        expected: `usage: workit ${entry.name} ${sub.name}`,
      })),
    ),
  ]);

const inBatches = async <T, R>(items: T[], size: number, run: (item: T) => Promise<R>) => {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return out;
};

test("given every verb and subcommand, when --help or -h follows it, then usage prints, exit 0, and nothing changes", async () => {
  const before = snapshot(root);
  const cases = targets().flatMap(({ words, expected }) => [
    { argv: [...words, "--help"], expected },
    { argv: [...words, "-h"], expected },
  ]);
  // Help flags after real arguments, on the verbs that used to act on them.
  cases.push(
    { argv: ["task", "start", "-h"], expected: "usage: workit task start" },
    { argv: ["task", "note", "would be noted", "-h"], expected: "usage: workit task note" },
    {
      argv: ["task", "close", "--outcome", "verified", "-h"],
      expected: "usage: workit task close",
    },
    { argv: ["gc", "--prune-recovery", "--yes", "--help"], expected: "usage: workit gc" },
    { argv: ["doctor", "--fix-lock", "--force", "--yes", "-h"], expected: "usage: workit doctor" },
    { argv: ["stack", "plan", "feature/a", "-h"], expected: "usage: workit stack plan" },
    {
      argv: ["git", "commit", "-m", "fix: x", "--all", "--help"],
      expected: "usage: workit git commit",
    },
    { argv: ["git", "branch", "feature/x", "-h"], expected: "usage: workit git branch" },
    {
      argv: ["ledger", "decision", "x", "--why", "y", "-h"],
      expected: "usage: workit ledger decision",
    },
    { argv: ["grant", "set", "work", "push=true", "-h"], expected: "usage: workit grant set" },
    { argv: ["--json", "task", "note", "x", "--help"], expected: '"subcommand":"note"' },
  );
  expect(cases.length).toBeGreaterThan(150);
  const results = await inBatches(cases, 12, async ({ argv, expected }) => ({
    ...(await cliAsync(argv)),
    expected,
  }));
  for (const result of results) {
    const label = `workit ${result.argv.join(" ")}\n${result.stderr}`;
    expect(result.code, label).toBe(0);
    expect(result.stderr, label).toBe("");
    expect(result.stdout, label).toContain(result.expected);
  }
  expect(snapshot(root)).toEqual(before);
}, 120_000);

test("given help flags after --, then they are values: task note -- -h records the note -h", () => {
  const before = snapshot(root);
  const noted = cli(["task", "note", "--json", "--", "-h"]);
  expect(noted.code, noted.stderr).toBe(0);
  const status = JSON.parse(cli(["task", "status", "--json"]).stdout);
  expect(status.data.task.progress.summary).toBe("-h");
  // The snapshot sees a store write, so the no-change assertion above can fail.
  expect(snapshot(root)).not.toEqual(before);
});

test("given help <verb> <sub>, then it prints that subcommand, the same as --help", () => {
  const viaHelp = cli(["help", "git", "commit"]);
  expect(viaHelp.code).toBe(0);
  expect(viaHelp.stdout).toStartWith("usage: workit git commit -m|--message <msg>…");
  expect(viaHelp.stdout).not.toContain("git push");
  expect(cli(["git", "commit", "--help"]).stdout).toBe(viaHelp.stdout);

  const verb = cli(["help", "git"]);
  expect(verb.stdout).toContain("usage: workit git push [-u|--set-upstream]");
  expect(verb.stdout).toContain("examples:\n  workit git branch --kind feature");

  const unknown = cli(["help", "git", "frob"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain('unknown git subcommand "frob"');
});

test("given --json, then help is an envelope carrying the usage and the text", () => {
  const result = cli(["git", "push", "-h", "--json"]);
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    code: "ok",
    data: {
      name: "git",
      subcommand: "push",
      usage: [
        "workit git push [-u|--set-upstream] [--force-with-lease [--expect <sha>] [--overwrite-unintegrated]]",
      ],
    },
  });
  expect(envelope.data.text).toStartWith("usage: workit git push");
  expect(JSON.parse(cli(["--json", "help", "pr", "merge"]).stdout).data.subcommand).toBe("merge");
});
