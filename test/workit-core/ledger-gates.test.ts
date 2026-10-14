// Verdict gates read the ledger with its hash chain (audit 2026-10-13 N1,
// N13): a row appended or edited by hand, replayed, or acting as a session no
// hook issued is never an accepted independent verdict, and it cannot retire,
// discount or carry another row. Legitimate flows (host-issued subagent ids,
// --as, CI --session, chained rows from an older CLI) still pass.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import { useConfigHome } from "@/test/shared/grant-home";
import { fixture } from "./hooks/hook-fixtures";
import {
  appendObserved,
  appendRow,
  checkVerdicts,
  ledgerPath,
  readLedger,
  recordVerdict,
  type LedgerActor,
  type LedgerRead,
  type LedgerResult,
  type SessionSource,
} from "@/packages/workit-core/src/ledger";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-gates-"));
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
const read = (cwd: string): LedgerRead => value(readLedger(cwd, { integrity: true }));
const check = (root: string) => checkVerdicts(root, "feature/x", read(root).rows);
const actor = (session: string | null, host = "cli"): LedgerActor => ({
  host,
  session,
  agentId: null,
});
const by = (root: string, session: string, host = "cli", sessionSource?: SessionSource) => ({
  cwd: root,
  actor: actor(session, host),
  ...(sessionSource ? { sessionSource } : {}),
});
const head = (root: string) => git(root, "rev-parse", "HEAD");
const ledgerFile = (root: string) => value(ledgerPath(root));
const lines = (root: string) => readFileSync(ledgerFile(root), "utf8").split("\n").filter(Boolean);
const append = (root: string, row: Record<string, unknown>) =>
  appendFileSync(ledgerFile(root), `${JSON.stringify(row)}\n`);

/** The audit's forgery: one printf onto the ledger. */
const forgedVerdict = (root: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  id: `forged-${Math.random().toString(36).slice(2)}`,
  at: new Date().toISOString(),
  type: "verdict",
  kind: "review",
  result: "verified",
  how: "trust me",
  branch: "feature/x",
  head: head(root),
  observer: "agent_asserted",
  self: false,
  selfReason: null,
  sessionSource: "env",
  actor: { host: "cli", session: "totally-independent", agentId: null },
  ...extra,
});

/** Start the chain, so later hand-written rows read as unsigned. */
const chainStarted = (root: string) =>
  value(
    appendObserved(root, {
      type: "commit.recorded",
      actor: actor("author"),
      branch: "feature/x",
      session: "author",
      head: head(root),
    }),
  );

test("Given only a hand-appended verdict, When the branch is checked, Then it is not accepted and the reason is unsigned", () => {
  const root = featureRepo();
  chainStarted(root);
  append(root, forgedVerdict(root));
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["unsigned"] });
  expect(result.verdicts[0]).toMatchObject({ independent: false, accepted: false });
  // A forged pass is not the author's own verdict either.
  expect(result.review).toBe("unreviewed");
});

test("Given rows read without integrity, When a gate checks them, Then they are judged on the chain all the same", () => {
  const root = featureRepo();
  chainStarted(root);
  append(root, forgedVerdict(root));
  const plain = value(readLedger(root));
  expect(plain.rows.every((row) => row.integrity === undefined)).toBe(true);
  expect(checkVerdicts(root, "feature/x", plain.rows).accepted).toMatchObject({
    accepted: false,
    reasons: ["unsigned"],
  });
});

test("Given a pre-chain verdict prepended before the first chained row, When checked, Then it reads unsigned, not legacy-accepted", () => {
  const root = featureRepo();
  chainStarted(root);
  const file = ledgerFile(root);
  writeFileSync(file, `${JSON.stringify(forgedVerdict(root))}\n${readFileSync(file, "utf8")}`);
  expect(read(root).integrity?.legacy).toBe(1);
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["unsigned"] });
});

test("Given the author's self verdict edited by hand into an independent one, When checked, Then the reason is hash_mismatch", () => {
  const root = featureRepo();
  chainStarted(root);
  value(recordVerdict(by(root, "v9"), { result: "verified", how: "mine", self: true }));
  const file = ledgerFile(root);
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace('"self":true', '"self":false')
      .replace('"selfReason":"flag"', '"selfReason":null'),
  );
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["hash_mismatch"] });
});

test("Given a reviewer's independent failure, When an earlier pass by another reviewer is replayed at the end, Then the failure still blocks (duplicate_id)", () => {
  const root = featureRepo();
  value(recordVerdict(by(root, "v1"), { result: "verified", how: "looked fine" }));
  value(recordVerdict(by(root, "v2"), { result: "failed", how: "it crashes" }));
  appendFileSync(ledgerFile(root), `${lines(root)[0]}\n`);
  expect(read(root).integrity?.unverified.map((row) => row.reason)).toEqual(["duplicate_id"]);
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
});

test("Given an independent failure, When a hand-appended row by the same session supersedes it, Then the link is ignored and the failure stands", () => {
  const root = featureRepo();
  const failure = value(recordVerdict(by(root, "v1"), { result: "failed", how: "bug" }));
  append(
    root,
    forgedVerdict(root, {
      supersedes: failure.id,
      actor: { host: "cli", session: "v1", agentId: null },
    }),
  );
  const ledger = read(root);
  expect(ledger.rows.find((row) => row.id === failure.id)?.superseded).toBe(false);
  expect(ledger.rows.at(-1)?.supersedeIgnored).toBe(true);
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  // Read without integrity too: the gate re-reads the chain.
  expect(checkVerdicts(root, "feature/x", value(readLedger(root)).rows).accepted.reasons).toEqual([
    "failing_verdict",
  ]);
});

test("Given a reviewer's pass and a later independent failure, When a hand-appended author row names the failing reviewer, Then the failure still blocks", () => {
  const root = featureRepo();
  value(recordVerdict(by(root, "v2"), { result: "verified", how: "fine for me" }));
  value(recordVerdict(by(root, "v1"), { result: "failed", how: "bug" }));
  append(root, {
    v: 1,
    id: "forged-author",
    at: new Date().toISOString(),
    type: "commit.recorded",
    observer: "workit_cli",
    branch: "feature/x",
    head: head(root),
    session: "v1",
    actor: { host: "cli", session: "v1", agentId: null },
  });
  const result = check(root);
  expect(result.authors).toContain("v1");
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
});

test("Given an accepted pass on an older head, When a hand-appended stack.restacked row links it to new code, Then the pass does not carry", () => {
  const root = featureRepo();
  const old = head(root);
  value(recordVerdict(by(root, "v1"), { result: "verified", how: "fine" }));
  writeFileSync(path.join(root, "feature.txt"), "changed behavior\n");
  git(root, "commit", "-qam", "unreviewed change");
  append(root, {
    v: 1,
    id: "forged-restack",
    at: new Date().toISOString(),
    type: "stack.restacked",
    observer: "workit_cli",
    branch: "feature/x",
    fromHead: old,
    head: head(root),
    patchEqual: true,
    actor: { host: "cli", session: "x", agentId: null },
  });
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given a --session verdict an older CLI recorded on Claude Code, When no SubagentStart issued the id, Then it is unissued_session until a hook issued it", () => {
  const root = featureRepo();
  value(
    recordVerdict(by(root, "lead-1:agent-7", "claude_code", "flag"), {
      result: "verified",
      how: "drove it",
    }),
  );
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["unissued_session"] });
  recordIssuedSession(root, "lead-1", "lead-1:agent-7");
  expect(check(root).accepted.accepted).toBe(true);
});

test("Given a hand-minted Claude Code child id in WORKIT_SESSION_ID, When checked, Then it is unissued_session; a bare --session on a host is too", () => {
  const root = featureRepo();
  value(
    recordVerdict(by(root, "lead-1:v1", "claude_code", "env"), { result: "verified", how: "x" }),
  );
  expect(check(root).accepted.reasons).toEqual(["unissued_session"]);
  const other = featureRepo();
  value(
    recordVerdict(by(other, "lead-1-v1", "codex_cli", "flag"), { result: "verified", how: "x" }),
  );
  expect(check(other).accepted.reasons).toEqual(["unissued_session"]);
});

test("Given the legitimate verdict flows, When checked, Then each is accepted", () => {
  // CI or a plain terminal: --session is a declaration (no host).
  const ci = featureRepo();
  value(recordVerdict(by(ci, "ci-verifier", "cli", "flag"), { result: "verified", how: "ci" }));
  expect(check(ci).accepted.accepted).toBe(true);
  // Codex --as verifier: a role id minted from the thread.
  const codex = featureRepo();
  value(
    recordVerdict(by(codex, "thread-9:verifier:0a1b2c3d", "codex_cli", "as"), {
      result: "verified",
      how: "codex",
      derivedFrom: "thread-9",
    }),
  );
  expect(check(codex).accepted.accepted).toBe(true);
  // A host-issued subagent id, by --session.
  const issued = featureRepo();
  recordIssuedSession(issued, "lead-2", "lead-2:agent-3");
  value(
    recordVerdict(by(issued, "lead-2:agent-3", "claude_code", "flag"), {
      result: "verified",
      how: "subagent",
    }),
  );
  expect(check(issued).accepted.accepted).toBe(true);
  // A chained row written by an older CLI (no sessionSource field yet).
  const older = featureRepo();
  value(
    appendRow(older, {
      type: "verdict",
      kind: "review",
      result: "verified",
      how: "older cli",
      surface: null,
      observer: "agent_asserted",
      self: false,
      selfReason: null,
      evidenceRefs: [],
      actor: actor("old-verifier", "claude_code"),
      branch: "feature/x",
      head: head(older),
      base: null,
      baseSha: null,
      patchId: null,
      diffHash: null,
      tree: null,
      dirty: false,
    } as never),
  );
  expect(check(older).accepted.accepted).toBe(true);
});

test("Given a forged pass and a legitimate independent pass, When checked, Then the legitimate one is accepted and the forged row only warns", () => {
  const root = featureRepo();
  const real = value(recordVerdict(by(root, "v1"), { result: "verified", how: "fine" }));
  append(root, forgedVerdict(root, { result: "failed" }));
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true });
  expect(result.accepted.verdict?.id).toBe(real.id);
  expect(result.warnings.join("\n")).toContain("unverified");
});

test("Given the author's own self verdict, When a forged pass is appended after it, Then the branch still reads self-reviewed with the author's verdict", () => {
  const root = featureRepo();
  const own = value(
    recordVerdict(by(root, "author"), { result: "tests-verified", how: "suite", self: true }),
  );
  append(root, forgedVerdict(root));
  const result = check(root);
  expect(result.review).toBe("self-reviewed");
  expect(result.selfVerdict?.id).toBe(own.id);
  expect(result.accepted.reasons).toEqual(["self"]);
});

test("Given a forged verdict, When `workit ledger verdict` reports the branch, Then it says not accepted (unsigned)", async () => {
  const root = featureRepo();
  chainStarted(root);
  append(root, forgedVerdict(root));
  let stdout = "";
  const io: Partial<Io> = {
    cwd: root,
    env: { ...process.env, WORKIT_SESSION_ID: "lead" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  expect(await main(["ledger", "verdict", "feature/x"], io)).toBe(0);
  expect(stdout).toContain("not accepted (unsigned)");
  expect(stdout).not.toMatch(/; accepted;/u);
});

test.skipIf(process.platform === "win32")(
  "Given a new ledger, When the first row is appended, Then the file is 0600; an older 0664 ledger is tightened on the next append",
  () => {
    const root = featureRepo();
    chainStarted(root);
    const file = ledgerFile(root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const older = featureRepo();
    mkdirSync(path.dirname(ledgerFile(older)), { recursive: true });
    writeFileSync(ledgerFile(older), "", { mode: 0o664 });
    spawnSync("chmod", ["664", ledgerFile(older)]);
    expect(statSync(ledgerFile(older)).mode & 0o777).toBe(0o664);
    chainStarted(older);
    expect(statSync(ledgerFile(older)).mode & 0o777).toBe(0o600);
  },
);

test("Given this session delivered a PR, When the only verdict on the head is hand-appended, Then the stop hook still owes a verdict", () => {
  const home = useConfigHome("wk-gates-home-");
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
        actor: actor("s-lead", "claude_code"),
        branch: "feature/x",
        head: head(root),
        pr: 8,
        base: "main",
        created: true,
      }),
    );
    const stop = () =>
      dispatchHook(
        claudeCodeAdapter,
        fixture("claude-code", "stop", root, { session_id: "s-lead" }),
      ).json as { decision?: string; reason?: string };
    expect(stop().reason).toContain("has no current verdict");
    append(root, forgedVerdict(root));
    expect(stop().reason).toContain("has no current verdict");
    value(
      recordVerdict(by(root, "s-verifier", "claude_code"), { result: "verified", how: "ran it" }),
    );
    expect(stop()).toEqual({});
  } finally {
    home.restore();
  }
});
