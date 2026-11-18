// Retro 2026-11-17 C20: a `workit check` in one worktree never reports,
// records or takes another worktree's run as its own, even when both share one
// session id and one check name; and a verdict is not keyed to a head its
// session never checked when the branch moved after its checks ran.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendObserved,
  readLedger,
  recordVerdict,
  type LedgerActor,
} from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const until = async (done: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** One repo, worktrees A and B, one heavy check `slow` that fails where `fail-here` exists. */
const twoWorktrees = () => {
  const base = temp("wk-xwt-");
  const repo = path.join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Workit Test");
  git(repo, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(repo, ".workit"));
  writeFileSync(
    path.join(repo, ".workit", "checks.json"),
    JSON.stringify({
      checks: {
        slow: [
          BUN,
          "-e",
          "console.log('RAN-IN', process.cwd(), 'pid', process.pid); setTimeout(() => process.exit(require('fs').existsSync('fail-here') ? 7 : 0), 1500)",
        ],
      },
      resources: { heavy: ["slow"] },
    }),
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const a = path.join(base, "A");
  const b = path.join(base, "B");
  git(repo, "worktree", "add", "-q", "-b", "feature/a", a);
  git(repo, "worktree", "add", "-q", "-b", "feature/b", b);
  writeFileSync(path.join(b, "fail-here"), "");
  const state = temp("wk-xwt-state-");
  const config = temp("wk-xwt-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "here", glob: "**", resources: { scope: false, pressure: false, slots: 1 } },
      ],
    }),
  );
  // One session id for both runs: subagents share the lead's WORKIT_SESSION_ID.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-shared",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { repo, a, b, env, leases: path.join(state, "leases") };
};

const start = (cwd: string, env: NodeJS.ProcessEnv) => {
  const child = spawn(BUN, [MAIN, "check", "--json", "--cwd", cwd, "slow"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
};

test("Given two worktrees, one session id and `slow` running in B, When `workit check --cwd A slow` starts, Then A runs its own process and records and prints only A's run", async () => {
  const { a, b, env, leases } = twoWorktrees();
  const inB = start(b, env);
  await until(() => existsSync(path.join(leases, "slot-0.json")));
  const inA = start(a, env);
  const [runB, runA] = await Promise.all([inB.done, inA.done]);
  expect(runB.code, runB.stderr).toBe(7);
  expect(runA.code, runA.stderr).toBe(0);
  const dataA = JSON.parse(runA.stdout).data;
  const dataB = JSON.parse(runB.stdout).data;

  // A waited behind B, and says that B is another checkout's run, not its own.
  expect(dataA.lease.waitedMs).toBeGreaterThan(0);
  expect(dataA.lease.holder).toMatchObject({ cwd: b, session: "s-shared" });
  expect(runA.stderr).toContain(`another checkout's run (${b}), not this check's`);

  // A's own process, in A, on A's code.
  expect(dataA.checkout).toBe(a);
  expect(dataA.pid).toBe(inA.child.pid);
  expect(dataA.exitCode).toBe(0);
  expect(dataA.logTail.join("\n")).toContain(`RAN-IN ${a}`);
  expect(dataA.logTail.join("\n")).not.toContain(b);
  expect(dataA.head).toBe(git(a, "rev-parse", "HEAD"));
  expect(dataB.checkout).toBe(b);
  expect(dataB.tree).not.toBe(dataA.tree);

  // The ledger rows (one ledger for both worktrees) name the checkout each ran in.
  const ledger = readLedger(a);
  if (!ledger.ok) throw new Error(ledger.error);
  const rowA = ledger.value.rows.find((row) => row.id === dataA.ledgerRowId);
  const rowB = ledger.value.rows.find((row) => row.id === dataB.ledgerRowId);
  expect(rowA).toMatchObject({
    checkout: a,
    branch: "feature/a",
    head: dataA.head,
    tree: dataA.tree,
    result: "passed",
  });
  expect(rowB).toMatchObject({ checkout: b, branch: "feature/b", result: "failed" });
}, 60_000);

test("Given a check run, Then its summary line names the checkout and head it ran on", async () => {
  const { a, env } = twoWorktrees();
  const child = spawnSync(BUN, [MAIN, "check", "--cwd", a, "slow"], { env, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  const head = git(a, "rev-parse", "HEAD");
  expect(child.stderr).toContain(`ran in ${a} @ ${head.slice(0, 12)}`);
}, 30_000);

test("Given a worktree nested inside this checkout holds the lease, Then the wait line names it as another checkout's run", async () => {
  const { repo, env, leases } = twoWorktrees();
  const nested = path.join(repo, ".claude", "worktrees", "x");
  git(repo, "worktree", "add", "-q", "-b", "feature/nested", nested);
  const inNested = start(nested, env);
  await until(() => existsSync(path.join(leases, "slot-0.json")));
  const inRepo = start(repo, env);
  const [, runRepo] = await Promise.all([inNested.done, inRepo.done]);
  expect(runRepo.code, runRepo.stderr).toBe(0);
  expect(runRepo.stderr).toContain(`another checkout's run (${nested}), not this check's`);
  expect(JSON.parse(runRepo.stdout).data.checkout).toBe(repo);
}, 60_000);

// ---------------------------------------------------------------------------
// a verdict after the head moved past its session's checks

const actor = (session: string, agentId: string | null = null): LedgerActor => ({
  host: "cli",
  session,
  agentId,
});

const featureRepo = () => {
  const root = temp("wk-xwt-verdict-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 1;\n");
  git(root, "add", "src/app.ts");
  git(root, "commit", "-qm", "feature work");
  return root;
};
const headOf = (root: string) => git(root, "rev-parse", "HEAD");
/** Commit `text` to `file` on the branch; returns the new head. */
const commit = (root: string, file: string, text: string) => {
  writeFileSync(path.join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-qm", `edit ${file}`);
  return headOf(root);
};
const codeChange = (root: string) => commit(root, "src/app.ts", "export const answer = 2;\n");
/** A `workit check` row as the CLI writes it: env session S, agent id from WORKIT_AGENT_ID. */
const checkRow = (
  root: string,
  who: { session: string; agent?: string | null },
  head: string,
  extra: Record<string, unknown> = {},
) => {
  const appended = appendObserved(root, {
    type: "check",
    actor: actor(who.session, who.agent ?? null),
    branch: "feature/x",
    head,
    base: "main",
    baseSha: git(root, "rev-parse", "main"),
    tree: null,
    dirty: false,
    checkout: root,
    name: "test",
    configured: true,
    result: "passed",
    ...extra,
  });
  if (!appended.ok) throw new Error(appended.error);
  return String(appended.value.id);
};
const verdict = (
  root: string,
  session: string,
  options: {
    result?: string;
    self?: boolean;
    refs?: string[];
    checkEvidence?: { name: string; status: string; via: string | null }[];
  } = {},
) =>
  recordVerdict(
    { cwd: root, actor: actor(session) },
    {
      result: options.result ?? "verified",
      how: "ran the checks",
      ...(options.self ? { self: true } : {}),
      ...(options.refs ? { evidenceRefs: options.refs } : {}),
      ...(options.checkEvidence ? { checkEvidence: options.checkEvidence } : {}),
    },
  );
const refusedNaming = (result: ReturnType<typeof verdict>, ...shas: string[]) => {
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.code).toBe("blocked");
  expect(result.error).toContain("head_moved");
  for (const sha of shas) expect(result.error).toContain(sha.slice(0, 12));
  return result.error;
};
const recordedOn = (result: ReturnType<typeof verdict>) =>
  result.ok ? result.value.head : `refused: ${result.error}`;

test("Given a session's checks ran on one head, When a code change lands and it records verified or tests-verified, Then each is refused naming both SHAs and the changed file", () => {
  const root = featureRepo();
  const tested = headOf(root);
  checkRow(root, { session: "s-verifier" }, tested);
  const moved = codeChange(root);
  for (const result of ["verified", "tests-verified"]) {
    const error = refusedNaming(verdict(root, "s-verifier", { result }), tested, moved);
    expect(error).toContain("src/app.ts");
  }
});

test("Given the head moved past a session's checks, When it records failed or blocked, Then they record (and so does --self): only an independent passing claim is held to its checks' head", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-verifier" }, headOf(root));
  const moved = codeChange(root);
  expect(recordedOn(verdict(root, "s-verifier", { result: "failed" }))).toBe(moved);
  expect(recordedOn(verdict(root, "s-verifier", { result: "blocked" }))).toBe(moved);
  // A --self verdict is never accepted; it keeps its no-passing-test warning instead.
  expect(recordedOn(verdict(root, "s-verifier", { self: true }))).toBe(moved);
});

test("Given a session's checks ran on one head, When only a CHANGELOG commit lands after them, Then the verdict records on the new head (it carries)", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-verifier" }, headOf(root));
  const moved = commit(root, "CHANGELOG.md", "# Changelog\n\n- fixed a thing\n");
  expect(recordedOn(verdict(root, "s-verifier"))).toBe(moved);
});

test("Given a derived verifier session S:a, Then it is held to the runs its agent made (session S, agent a), never to the lead's or another agent's", () => {
  const root = featureRepo();
  const tested = headOf(root);
  checkRow(root, { session: "s-lead", agent: "a1" }, tested);
  const moved = codeChange(root);
  // The lead's own run and another agent's run on the new head clear nothing for a1.
  checkRow(root, { session: "s-lead" }, moved);
  checkRow(root, { session: "s-lead", agent: "a2" }, moved);
  refusedNaming(verdict(root, "s-lead:a1"), tested, moved);
  // Another agent of the same lead, with no run of its own, is not held to a1's runs.
  expect(recordedOn(verdict(root, "s-lead:a3"))).toBe(moved);
});

test("Given today's rows (no host stamps WORKIT_AGENT_ID, so a subagent's runs carry the lead's S and no agent id), When a derived verifier S:a records, Then it is not held by them (it records)", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-lead" }, headOf(root));
  const moved = codeChange(root);
  expect(recordedOn(verdict(root, "s-lead:a1"))).toBe(moved);
});

test("Given today's rows, When the lead's plain session S records, Then it is held to the runs shared under S and any clean configured run on the head in S clears them", () => {
  const root = featureRepo();
  const tested = headOf(root);
  // Two subagents' runs: both stamped with the lead's session and no agent id.
  checkRow(root, { session: "s-lead" }, tested);
  checkRow(root, { session: "s-lead" }, tested, { name: "lint" });
  const moved = codeChange(root);
  checkRow(root, { session: "s-lead" }, moved, { name: "lint" });
  refusedNaming(verdict(root, "s-lead"), tested, moved);
  checkRow(root, { session: "s-lead" }, moved);
  expect(recordedOn(verdict(root, "s-lead"))).toBe(moved);
});

test("Given a plain session S, Then its subagents' runs (session S with an agent id) are not its own", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-lead", agent: "a1" }, headOf(root));
  const moved = codeChange(root);
  expect(recordedOn(verdict(root, "s-lead"))).toBe(moved);
});

test("Given CI on the new head covered the check, Then the session's older run does not refuse the verdict", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-verifier" }, headOf(root));
  const moved = codeChange(root);
  const covered = verdict(root, "s-verifier", {
    checkEvidence: [{ name: "test", status: "fresh", via: "ci" }],
  });
  expect(recordedOn(covered)).toBe(moved);
});

test("Given the session ran each check on an older head, When only a trivial or ad-hoc run lands on the new head, Then it does not clear the configured check", () => {
  const root = featureRepo();
  const tested = headOf(root);
  checkRow(root, { session: "s-verifier" }, tested);
  checkRow(root, { session: "s-verifier" }, tested, { name: "lint" });
  const moved = codeChange(root);
  checkRow(root, { session: "s-verifier" }, moved, { name: null, configured: false });
  checkRow(root, { session: "s-verifier" }, moved, { configured: false });
  checkRow(root, { session: "s-verifier" }, moved, { name: "lint" });
  refusedNaming(verdict(root, "s-verifier"), tested, moved);
  // The configured run of `test` on the new head clears it.
  checkRow(root, { session: "s-verifier" }, moved);
  expect(recordedOn(verdict(root, "s-verifier"))).toBe(moved);
});

test("Given the session's run on the current head was on a dirty worktree, Then it is no evidence for the head", () => {
  const root = featureRepo();
  const head = headOf(root);
  checkRow(root, { session: "s-verifier" }, head, { dirty: true });
  const error = refusedNaming(verdict(root, "s-verifier"), head);
  expect(error).toContain("(dirty)");
});

test("Given --evidence names a check row on an older head, Then the verdict is refused naming both SHAs, unless a cited clean run of that check is on the head", () => {
  const root = featureRepo();
  const tested = headOf(root);
  const old = checkRow(root, { session: "s-other" }, tested);
  const moved = codeChange(root);
  refusedNaming(verdict(root, "s-verifier", { refs: [old] }), tested, moved);
  const fresh = checkRow(root, { session: "s-other" }, moved);
  expect(recordedOn(verdict(root, "s-verifier", { refs: [old, fresh] }))).toBe(moved);
});

test("Given the session checked the current head too, or no check of its own at all, Then the verdict records on that head", () => {
  const root = featureRepo();
  checkRow(root, { session: "s-verifier" }, headOf(root));
  const moved = codeChange(root);
  checkRow(root, { session: "s-verifier" }, moved);
  expect(recordedOn(verdict(root, "s-verifier"))).toBe(moved);
  expect(recordedOn(verdict(root, "s-reviewer"))).toBe(moved);
});
