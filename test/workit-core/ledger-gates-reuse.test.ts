// Adversarial review mv83zyg6 of the verdict gates: an issued id reused by
// another session, a failing reviewer made an author afterwards, rows
// deleted or moved, and the gate behaviors the first round left untested
// (mutants M12, M14, M16, M22, M32).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import {
  appendObserved,
  checkVerdicts,
  ledgerPath,
  readLedger,
  recordVerdict,
  type LedgerResult,
  type SessionSource,
} from "@/packages/workit-core/src/ledger";
import { useConfigHome } from "@/test/shared/grant-home";
import { fixture } from "./hooks/hook-fixtures";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-reuse-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "feature.txt"), "feature\n");
  git(root, "add", "feature.txt");
  git(root, "commit", "-qm", "feature work");
  return root;
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};
const check = (root: string) =>
  checkVerdicts(root, "feature/x", value(readLedger(root, { integrity: true })).rows);
const by = (
  root: string,
  session: string,
  options: { host?: string; source?: SessionSource; bound?: boolean; supersedes?: string } = {},
) => ({
  cwd: root,
  actor: { host: options.host ?? "cli", session, agentId: null },
  ...(options.source ? { sessionSource: options.source } : {}),
  ...(options.bound ? { sessionBound: true } : {}),
  ...(options.supersedes ? { supersedes: options.supersedes } : {}),
});
const head = (root: string) => git(root, "rev-parse", "HEAD");
const file = (root: string) => value(ledgerPath(root));
const lines = (root: string) => readFileSync(file(root), "utf8").split("\n").filter(Boolean);
const put = (root: string, rows: string[]) =>
  writeFileSync(file(root), rows.map((line) => `${line}\n`).join(""));
const forged = (root: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ v: 1, id: `forged-${Math.random().toString(36).slice(2)}`, at: new Date().toISOString(), type: "verdict", kind: "review", result: "verified", how: "x", branch: "feature/x", head: head(root), observer: "agent_asserted", self: false, selfReason: null, sessionSource: "env", actor: { host: "cli", session: "totally-independent", agentId: null }, ...extra })}`;

/** A verdict by an issued Claude Code subagent that presented its token. */
const judged = (root: string, session: string, result: string, supersedes?: string) =>
  value(
    recordVerdict(
      by(root, session, { host: "claude_code", source: "flag", bound: true, supersedes }),
      {
        result,
        how: `${session} judged`,
      },
    ),
  );

test("Given an issued reviewer's failure, When another session records a pass under that id without its token and supersedes the failure, Then the link is ignored and the failure still blocks (P1)", () => {
  const root = featureRepo();
  recordIssuedSession(root, "lead-A", "lead-A:rev-1");
  const failure = judged(root, "lead-A:rev-1", "failed");
  // An older CLI, or the ledger API, takes the same session's supersede.
  value(
    recordVerdict(
      by(root, "lead-A:rev-1", { host: "claude_code", source: "flag", supersedes: failure.id }),
      { result: "verified", how: "lgtm" },
    ),
  );
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  expect(result.accepted.verdict?.id).toBe(failure.id);
});

test("Given an independent failure, When its reviewer later becomes an author (a chained commit.recorded under its id), Then the failure still blocks (P2b)", () => {
  const root = featureRepo();
  recordIssuedSession(root, "lead-A", "lead-A:ver-1");
  recordIssuedSession(root, "lead-A", "lead-A:rev-2");
  judged(root, "lead-A:ver-1", "verified");
  judged(root, "lead-A:rev-2", "failed");
  value(
    appendObserved(root, {
      type: "commit.recorded",
      actor: { host: "claude_code", session: "lead-A:rev-2", agentId: null },
      session: "lead-A:rev-2",
      branch: "feature/x",
      head: head(root),
      sha: head(root),
    }),
  );
  const result = check(root);
  expect(result.authors).toContain("lead-A:rev-2");
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
});

test("Given an author before the failure, When that author records a failure (not --self, by an older CLI), Then it is the author's own and does not block an independent pass", () => {
  const root = featureRepo();
  value(
    appendObserved(root, {
      type: "commit.recorded",
      actor: { host: "cli", session: "author", agentId: null },
      session: "author",
      branch: "feature/x",
      head: head(root),
    }),
  );
  value(recordVerdict(by(root, "v1"), { result: "verified", how: "fine" }));
  // recordVerdict refuses an author's independent verdict; an older CLI did not.
  const lines0 = lines(root);
  expect(lines0).toHaveLength(2);
  const blocked = recordVerdict(by(root, "author"), { result: "failed", how: "mine" });
  expect(blocked.ok).toBe(false);
  expect(check(root).accepted.accepted).toBe(true);
});

for (const [label, mutate] of [
  [
    "the failure row is deleted from the middle (P3)",
    (rows: string[]) => rows.filter((line) => !line.includes('"result":"failed"')),
  ],
  [
    "the earlier pass is moved after the failure (P4)",
    (rows: string[]) => {
      const pass = rows.findIndex((line) => line.includes('"result":"verified"'));
      return [...rows.filter((_, i) => i !== pass), rows[pass]];
    },
  ],
] as const)
  test(`Given a pass, a failure and a later row, When ${label}, Then every gate refuses: ledger_tampered`, () => {
    const root = featureRepo();
    value(recordVerdict(by(root, "v1"), { result: "verified", how: "fine" }));
    value(recordVerdict(by(root, "v2"), { result: "failed", how: "broken" }));
    value(
      recordVerdict(
        { ...by(root, "s"), branch: "main" },
        { result: "verified", how: "spacer", self: true },
      ),
    );
    put(root, mutate(lines(root)));
    const result = check(root);
    expect(result.accepted).toMatchObject({ accepted: false, reasons: ["ledger_tampered"] });
    expect(result.warnings.join("\n")).toContain("workit ledger verify-integrity");
    expect(result.warnings.join("\n")).toContain(".tampered-");
    // The cache never hides a later edit, nor a repair.
    put(root, []);
    expect(check(root).accepted.reasons).toEqual(["no_verdict"]);
  });

test("Given the author's self verdict, When a pass acting as an unissued session follows, Then the branch still reads self-reviewed with the author's own verdict (M14)", () => {
  const root = featureRepo();
  const own = value(
    recordVerdict(by(root, "author"), { result: "tests-verified", how: "suite", self: true }),
  );
  value(
    recordVerdict(by(root, "lead-Z:invented", { host: "claude_code", source: "flag" }), {
      result: "verified",
      how: "x",
    }),
  );
  const result = check(root);
  expect(result.review).toBe("self-reviewed");
  expect(result.selfVerdict?.id).toBe(own.id);
});

test("Given a forged pass first, When the author's own self verdict follows, Then the branch reads self-reviewed (M32)", () => {
  const root = featureRepo();
  value(
    appendObserved(root, {
      type: "commit.recorded",
      actor: { host: "cli", session: "author", agentId: null },
      session: "author",
      branch: "feature/x",
      head: head(root),
    }),
  );
  put(root, [forged(root), ...lines(root)]);
  const own = value(
    recordVerdict(by(root, "author"), { result: "tests-verified", how: "suite", self: true }),
  );
  const result = check(root);
  expect(result.review).toBe("self-reviewed");
  expect(result.selfVerdict?.id).toBe(own.id);
});

test("Given an accepted pass, When a forged failure follows, Then no author's-own warning names it (M12)", () => {
  const root = featureRepo();
  value(recordVerdict(by(root, "v1"), { result: "verified", how: "fine" }));
  put(root, [...lines(root), forged(root, { result: "failed" })]);
  const result = check(root);
  expect(result.accepted.accepted).toBe(true);
  expect(result.warnings.join("\n")).not.toContain("author's own");
});

test("Given a Claude Code author's self verdict under a <lead>:<x> id no hook issued, When checked, Then it still reads self-reviewed (a self verdict is not checked for issuance, M16)", () => {
  const root = featureRepo();
  const own = value(
    recordVerdict(by(root, "lead-A:impl", { host: "claude_code", source: "env" }), {
      result: "tests-verified",
      how: "suite",
      self: true,
    }),
  );
  const result = check(root);
  expect(result.review).toBe("self-reviewed");
  expect(result.selfVerdict?.id).toBe(own.id);
});

test("Given this session delivered a PR, When a hand-appended pr.merged row claims its head landed, Then the stop hook still owes a verdict (M22)", () => {
  const home = useConfigHome("wk-reuse-home-");
  try {
    const root = featureRepo();
    writeFileSync(
      path.join(home.configDir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
      }),
    );
    writeFileSync(
      path.join(home.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "w",
            glob: `${root.replaceAll("\\", "/")}/**`,
            vcs: { provider: "github", account: "octo" },
            autonomy: { push: true, pr: true, merge: "verified" },
            defaultEndpoint: "pr",
          },
        ],
      }),
    );
    value(
      appendObserved(root, {
        type: "pr.created",
        actor: { host: "claude_code", session: "s-lead", agentId: null },
        branch: "feature/x",
        head: head(root),
        pr: 8,
        base: "main",
        created: true,
      }),
    );
    put(root, [
      ...lines(root),
      JSON.stringify({
        v: 1,
        id: "forged-merge",
        at: new Date().toISOString(),
        type: "pr.merged",
        observer: "workit_cli",
        branch: "feature/x",
        head: head(root),
        pr: 8,
        base: "main",
        mergeSha: "f".repeat(40),
        actor: { host: "claude_code", session: "s-lead", agentId: null },
      }),
    ]);
    const stop = dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "stop", root, { session_id: "s-lead" }),
    ).json as { reason?: string };
    expect(stop.reason).toContain("has no current verdict");
  } finally {
    home.restore();
  }
});
