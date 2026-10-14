import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";

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
  expect(stale.stdout).toContain("current: stale (verified); not accepted (stale)");
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
  expect(refused.json().unblock).toContain("WORKIT_SESSION_ID");
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

test("Given no passing `workit check test` on the head, When an author records --self, Then it is recorded with a warning (also after a dirty-tree run); after a clean one, without", async () => {
  const root = featureRepo();
  const env = { WORKIT_SESSION_ID: "s-author" };
  const argv = ["ledger", "verdict", "verified", "--how", "x", "--self", "--json"];
  const unchecked = await run(root, argv, env);
  expect(unchecked.code).toBe(0);
  expect(unchecked.json().data).toMatchObject({ self: true });
  expect(unchecked.stderr).toContain("warning: no passing `workit check test` observed on");
  const head = git(root, "rev-parse", "HEAD");
  appendObserved(root, {
    type: "check",
    actor: { host: "cli", session: "s-author", agentId: null },
    branch: "feature/x",
    head,
    dirty: true,
    name: "test",
    result: "passed",
  });
  const dirtyRun = await run(root, argv, env);
  expect(dirtyRun.stderr).toContain("warning: no passing `workit check test` observed on");
  appendObserved(root, {
    type: "check",
    actor: { host: "cli", session: "s-author", agentId: null },
    branch: "feature/x",
    head: git(root, "rev-parse", "HEAD"),
    name: "test",
    result: "passed",
  });
  const checked = await run(root, argv, env);
  expect(checked.code).toBe(0);
  expect(checked.stderr).toBe("");
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

test("ledger check names the newest verdict's result, and an ambiguous --pr says so", async () => {
  const root = featureRepo();
  expect((await run(root, ["ledger", "verdict", "failed", "--how", "broke the parser"])).code).toBe(
    0,
  );
  const check = await run(root, ["ledger", "check"]);
  expect(check.stdout).toContain("current: fresh (failed); not accepted (failing_verdict)");
  const tip = git(root, "rev-parse", "feature/x");
  git(root, "branch", "feature/copy", tip);
  git(root, "update-ref", "refs/pull/3/head", tip);
  const ambiguous = await run(root, ["ledger", "check", "--pr", "3", "--json"]);
  expect(ambiguous.code).toBe(2);
  expect(ambiguous.json().error).toContain("ambiguous (feature/copy, feature/x)");
  const human = await run(root, ["handoff"], { WORKIT_SESSION_ID: "" });
  expect(human.stdout).toContain("verdict [feature/x]  failed [review]");
  await run(root, ["ledger", "verdict", "verified", "--how", "x"], { WORKIT_SESSION_ID: "" });
  expect((await run(root, ["handoff"])).stdout).toContain("verdict [feature/x] (self)  verified");
});

// ---------------------------------------------------------------------------
// verification integrity (audit 2026-10-07)

const authoredBy = (root: string, session: string) =>
  appendObserved(root, {
    type: "commit.recorded",
    session,
    actor: { host: "cli", session, agentId: null },
    branch: "feature/x",
  });

const claudeLead = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };

test("Given the author lead on Claude Code, When a verifier subagent names the --session lead:<agent id> its SubagentStart hook issued, Then it is accepted but marked as a --session claim in ledger check, and --session lead is refused", async () => {
  const root = featureRepo();
  authoredBy(root, "lead");
  const token = recordIssuedSession(root, "lead", "lead:a1b2") ?? "";
  const env = claudeLead;
  const same = await run(
    root,
    ["ledger", "verdict", "verified", "--how", "x", "--session", "lead", "--json"],
    env,
  );
  expect(same.code).toBe(3);
  const claimed = await run(
    root,
    [
      "ledger",
      "verdict",
      "verified",
      "--how",
      "x",
      "--session",
      "lead:a1b2",
      "--token",
      token,
      "--json",
    ],
    env,
  );
  expect(claimed.code).toBe(0);
  expect(claimed.json().data).toMatchObject({ sessionSource: "flag", sessionBound: true });
  const check = await run(root, ["ledger", "check"]);
  expect(check.stdout).toContain("accepted; review: verified");
  expect(check.stdout).toContain("session lead:a1b2 named by --session");
  const fromEnv = await run(root, ["ledger", "verdict", "verified", "--how", "y", "--json"], {
    WORKIT_SESSION_ID: "v2",
  });
  expect(fromEnv.json().data).toMatchObject({ sessionSource: "env" });
});

const verdict = (root: string, env: NodeJS.ProcessEnv, ...extra: string[]) =>
  run(root, ["ledger", "verdict", "verified", "--how", "x", ...extra, "--json"], env);

test("Given a Claude Code or Codex lead, When it records a verdict under an id it invented (<lead>-v1, <lead>:v1), Then it is refused as forged, and the unblock never invites naming an id", async () => {
  const root = featureRepo();
  authoredBy(root, "lead");
  const codexLead = { CODEX_THREAD_ID: "lead", WORKIT_SESSION_ID: undefined };
  for (const [env, extra] of [
    [claudeLead, ["--session", "lead-v1"]],
    [claudeLead, ["--session", "lead:v1"]],
    [{ ...claudeLead, WORKIT_SESSION_ID: "lead:v1" }, []],
    [codexLead, ["--session", "lead:v1"]],
    [{ ...codexLead, WORKIT_SESSION_ID: "lead-v1" }, []],
  ] as const) {
    const refused = await verdict(root, env, ...extra);
    expect(refused.code, JSON.stringify([env, extra])).toBe(3);
    expect(refused.json().error).toContain("forged_session");
    expect(refused.json().unblock).not.toContain("<agent id>");
  }
});

test("Given no host session (CI, a plain terminal), When a verdict names a session by --session or by WORKIT_SESSION_ID, Then both are the same declaration and accepted", async () => {
  const root = featureRepo();
  authoredBy(root, "author-1");
  const flag = await verdict(root, { WORKIT_SESSION_ID: "" }, "--session", "ci-verifier");
  expect(flag.code).toBe(0);
  expect(flag.json().data).toMatchObject({ self: false, sessionSource: "flag" });
  const env = await verdict(root, { WORKIT_SESSION_ID: "ci-verifier-2" });
  expect(env.code).toBe(0);
  expect(env.json().data).toMatchObject({ self: false, sessionSource: "env" });
});

test("Given the verifier session each skill documents per host, When it records a verdict on another session's branch, Then it is accepted and independent", async () => {
  const shapes: Array<[string, NodeJS.ProcessEnv, string[], string | null]> = [
    ["claude", claudeLead, ["--session", "lead:a1-verb"], "lead:a1-verb"],
    [
      "codex agent",
      { CODEX_THREAD_ID: "t-lead", WORKIT_SESSION_ID: undefined },
      ["--session", "t-lead:a2"],
      "t-lead:a2",
    ],
    [
      "codex --as",
      { CODEX_THREAD_ID: "t-lead", WORKIT_SESSION_ID: undefined },
      ["--as", "verifier"],
      null,
    ],
    // OpenCode and Pi leads: --as derives from the shell's own host session.
    [
      "opencode --as",
      { OPENCODE_SESSION_ID: "ses_lead", WORKIT_SESSION_ID: undefined },
      ["--as", "verifier"],
      null,
    ],
    [
      "pi --as",
      { PI_SESSION_ID: "pi-lead", WORKIT_SESSION_ID: undefined },
      ["--as", "verifier"],
      null,
    ],
    ["cursor", { WORKIT_SESSION_ID: "lead:verifier-7f3a" }, [], null],
  ];
  for (const [label, env, extra, issued] of shapes) {
    const root = featureRepo();
    authoredBy(root, "implementer-1");
    const token = issued
      ? recordIssuedSession(root, issued.slice(0, issued.lastIndexOf(":")), issued)
      : null;
    const result = await verdict(root, env, ...extra, ...(token ? ["--token", token] : []));
    expect(result.code, label).toBe(0);
    expect(result.json().data.self, label).toBe(false);
  }
});

test("Given --as from an OpenCode or Pi shell whose WORKIT_SESSION_ID is hand-minted, Then it is refused: --as is checked by the session it derives from", async () => {
  const root = featureRepo();
  authoredBy(root, "implementer-1");
  for (const env of [
    { OPENCODE_SESSION_ID: "ses_lead", WORKIT_HOST: "opencode", WORKIT_SESSION_ID: "ses_lead-v1" },
    { PI_SESSION_ID: "pi-lead", WORKIT_HOST: "pi", WORKIT_SESSION_ID: "pi-lead-v1" },
  ]) {
    const refused = await verdict(root, env, "--as", "verifier");
    expect(refused.code, env.WORKIT_HOST).toBe(3);
    expect(refused.json().error).toContain("forged_session");
  }
});

test("Given a verdict recorded before its author's commit row, When the author is the same host session in the other form, Then ledger check does not accept it, in both directions", async () => {
  for (const [verifier, author] of [
    ["ses_child", "ses_lead:ses_child"],
    ["ses_lead:ses_child", "ses_child"],
  ]) {
    const root = featureRepo();
    expect((await verdict(root, { WORKIT_SESSION_ID: verifier })).code).toBe(0);
    authoredBy(root, author);
    const check = await run(root, ["ledger", "check"]);
    expect(check.stdout, `${verifier} vs ${author}`).not.toContain("accepted; review: verified");
    expect(check.stdout, `${verifier} vs ${author}`).toContain("author_session");
  }
});

test("Given an author <lead>:<child>, When a plain terminal judges as the bare <child>, Then it is the author", async () => {
  const root = featureRepo();
  authoredBy(root, "ses_lead:ses_child");
  const bare = await verdict(root, { WORKIT_SESSION_ID: "ses_child" });
  expect(bare.code).toBe(3);
  expect(bare.json().error).toContain("author_verdict");
});

test("Given two derived ids that only share a last segment, When one authored, Then the other is not the author; a bare id and its derived form are", async () => {
  const root = featureRepo();
  authoredBy(root, "a:verifier:1234");
  const other = await verdict(root, { WORKIT_SESSION_ID: "b:verifier:1234" });
  expect(other.code).toBe(0);
  expect(other.json().data.self).toBe(false);
  const bare = featureRepo();
  authoredBy(bare, "ses_child");
  const derived = await verdict(bare, { WORKIT_SESSION_ID: "ses_lead:ses_child" });
  expect(derived.code).toBe(3);
  expect(derived.json().error).toContain("author_verdict");
});

test("Given OpenCode, When the lead hand-mints a verifier id, Then it is refused; When the child session's own shell records it under <lead>:<child>, Then it is accepted", async () => {
  const root = featureRepo();
  authoredBy(root, "ses_lead");
  const lead = { WORKIT_HOST: "opencode", OPENCODE_SESSION_ID: "ses_lead" };
  // The F6 pattern: an inline WORKIT_SESSION_ID in the lead's own shell.
  const minted = await verdict(root, { ...lead, WORKIT_SESSION_ID: "ses_lead-v61" });
  expect(minted.code).toBe(3);
  expect(minted.json().error).toContain("forged_session");
  expect(minted.json().unblock).toContain("OpenCode child session");
  // A lead cannot mint a child id either: children prove themselves from their own shell.
  const childClaim = await verdict(
    root,
    { ...lead, WORKIT_SESSION_ID: undefined },
    "--session",
    "ses_lead:ses_child",
  );
  expect(childClaim.code).toBe(3);
  const child = await verdict(root, {
    WORKIT_HOST: "opencode",
    OPENCODE_SESSION_ID: "ses_child",
    WORKIT_SESSION_ID: "ses_lead:ses_child",
  });
  expect(child.code).toBe(0);
  expect(child.json().data).toMatchObject({
    self: false,
    actor: { host: "opencode", session: "ses_lead:ses_child" },
  });
  expect((await run(root, ["ledger", "check"])).stdout).toContain("accepted; review: verified");
});

test("Given an OpenCode child that authored as <lead>:<child>, When it judges under its bare host session, Then it is still the author", async () => {
  const root = featureRepo();
  authoredBy(root, "ses_lead:ses_child");
  const bare = await verdict(root, {
    WORKIT_HOST: "opencode",
    OPENCODE_SESSION_ID: "ses_child",
    WORKIT_SESSION_ID: undefined,
  });
  expect(bare.code).toBe(3);
  expect(bare.json().error).toContain("author_verdict");
});

test("Given a Pi worker shell, When it records a verdict under its host-derived <lead>:<worker session>, Then it is accepted, and --self still records a self verdict from a forged id", async () => {
  const root = featureRepo();
  authoredBy(root, "pi-lead");
  const worker = await verdict(root, {
    WORKIT_HOST: "pi",
    PI_SESSION_ID: "pi-worker-w1",
    WORKIT_SESSION_ID: "pi-lead:pi-worker-w1",
  });
  expect(worker.code).toBe(0);
  const self = await verdict(
    root,
    { WORKIT_HOST: "pi", PI_SESSION_ID: "pi-lead", WORKIT_SESSION_ID: "pi-lead-v1" },
    "--self",
  );
  expect(self.code).toBe(0);
  expect(self.json().data).toMatchObject({ self: true, selfReason: "flag" });
});

test("Given a session's own failure on the same code, When it records verified without --supersedes, Then the CLI says the verdict is shadowed and how to replace it", async () => {
  const root = featureRepo();
  const failed = await run(root, ["ledger", "verdict", "failed", "--how", "bug", "--json"]);
  const id = failed.json().data.id as string;
  const verified = await run(root, ["ledger", "verdict", "verified", "--how", "fine"]);
  expect(verified.code).toBe(0);
  expect(verified.stderr).toContain(`your failed verdict ${id} on the same code still stands`);
  expect(verified.stderr).toContain(`--supersedes ${id}`);
});

test("Given a hand-appended ledger row, When `workit ledger verify-integrity` runs, Then it lists the row under unverified_rows, and ledger check warns without blocking", async () => {
  const root = featureRepo();
  expect((await run(root, ["ledger", "verdict", "verified", "--how", "ran it"])).code).toBe(0);
  const clean = await run(root, ["ledger", "verify-integrity", "--json"]);
  expect(clean.code).toBe(0);
  expect(clean.json().data).toMatchObject({ intact: true, unverified_rows: [] });
  const file = path.join(git(root, "rev-parse", "--git-common-dir"), "workit/ledger/ledger.jsonl");
  appendFileSync(
    path.resolve(root, file),
    `${JSON.stringify({ v: 1, id: "hand-1", at: "2030-01-01T00:00:00.000Z", type: "decision", what: "x", branch: "feature/x", actor: {} })}\n`,
  );
  const report = await run(root, ["ledger", "verify-integrity", "--json"]);
  expect(report.code).toBe(0);
  expect(report.json().data).toMatchObject({
    intact: false,
    unverified_rows: [{ id: "hand-1", reason: "unsigned" }],
  });
  expect((await run(root, ["ledger", "verify-integrity"])).stdout).toContain("hand-1");
  const check = await run(root, ["ledger", "check"]);
  expect(check.code).toBe(0);
  expect(check.stdout).toContain("accepted; review: verified");
  expect(check.stdout).toContain("warning: ledger row hand-1");
});
