// `workit pr merge|status` and `verify-delivery merged` against forged ledger
// rows and a merge whose post-merge reads fail (audit 2026-10-13 N1, N3),
// over recorded GitHub API shapes (fake gh).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import { ledgerPath, readLedger, recordVerdict } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  replyError,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-trust-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** The CLI in-process; `env` replaces the session variables. */
const run = async (argv: string[], cwd: string, env: Record<string, string> = {}) => {
  let stdout = "";
  const base = { ...process.env };
  for (const key of [
    "WORKIT_SESSION_ID",
    "WORKIT_HOST",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
  ])
    delete base[key];
  const io: Partial<Io> = {
    cwd,
    // A Codex shell has no WORKIT_SESSION_ID: its own thread id is the session.
    env: { ...base, ...(env.CODEX_THREAD_ID ? {} : { WORKIT_SESSION_ID: "author-1" }), ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

/** After the merge call, status reads are `after` (merged, or failing). */
const setup = (
  after: { value: "merged" | "failing" | "open" } = { value: "merged" },
  options: { mergeCallFails?: boolean } = {},
) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: "verified" },
        },
      ],
    }),
  );
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () =>
      !merged
        ? fixture("github/pr-passing.json")
        : after.value === "merged"
          ? fixture("github/pr-merged.json")
          : after.value === "open"
            ? fixture("github/pr-passing.json")
            : replyError("HTTP 502: Bad Gateway (https://api.github.com/graphql)"),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      // The forge merged, but the call's reply was lost (a timeout, a 502).
      if (options.mergeCallFails) return replyError("HTTP 502: Bad Gateway", 1);
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner, after };
};

const writes = (calls: readonly Call[]) =>
  calls.filter(
    (call) => call.method !== "GET" && call.method !== "CLI" && call.endpoint !== "graphql",
  );

/** A verdict line appended by hand, as in the audit. */
const forge = (repo: ForgeRepo, actor: Record<string, unknown>, extra = {}) => {
  const file = ledgerPath(repo.cwd);
  if (!file.ok) throw new Error(file.error);
  appendFileSync(
    file.value,
    `${JSON.stringify({ v: 1, id: "forged-1", at: new Date().toISOString(), type: "verdict", kind: "review", result: "verified", how: "x", branch: "feature/x", head: repo.head, observer: "agent_asserted", self: false, selfReason: null, sessionSource: "env", actor, ...extra })}\n`,
  );
};

test("Given only a hand-appended verdict, When pr merge, pr status and ledger verdict read it, Then none accepts it (unsigned) and nothing merges", async () => {
  const { repo, runner } = setup();
  // The chain has begun: the author's own self verdict.
  expect(
    (await run(["ledger", "verdict", "verified", "--how", "mine", "--self"], repo.cwd)).code,
  ).toBe(0);
  forge(repo, { host: "cli", session: "totally-independent", agentId: null });
  const merge = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merge.code).toBe(3);
  expect(merge.json().error).toContain("NEEDS_VERDICT");
  expect(writes(runner.calls)).toEqual([]);
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict).toMatchObject({ accepted: false });
  const verdict = await run(["ledger", "verdict"], repo.cwd);
  expect(verdict.stdout).toContain("not accepted (self)");
  expect(verdict.stdout).not.toContain("; accepted;");
});

test("Given a --session verdict an older CLI recorded on Claude Code for an id no hook issued, When pr merge runs, Then it needs a verdict (unissued_session) until the id is issued", async () => {
  const { repo, runner } = setup();
  const recorded = recordVerdict(
    {
      cwd: repo.cwd,
      actor: { host: "claude_code", session: "lead-1:verifier-v1", agentId: null },
      sessionSource: "flag",
      branch: "feature/x",
    },
    { result: "verified", how: "minted by hand" },
  );
  expect(recorded.ok).toBe(true);
  const refused = await run(["pr", "merge", "--json"], repo.cwd);
  expect(refused.json().error).toContain("unissued_session");
  expect(writes(runner.calls)).toEqual([]);
  // Issued later, with a token: the old row never presented it.
  recordIssuedSession(repo.cwd, "lead-1", "lead-1:verifier-v1");
  const unbound = await run(["pr", "merge", "--json"], repo.cwd);
  expect(unbound.json().error).toContain("unbound_session");
  expect(writes(runner.calls)).toEqual([]);
});

const issuedFlags = (cwd: string, lead: string, id: string): string[] => [
  "--session",
  id,
  "--token",
  recordIssuedSession(cwd, lead, id) ?? "",
];
for (const [label, argv, env] of [
  [
    "a host-issued Claude Code subagent id (--session and --token)",
    (cwd: string) => issuedFlags(cwd, "lead-2", "lead-2:agent-3"),
    { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead-2" },
  ],
  [
    "a host-issued Codex agent id (--session and --token)",
    (cwd: string) => issuedFlags(cwd, "thread-9", "thread-9:agent-4"),
    { CODEX_THREAD_ID: "thread-9" },
  ],
  ["Codex --as verifier", () => ["--as", "verifier"], { CODEX_THREAD_ID: "thread-9" }],
  [
    "an OpenCode child session (its own shell)",
    () => [],
    {
      WORKIT_HOST: "opencode",
      OPENCODE_SESSION_ID: "child-9",
      WORKIT_SESSION_ID: "lead-O:child-9",
    },
  ],
  [
    "a Pi worker (its own shell)",
    () => [],
    { WORKIT_HOST: "pi", PI_SESSION_ID: "w-1", WORKIT_SESSION_ID: "lead-P:w-1" },
  ],
  ["a Cursor verifier (declared id)", () => [], { WORKIT_SESSION_ID: "lead-C:verifier-ab12" }],
  ["CI --session (no host)", () => ["--session", "ci-verifier"], {}],
] as const)
  test(`Given ${label}, When the verdict is recorded and pr merge runs, Then the gate line says accepted and it merges`, async () => {
    const { repo } = setup();
    const recorded = await run(
      ["ledger", "verdict", "verified", "--how", "drove it", ...argv(repo.cwd)],
      repo.cwd,
      { ...env },
    );
    expect(recorded.code, recorded.stdout).toBe(0);
    expect(recorded.stdout).toContain("gate: feature/x accepted");
    const merged = await run(["pr", "merge", "--json"], repo.cwd);
    expect(merged.code, merged.stdout).toBe(0);
  });

test("Given the forge accepts the merge, When every post-merge read fails, Then pr.merged (verified:false) is already recorded and pr status and verify-delivery merged see the merge", async () => {
  const { repo, after } = setup({ value: "failing" });
  expect(
    (
      await run(["ledger", "verdict", "verified", "--how", "ok"], repo.cwd, {
        WORKIT_SESSION_ID: "reviewer-2",
      })
    ).code,
  ).toBe(0);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.json().error).toContain("merge_unverified");
  const [row] = rows(repo.cwd, "pr.merged");
  expect(row).toMatchObject({
    observer: "workit_cli",
    pr: 12,
    head: repo.head,
    mergeSha: repo.base,
    verified: false,
  });
  expect(result.json().error).toContain(row.id);
  expect(result.json().data).toEqual({ recorded: { id: row.id } });
  expect(rows(repo.cwd, "pr.merge.verified")).toEqual([]);
  // The forge recovers: the merge is workit's, not "merged outside workit".
  after.value = "merged";
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict.merge).toMatchObject({ head: repo.head });
  repo.git("push", "-q", path.join(repo.root, "remote.git"), `${repo.base}:refs/heads/main`);
  const delivered = await run(["verify-delivery", "merged", "--pr", "12", "--json"], repo.cwd);
  expect(delivered.code).toBe(0);
  expect(delivered.json().data.observations).toContainEqual(
    expect.objectContaining({ kind: "merge_on_base", expected: repo.base, ok: true }),
  );
});

test("Given the forge accepts the merge, When the post-merge read confirms it, Then pr.merge.verified references the pr.merged row", async () => {
  const { repo } = setup();
  expect(
    (
      await run(["ledger", "verdict", "verified", "--how", "ok"], repo.cwd, {
        WORKIT_SESSION_ID: "reviewer-2",
      })
    ).code,
  ).toBe(0);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  const [merged] = rows(repo.cwd, "pr.merged");
  expect(result.json().data.recorded).toEqual({ id: merged.id });
  expect(rows(repo.cwd, "pr.merge.verified")).toEqual([
    expect.objectContaining({ merged: merged.id, pr: 12, mergeSha: repo.base }),
  ]);
});

const claude = (session = "lead-A") => ({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: session });

test("Given an issued reviewer id read in the ledger, When the lead records under it without the token (with or without --supersedes), Then it is refused as unbound_session and nothing merges (P1)", async () => {
  const { repo, runner } = setup();
  const token = recordIssuedSession(repo.cwd, "lead-A", "lead-A:rev-1") ?? "";
  const failed = await run(
    [
      "ledger",
      "verdict",
      "failed",
      "--how",
      "bad",
      "--session",
      "lead-A:rev-1",
      "--token",
      token,
      "--json",
    ],
    repo.cwd,
    claude(),
  );
  expect(failed.code, failed.stdout).toBe(0);
  const failure = failed.json().data.id as string;
  for (const extra of [[], ["--supersedes", failure], ["--token", "guessed"]]) {
    const reused = await run(
      [
        "ledger",
        "verdict",
        "verified",
        "--how",
        "lgtm",
        "--session",
        "lead-A:rev-1",
        ...extra,
        "--json",
      ],
      repo.cwd,
      claude(),
    );
    expect(reused.code, JSON.stringify(extra)).toBe(3);
    expect(reused.json().error).toContain("unbound_session");
  }
  const merge = await run(["pr", "merge", "--json"], repo.cwd, claude());
  expect(merge.code).toBe(3);
  expect(writes(runner.calls)).toEqual([]);
});

test("Given a reviewer's issued id, When a commit is made under it through workit git commit (an empty amend), Then it is refused: a judge id never authors (P2b)", async () => {
  const { repo } = setup();
  recordIssuedSession(repo.cwd, "lead-A", "lead-A:rev-2");
  const amend = await run(["git", "commit", "--amend", "--no-edit", "--json"], repo.cwd, {
    ...claude("lead-A:rev-2"),
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@b",
  });
  expect(amend.code, amend.stdout).toBe(3);
  expect(amend.json().error).toContain("judge_session");
  expect(rows(repo.cwd, "commit.recorded")).toEqual([]);
});

for (const [label, argv, env, error] of [
  ["its own Claude Code session", ["--session", "lead-A"], claude(), "session_flag"],
  [
    "an OpenCode child's own session",
    ["--session", "lead-O:child-9"],
    {
      WORKIT_HOST: "opencode",
      OPENCODE_SESSION_ID: "child-9",
      WORKIT_SESSION_ID: "lead-O:child-9",
    },
    "session_flag",
  ],
  [
    "a Pi worker's own session",
    ["--session", "lead-P:w-1"],
    { WORKIT_HOST: "pi", PI_SESSION_ID: "w-1", WORKIT_SESSION_ID: "lead-P:w-1" },
    "session_flag",
  ],
  [
    "a Codex thread's own id",
    ["--session", "thread-9"],
    { CODEX_THREAD_ID: "thread-9" },
    "session_flag",
  ],
  [
    "an unissued <lead>:<x> id from the environment under WORKIT_HOST=cursor (P5)",
    [],
    { WORKIT_HOST: "cursor", WORKIT_SESSION_ID: "lead-A:nobody" },
    "forged_session",
  ],
] as const)
  test(`Given ${label}, When a verdict is recorded, Then it is refused at record time (${error}), not read as unissued later`, async () => {
    const { repo } = setup();
    const recorded = await run(
      ["ledger", "verdict", "verified", "--how", "x", ...argv, "--json"],
      repo.cwd,
      { ...env },
    );
    expect(recorded.code, recorded.stdout).toBe(3);
    expect(recorded.json().error).toContain(error);
    expect(rows(repo.cwd, "verdict")).toEqual([]);
  });

test("Given a verdict the gate does not accept (the author's own), When it is recorded, Then the output names the gate's reading and why", async () => {
  const { repo } = setup();
  const own = await run(["ledger", "verdict", "verified", "--how", "mine", "--self"], repo.cwd);
  expect(own.code).toBe(0);
  expect(own.stdout).toContain("gate: feature/x not accepted (self)");
  const json = await run(
    ["ledger", "verdict", "verified", "--how", "mine", "--self", "--json"],
    repo.cwd,
  );
  expect(json.json().data.gate).toMatchObject({ accepted: false, reasons: ["self"] });
});

test("Given an accepted verdict, When the forge merges but the merge call itself fails, Then the merge intent recorded before it lets pr status see a workit merge", async () => {
  const { repo } = setup({ value: "merged" }, { mergeCallFails: true });
  expect(
    (
      await run(["ledger", "verdict", "verified", "--how", "ok"], repo.cwd, {
        WORKIT_SESSION_ID: "reviewer-2",
      })
    ).code,
  ).toBe(0);
  const merge = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merge.code).not.toBe(0);
  const [intent] = rows(repo.cwd, "pr.merge.intent");
  expect(intent).toMatchObject({ observer: "workit_cli", pr: 12, head: repo.head });
  expect(merge.json().error).toContain(intent.id);
  expect(rows(repo.cwd, "pr.merged")).toEqual([]);
  const status = await run(["pr", "status"], repo.cwd);
  expect(status.stdout).toContain("merge intent recorded");
  expect(status.stdout).not.toContain("merged outside workit");
});

test("Given a merged PR, When the only pr.merged row was appended by hand, Then pr status reads it as merged outside workit (M21)", async () => {
  const { repo } = setup({ value: "merged" });
  // The PR reads merged on the forge from the start.
  Object.assign(forgeDeps, {
    runner: replayRunner(
      {
        "GET user": fixture("github/user.json"),
        "GET repos/o/r": fixture("github/repo.json"),
        "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
        "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
        "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
        "graphql find": fixture("github/find-pr.json"),
        [GH_STATUS]: fixture("github/pr-merged.json"),
      },
      repo.subs,
    ),
  });
  expect(
    (await run(["ledger", "verdict", "verified", "--how", "mine", "--self"], repo.cwd)).code,
  ).toBe(0);
  const file = ledgerPath(repo.cwd);
  if (!file.ok) throw new Error(file.error);
  appendFileSync(
    file.value,
    `${JSON.stringify({ v: 1, id: "forged-merge", at: new Date().toISOString(), type: "pr.merged", observer: "workit_cli", branch: "feature/x", head: repo.head, pr: 12, base: "main", verdictId: "made-up", actor: { host: "cli", session: "x", agentId: null } })}\n`,
  );
  const status = await run(["pr", "status"], repo.cwd);
  expect(status.stdout).toContain("merged outside workit (no merge record)");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Given an accepted verdict, When the merge intent cannot be recorded, Then nothing is merged (intent_unrecorded, R07)",
  async () => {
    const { repo, runner } = setup();
    expect(
      (
        await run(["ledger", "verdict", "verified", "--how", "ok"], repo.cwd, {
          WORKIT_SESSION_ID: "reviewer-2",
        })
      ).code,
    ).toBe(0);
    const file = ledgerPath(repo.cwd);
    if (!file.ok) throw new Error(file.error);
    chmodSync(file.value, 0o400);
    try {
      const merge = await run(["pr", "merge", "--json"], repo.cwd);
      expect(merge.code).toBe(3);
      expect(merge.json()).toMatchObject({ data: { reason: "intent_unrecorded" } });
      expect(writes(runner.calls)).toEqual([]);
    } finally {
      chmodSync(file.value, 0o600);
    }
  },
);

test("Given a hand-minted <lead>:<x> id in a Claude Code shell, When workit git commit runs, Then it is refused and the unblock talks about commits", async () => {
  const { repo } = setup();
  writeFileSync(path.join(repo.cwd, "y.txt"), "y\n");
  const commit = await run(
    ["git", "commit", "-m", "chore: y", "--json", "--", "y.txt"],
    repo.cwd,
    claude("lead-A:nobody"),
  );
  expect(commit.code, commit.stdout).toBe(3);
  expect(commit.json().error).toContain("forged_session");
  expect(commit.json().unblock).toContain("commit");
  expect(commit.json().unblock).not.toContain("verdict");
});
