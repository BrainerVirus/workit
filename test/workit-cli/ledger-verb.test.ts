import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";

// S13 verbs (design §2.1): `workit ledger …` and the bare `workit handoff`.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const featureRepo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-ledger-cli-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "feature.txt"), "feature\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature work");
  return root;
};

const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-reviewer", ...env },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("ledger records decisions, rulings and verdicts and lists them, including via `add` and `show`", async () => {
  const root = featureRepo();
  expect(
    (
      await run(root, [
        "ledger",
        "decision",
        "use",
        "jsonl",
        "--why",
        "atomic",
        "--ref",
        "docs/x.md",
      ])
    ).code,
  ).toBe(0);
  const ruling = await run(root, [
    "ledger",
    "add",
    "ruling",
    "derive seq on read",
    "--why",
    "no lock",
    "--cost-if-wrong",
    "rows reorder",
    "--json",
  ]);
  expect(ruling.code).toBe(0);
  expect(ruling.json().data).toMatchObject({
    type: "ruling",
    what: "derive seq on read",
    why: "no lock",
    costIfWrong: "rows reorder",
    branch: "feature/x",
  });
  // --pr must resolve: unknown → invalid_input; a fetched forge ref → its branch.
  const unknownPr = await run(root, [
    "ledger",
    "verdict",
    "verified",
    "--how",
    "x",
    "--pr",
    "7",
    "--json",
  ]);
  expect(unknownPr.code).toBe(2);
  expect(unknownPr.json().code).toBe("invalid_input");
  git(root, "update-ref", "refs/pull/7/head", git(root, "rev-parse", "feature/x"));
  const mismatch = await run(root, [
    "ledger",
    "verdict",
    "verified",
    "--how",
    "x",
    "--pr",
    "7",
    "--branch",
    "main",
    "--json",
  ]);
  expect(mismatch.code).toBe(2);
  expect(mismatch.json().error).toContain("PR 7 is branch feature/x");
  const verdict = await run(root, [
    "ledger",
    "verdict",
    "tests-verified",
    "--kind",
    "unit",
    "--how",
    "bun test: 12 pass",
    "--evidence",
    "blobs/logs/x.log",
    "--pr",
    "7",
    "--json",
  ]);
  expect(verdict.code).toBe(0);
  expect(verdict.json().data).toMatchObject({
    type: "verdict",
    result: "tests-verified",
    kind: "unit",
    pr: 7,
    observer: "agent_asserted",
    self: false,
    evidenceRefs: ["blobs/logs/x.log"],
  });

  const listed = (await run(root, ["ledger", "show", "--json"])).json().data;
  expect(listed.rows.map((row: { type: string }) => row.type)).toEqual([
    "decision",
    "ruling",
    "verdict",
  ]);
  expect(listed.rows[0].refs).toEqual(["docs/x.md"]);
  const onlyVerdicts = (await run(root, ["ledger", "list", "--type", "verdict", "--json"])).json();
  expect(onlyVerdicts.data.rows).toHaveLength(1);
  const human = await run(root, ["ledger", "list"]);
  expect(human.stdout).toContain(
    "ruling [feature/x]  derive seq on read (why: no lock; cost if wrong: rows reorder)",
  );

  // Read forms: by branch, by PR, and the current branch.
  for (const argv of [
    ["ledger", "verdict", "feature/x", "--json"],
    ["ledger", "check", "--pr", "7", "--json"],
    ["ledger", "check", "--json"],
  ]) {
    const read = await run(root, argv);
    expect(read.code, argv.join(" ")).toBe(0);
    expect(read.json().data).toMatchObject({
      branch: "feature/x",
      current: { basis: "fresh" },
      accepted: { accepted: true },
    });
  }
});

test("ledger check reports carried after a base-only rebase and stale after a content change", async () => {
  const root = featureRepo();
  expect((await run(root, ["ledger", "verdict", "verified", "--how", "drove the CLI"])).code).toBe(
    0,
  );
  git(root, "checkout", "-q", "main");
  writeFileSync(path.join(root, "other.txt"), "other\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  expect((await run(root, ["ledger", "check", "--json"])).json().data).toMatchObject({
    current: { basis: "carried" },
    accepted: { accepted: true },
  });
  writeFileSync(path.join(root, "feature.txt"), "changed\n");
  git(root, "commit", "-qam", "change");
  const stale = await run(root, ["ledger", "check"]);
  expect(stale.code).toBe(0);
  expect(stale.stdout).toContain("current stale; not accepted (stale)");
});

test("an author session's verdict is blocked (exit 3) unless --self", async () => {
  const root = featureRepo();
  appendObserved(root, {
    type: "commit.recorded",
    session: "s-author",
    actor: { host: "cli", session: "s-author", agentId: null },
    branch: "feature/x",
  });
  const env = { WORKIT_SESSION_ID: "s-author" };
  const refused = await run(root, ["ledger", "verdict", "verified", "--how", "x", "--json"], env);
  expect(refused.code).toBe(3);
  expect(refused.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(refused.json().unblock).toContain("--self");
  const self = await run(
    root,
    ["ledger", "verdict", "verified", "--how", "x", "--self", "--json"],
    env,
  );
  expect(self.code).toBe(0);
  expect(self.json().data).toMatchObject({ self: true, actor: { session: "s-author" } });
  const check = await run(root, ["ledger", "check", "--json"]);
  expect(check.json().data.accepted).toMatchObject({ accepted: false });
  const anonymous = await run(root, ["ledger", "verdict", "verified", "--how", "x", "--json"], {
    WORKIT_SESSION_ID: "",
  });
  expect(anonymous.json().data).toMatchObject({ self: true, selfReason: "no_session" });
});

test("ledger usage errors exit 2 with an unblock hint", async () => {
  const root = featureRepo();
  for (const argv of [
    ["ledger"],
    ["ledger", "frob"],
    ["ledger", "decision", "what"],
    ["ledger", "ruling", "what", "--why", "w"],
    ["ledger", "verdict", "verified"],
    ["ledger", "verdict", "verified", "--how", "x", "--kind", "vibes"],
    ["ledger", "add", "list"],
    ["ledger", "list", "--last", "0"],
    ["ledger", "list", "--bogus"],
    ["ledger", "check", "--pr", "99"],
  ]) {
    const result = await run(root, [...argv, "--json"]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.json().code, argv.join(" ")).toBe("invalid_input");
  }
});

test("handoff prints a resume brief, and --record makes it the next brief's lastHandoff", async () => {
  const root = featureRepo();
  await run(root, ["ledger", "ruling", "skip GC", "--why", "S15", "--cost-if-wrong", "disk"]);
  const first = await run(root, [
    "handoff",
    "--note",
    "parser half done",
    "--next",
    "finish parser",
    "--record",
    "--json",
  ]);
  expect(first.code).toBe(0);
  const data = first.json().data;
  expect(data).toMatchObject({
    branch: "feature/x",
    subject: "feature work",
    dirty: { dirty: false, files: 0 },
    note: "parser half done",
    next: "finish parser",
    store: { shared: true },
  });
  expect(data.nextCommand).toContain("workit ledger verdict verified --branch feature/x");
  expect(data.rulings).toHaveLength(1);
  expect(typeof data.recorded).toBe("string");

  const second = await run(root, ["handoff"]);
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("branch: feature/x @ ");
  expect(second.stdout).toContain("finish parser (note: parser half done)");
  expect(second.stdout).toContain("next:   workit ledger verdict verified --branch feature/x");
  expect((await run(root, ["handoff", "--last", "x", "--json"])).code).toBe(2);
});
