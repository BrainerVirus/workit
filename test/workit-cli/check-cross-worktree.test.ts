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

// ---------------------------------------------------------------------------
// a verdict after the head moved past its session's checks

const actor = (session: string): LedgerActor => ({ host: "cli", session, agentId: null });

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
  writeFileSync(path.join(root, "feature.txt"), "one\n");
  git(root, "add", "feature.txt");
  git(root, "commit", "-qm", "feature work");
  return root;
};
const commit = (root: string, text: string) => {
  writeFileSync(path.join(root, "feature.txt"), text);
  git(root, "add", "feature.txt");
  git(root, "commit", "-qm", text.trim());
  return git(root, "rev-parse", "HEAD");
};
const checkRow = (root: string, session: string, head: string) => {
  const appended = appendObserved(root, {
    type: "check",
    actor: actor(session),
    branch: "feature/x",
    head,
    tree: null,
    dirty: false,
    checkout: root,
    name: "test",
    configured: true,
    result: "passed",
  });
  if (!appended.ok) throw new Error(appended.error);
  return String(appended.value.id);
};
const verdict = (root: string, session: string, evidenceRefs?: string[]) =>
  recordVerdict(
    { cwd: root, actor: actor(session) },
    { result: "failed", how: "ran the checks", ...(evidenceRefs ? { evidenceRefs } : {}) },
  );

test("Given a session's checks ran on one head, When the branch moves and that session records a verdict, Then it is refused naming both SHAs", () => {
  const root = featureRepo();
  const tested = git(root, "rev-parse", "HEAD");
  checkRow(root, "s-verifier", tested);
  const moved = commit(root, "two\n");
  const result = verdict(root, "s-verifier");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("blocked");
  expect(result.error).toContain(tested.slice(0, 12));
  expect(result.error).toContain(moved.slice(0, 12));
  expect(result.error).toContain("head_moved");
});

test("Given a verdict naming a check row on an older head as --evidence, Then it is refused naming both SHAs", () => {
  const root = featureRepo();
  const tested = git(root, "rev-parse", "HEAD");
  const row = checkRow(root, "s-other", tested);
  const moved = commit(root, "two\n");
  const result = verdict(root, "s-verifier", [row]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(tested.slice(0, 12));
  expect(result.error).toContain(moved.slice(0, 12));
});

test("Given the session checked the current head too, or no check of its own at all, Then the verdict records on that head", () => {
  const root = featureRepo();
  checkRow(root, "s-verifier", git(root, "rev-parse", "HEAD"));
  const moved = commit(root, "two\n");
  checkRow(root, "s-verifier", moved);
  const recorded = verdict(root, "s-verifier");
  expect(recorded.ok && recorded.value.head).toBe(moved);
  const fresh = verdict(root, "s-reviewer");
  expect(fresh.ok && fresh.value.head).toBe(moved);
});
