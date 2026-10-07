import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { success } from "@/packages/workit-core/src/forge/types";
import { pushPreflight } from "@/packages/workit-core/src/git/ops";
import { appendObserved, appendRow, readLedger } from "@/packages/workit-core/src/ledger";
import {
  readStack,
  stackDeps,
  stackFileName,
  stacksDir,
  writeStack,
} from "@/packages/workit-core/src/stack";
import { localLockHost, processStartOf } from "@/packages/workit-core/src/core/store-lock";
import { makeStackForge, type StackForge } from "@/test/shared/helpers/stack-forge";

// S12 `workit stack plan|status|sync|land` over a real bare remote and a
// stateful fake gh/glab (squash merges really land in the bare repo).

setDefaultTimeout(120_000);

const MAIN = path.resolve(import.meta.dir, "..", "..", "packages", "workit-cli", "src", "main.ts");

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const originalStack = { ...stackDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-stack-config-");
  configDir = configHome.configDir;
});
afterAll(() => {
  configHome.restore();
});

const forges: StackForge[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  Object.assign(stackDeps, originalStack);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const forge of forges.splice(0)) forge.cleanup();
});

const run = async (argv: string[], cwd: string, session = "lander-1") => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const setup = (
  kind: "github" | "gitlab",
  autonomy: Record<string, unknown> = { push: true, pr: true, merge: "verified" },
  branches?: string[],
) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const forge = makeStackForge(kind, branches);
  forges.push(forge);
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${forge.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: kind, account: "octo" },
          autonomy,
        },
      ],
    }),
  );
  Object.assign(forgeDeps, { runner: forge.runner, sleep: async () => {}, now: () => 0 });
  // The checkout's push URL names the forge; real pushes go to the bare remote.
  stackDeps.pushPlan = (cwd, branch) => {
    const plan = pushPreflight(cwd, { branch });
    return plan.ok
      ? success({ ...plan.data, remote: forge.bare, rawUrl: forge.bare, url: forge.bare })
      : plan;
  };
  forge.git("switch", "-q", (branches ?? ["feature/d"]).at(-1) as string);
  return forge;
};

const verdict = (forge: StackForge, branch: string) =>
  run(
    ["ledger", "verdict", "verified", "--how", "exercised the CLI", "--branch", branch, "--json"],
    forge.cwd,
    "reviewer-2",
  );

const plan = async (forge: StackForge) => {
  const result = await run(
    ["stack", "plan", "feature/a", "feature/b", "feature/c", "feature/d", "--json"],
    forge.cwd,
  );
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return result.json().data;
};

const isAncestor = (cwd: string, a: string, b: string) =>
  spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

// ---------------------------------------------------------------------------
// land (the spec acceptance), on both forges

for (const kind of ["github", "gitlab"] as const)
  test(`stack land (${kind}): given a 4-PR stack where PR1-2 are verified and READY and PR3 is unverified, with a merge grant, then only PR1 and PR2 merge in order, PR3 is restacked and retargeted onto main, and PR4 is untouched`, async () => {
    const forge = setup(kind);
    const planned = await plan(forge);
    expect(planned.stack.branches.map((entry: { pr: number }) => entry.pr)).toEqual([
      11, 12, 13, 14,
    ]);
    expect((await verdict(forge, "feature/a")).code).toBe(0);
    expect((await verdict(forge, "feature/b")).code).toBe(0);
    const d = forge.tip("feature/d");
    const ready = await run(["stack", "status", "--json"], forge.cwd);
    expect(ready.json().data).toMatchObject({ verdict: "READY", next: "workit stack land" });

    const result = await run(["stack", "land", "--json"], forge.cwd);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const data = result.json().data;
    expect(data.landed.map((item: { pr: number }) => item.pr)).toEqual([11, 12]);
    expect(data.stoppedAt).toMatchObject({ pr: 13, branch: "feature/c", reason: "no_verdict" });
    expect(data.retargeted).toEqual([12, 13]);
    expect(forge.writes).toEqual(["merge 11", "retarget 12 main", "merge 12", "retarget 13 main"]);
    // PR3 now sits on the trunk that holds both squashes; PR4 kept its base and head.
    const trunk = forge.tip("main") as string;
    expect(forge.prs.get(13)).toMatchObject({ base: "main", state: "open" });
    expect(isAncestor(forge.bare, trunk, forge.tip("feature/c") as string)).toBe(true);
    expect(forge.prs.get(14)?.base).toBe("feature/c");
    expect(forge.tip("feature/d")).toBe(d);
    expect(forge.prs.get(11)?.state).toBe("merged");
    expect(forge.prs.get(12)?.state).toBe("merged");
    // PR2's verdict carried through its restack (same change on the new base).
    expect(rows(forge.cwd, "stack.restacked")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "feature/b", patchEqual: true }),
        expect.objectContaining({ branch: "feature/c", patchEqual: true }),
      ]),
    );
    expect(rows(forge.cwd, "pr.merged").map((row) => row.pr)).toEqual([11, 12]);
    // The checkout is back where it was.
    expect(forge.git("symbolic-ref", "--short", "HEAD")).toBe("feature/d");
    const after = await run(["stack", "status", "--json"], forge.cwd);
    expect(after.json().data).toMatchObject({ verdict: "WAITING" });
    expect(after.json().data.reason).toContain("no_verdict");
  });

test("stack land: given no merge grant, then nothing merges and it stops at verified, ready", async () => {
  const forge = setup("github", { push: true, pr: true, merge: false });
  await plan(forge);
  await verdict(forge, "feature/a");
  const result = await run(["stack", "land", "--json"], forge.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    landed: [],
    stoppedAt: { pr: 11, reason: "grant_required", ready: true },
  });
  expect(result.json().data.stoppedAt.unblock).toContain("workit grant set w merge=verified");
  expect(forge.writes).toEqual([]);
  const human = await run(["stack", "land"], forge.cwd);
  expect(human.stdout).toContain("grant_required (verified, ready)");
});

test("stack land: given a workspace without a merge grant (default ceiling), when the agent attempts a merge, then it is denied with the grant needed and the stack stops at verified, ready", async () => {
  // No `merge` key at all: D4 defaults allow push/pr but stop before merging.
  const forge = setup("github", { push: true, pr: true });
  await plan(forge);
  await verdict(forge, "feature/a");
  const result = await run(["stack", "land", "--json"], forge.cwd);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    landed: [],
    stoppedAt: { pr: 11, reason: "grant_required", ready: true },
  });
  expect(result.json().data.stoppedAt.unblock).toContain("workit grant set w merge=verified");
  expect(forge.writes).toEqual([]);
  const human = await run(["stack", "land"], forge.cwd);
  expect(human.stdout).toContain("grant_required (verified, ready)");
});

// `merge: true` lands only verified PRs unless the user asked for an
// explicit, recorded `--unverified --reason`; `merge: "verified"` never.
const MERGE_TRUE = { push: true, pr: true, merge: true };

test("stack land: given merge: true and no verdict on the root, then it stops at no_verdict and names the verifier and the --unverified bypass", async () => {
  const forge = setup("github", MERGE_TRUE);
  await plan(forge);
  const result = await run(["stack", "land", "--json"], forge.cwd);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    landed: [],
    stoppedAt: { pr: 11, reason: "no_verdict" },
  });
  expect(result.json().data.stoppedAt.unblock).toContain("workit ledger verdict verified");
  expect(result.json().data.stoppedAt.unblock).toContain(
    'workit stack land --unverified --reason "<why>"',
  );
  expect(forge.writes).toEqual([]);
});

test("stack land: given merge: true, when --unverified --reason is passed, then a verified PR lands normally and an unverified one lands with a bypass row", async () => {
  const forge = setup("github", MERGE_TRUE);
  await plan(forge);
  await verdict(forge, "feature/a");
  const b = forge.tip("feature/b");
  const result = await run(
    ["stack", "land", "--max", "2", "--unverified", "--reason", "user asked to land now", "--json"],
    forge.cwd,
  );
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const data = result.json().data;
  expect(data.landed.map((item: { pr: number }) => item.pr)).toEqual([11, 12]);
  expect(data.landed[0].unverified).toBeNull();
  const bypass = rows(forge.cwd, "merge.unverified");
  expect(bypass).toEqual([
    expect.objectContaining({
      observer: "workit_cli",
      actor: expect.objectContaining({ session: "lander-1" }),
      branch: "feature/b",
      pr: 12,
      reason: "user asked to land now",
    }),
  ]);
  // The bypass names the head that was merged: feature/b restacked onto main.
  expect(bypass[0].head).not.toBe(b);
  const merged = rows(forge.cwd, "pr.merged").find((row) => row.pr === 12);
  expect(bypass[0].head).toBe(merged?.head ?? "(no pr.merged row)");
  expect(data.landed[1].unverified).toBe(String(bypass[0].id));
  expect(forge.prs.get(12)?.state).toBe("merged");
});

test("stack land: --unverified without --reason is a usage error and nothing moves", async () => {
  const forge = setup("github", MERGE_TRUE);
  await plan(forge);
  const result = await run(["stack", "land", "--unverified", "--json"], forge.cwd);
  expect(result.code).toBe(2);
  expect(result.stderr + result.stdout).toContain("--unverified needs --reason");
  expect(forge.writes).toEqual([]);
});

test('stack land: given merge: "verified", then --unverified is refused, naming why, and nothing moves', async () => {
  const forge = setup("github");
  await plan(forge);
  const result = await run(
    ["stack", "land", "--unverified", "--reason", "user asked", "--json"],
    forge.cwd,
  );
  expect(result.code).toBe(3);
  expect(result.json().error).toContain(
    'grants merge: "verified", which never lands without an accepted independent verdict',
  );
  expect(forge.writes).toEqual([]);
  expect(rows(forge.cwd, "merge.unverified")).toEqual([]);
});

test("stack land: given merge: true and an accepted verdict on the root, then the root lands without a bypass row", async () => {
  const forge = setup("github", MERGE_TRUE);
  await plan(forge);
  await verdict(forge, "feature/a");
  const result = await run(["stack", "land", "--json"], forge.cwd);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    landed: [{ pr: 11, unverified: null }],
    stoppedAt: { pr: 12, reason: "no_verdict" },
  });
  expect(rows(forge.cwd, "merge.unverified")).toEqual([]);
});

test("stack land --dry-run: reports the contiguous verified run and mutates nothing", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  await verdict(forge, "feature/b");
  const dir = stacksDir(forge.cwd);
  if (!dir.ok) throw new Error(dir.error);
  const file = path.join(dir.data, stackFileName("feature/a"));
  const before = readFileSync(file, "utf8");
  const ledgerBefore = readLedger(forge.cwd);
  const tips = ["main", "feature/a", "feature/b", "feature/c", "feature/d"].map(forge.tip);
  const refs = forge.git("for-each-ref");
  const result = await run(["stack", "land", "--dry-run", "--json"], forge.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json().data).toMatchObject({
    dryRun: true,
    landed: [],
    wouldLand: [
      { pr: 11, branch: "feature/a" },
      { pr: 12, branch: "feature/b" },
    ],
    stoppedAt: { pr: 13, reason: "no_verdict" },
  });
  expect(forge.writes).toEqual([]);
  expect(["main", "feature/a", "feature/b", "feature/c", "feature/d"].map(forge.tip)).toEqual(tips);
  expect(forge.git("for-each-ref")).toBe(refs);
  expect(readFileSync(file, "utf8")).toBe(before);
  const ledgerAfter = readLedger(forge.cwd);
  expect(ledgerAfter.ok && ledgerAfter.value.rows.length).toBe(
    ledgerBefore.ok && ledgerBefore.value.rows.length,
  );
});

test("stack land --max 1 lands only the root and stops with max_reached", async () => {
  const forge = setup("gitlab");
  await plan(forge);
  await verdict(forge, "feature/a");
  await verdict(forge, "feature/b");
  const result = await run(["stack", "land", "--max", "1", "--json"], forge.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json().data).toMatchObject({
    landed: [{ pr: 11 }],
    stoppedAt: { pr: 12, reason: "max_reached" },
  });
  expect(forge.prs.get(12)).toMatchObject({ base: "main", state: "open" });
});

test("stack land: a failing PR stops the run with not_ready and the unblock to inspect it", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  forge.failing.add(forge.tip("feature/a") as string);
  const result = await run(["stack", "land", "--json"], forge.cwd);
  expect(result.json().data).toMatchObject({
    landed: [],
    stoppedAt: { pr: 11, reason: "not_ready" },
  });
  expect(result.json().data.stoppedAt.detail).toContain("FIX_CI");
  expect(forge.writes).toEqual([]);
});

test("stack status and land --dry-run: a root PR that does not target the trunk is WAITING with base_not_trunk", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  (forge.prs.get(11) as { base: string }).base = "develop";
  forge.git("push", "-q", forge.bare, "main:refs/heads/develop");
  const status = await run(["stack", "status", "--json"], forge.cwd);
  expect(status.json().data).toMatchObject({ verdict: "WAITING", next: "workit stack sync" });
  expect(status.json().data.reason).toContain("base_not_trunk");
  const dry = await run(["stack", "land", "--dry-run", "--json"], forge.cwd);
  expect(dry.json().data).toMatchObject({
    wouldLand: [],
    stoppedAt: { pr: 11, reason: "base_not_trunk" },
  });
});

// ---------------------------------------------------------------------------
// sync

test("stack sync: after the root was squash-merged on the forge, the rest is restacked in order, lease-pushed and PR2 retargeted; status reads ADVANCE before and READY once CI reruns", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/b");
  const oldB = forge.tip("feature/b") as string;
  forge.mergeExternally(11);
  const advance = await run(["stack", "status", "--json"], forge.cwd);
  expect(advance.json().data).toMatchObject({ verdict: "ADVANCE", next: "workit stack sync" });

  const result = await run(["stack", "sync", "--json"], forge.cwd);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const data = result.json().data;
  expect(data.merged).toEqual([{ branch: "feature/a", pr: 11 }]);
  expect(data.steps.map((step: { branch: string }) => step.branch)).toEqual([
    "feature/b",
    "feature/c",
    "feature/d",
  ]);
  expect(data.steps[0]).toMatchObject({
    parent: "main",
    restack: { carried: true },
    push: { pushed: true, forced: true },
    retarget: { from: "feature/a", to: "main" },
  });
  const trunk = forge.tip("main") as string;
  expect(forge.tip("feature/b")).not.toBe(oldB);
  expect(isAncestor(forge.bare, trunk, forge.tip("feature/b") as string)).toBe(true);
  for (const [parent, child] of [
    ["feature/b", "feature/c"],
    ["feature/c", "feature/d"],
  ])
    expect(isAncestor(forge.bare, forge.tip(parent) as string, forge.tip(child) as string)).toBe(
      true,
    );
  // Every push was leased on the tip the stack last saw.
  expect(rows(forge.cwd, "push.verified").map((row) => [row.branch, row.forced])).toEqual([
    ["feature/b", true],
    ["feature/c", true],
    ["feature/d", true],
  ]);
  // The verdict on feature/b carried across the restack.
  const check = await run(["ledger", "check", "--branch", "feature/b", "--json"], forge.cwd);
  expect(check.json().data).toMatchObject({ accepted: { accepted: true } });
  // CI runs again on the new head (it is never carried): pending first, then READY.
  const pr = await run(["pr", "status", "--pr", "12", "--json"], forge.cwd);
  expect(pr.code, pr.stderr).toBe(0);
  expect(pr.json().data).toMatchObject({
    base: "main",
    next: "WAITING_CI",
    verdict: { accepted: true, basis: "carried" },
  });
  const ready = await run(["stack", "status", "--json"], forge.cwd);
  expect(ready.json().data).toMatchObject({ verdict: "READY" });
  // Idempotent: a second sync moves nothing.
  const again = await run(["stack", "sync", "--json"], forge.cwd);
  expect(again.json().data.steps.every((step: { restack: unknown }) => step.restack === null)).toBe(
    true,
  );
});

test("stack sync: a restack conflict stops blocked with the rebase-continue unblock; unprocessed branches keep their recorded state; continuing resumes", async () => {
  const forge = setup("github");
  const planned = await plan(forge);
  await verdict(forge, "feature/b");
  forge.mergeExternally(11);
  // Someone lands a conflicting b.txt on main.
  forge.commitElsewhere("main", "b.txt", "conflicting\n");
  const result = await run(["stack", "sync", "--json"], forge.cwd);
  expect(result.code).toBe(3);
  const json = result.json();
  expect(json).toMatchObject({ code: "blocked", data: { conflict: "feature/b" } });
  expect(json.unblock).toContain("git rebase --continue, then workit stack sync");
  const stack = readStack(forge.cwd, "feature/a");
  if (!stack.ok || !stack.data) throw new Error("no stack");
  const byBranch = new Map(stack.data.branches.map((entry) => [entry.branch, entry]));
  const plannedBy = new Map(
    planned.stack.branches.map((entry: { branch: string }) => [entry.branch, entry]),
  );
  for (const branch of ["feature/c", "feature/d"])
    expect(byBranch.get(branch) as unknown).toEqual(plannedBy.get(branch));
  // The branch being moved keeps its last verified state plus what is moving.
  const { pendingRestack, ...recordedB } = byBranch.get("feature/b") as Record<string, unknown>;
  expect(recordedB).toEqual(plannedBy.get("feature/b") as Record<string, unknown>);
  expect(pendingRestack).toMatchObject({ tip: planned.stack.branches[1].lastHead });
  expect(forge.writes).toEqual(["merge 11 (external)"]);

  // The rebase ran in a temporary worktree under the store, never in the
  // user's checkout, which is still on feature/d and clean.
  const worktree: string = json.data.worktree;
  expect(
    worktree.startsWith(forge.git("rev-parse", "--path-format=absolute", "--git-common-dir")),
  ).toBe(true);
  expect(forge.git("symbolic-ref", "--short", "HEAD")).toBe("feature/d");
  expect(forge.git("status", "--porcelain")).toBe("");
  // Resolve there and continue.
  writeFileSync(path.join(worktree, "b.txt"), "b\n");
  spawnSync("git", ["add", "b.txt"], { cwd: worktree });
  spawnSync("git", ["rebase", "--continue"], {
    cwd: worktree,
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  const oldRemoteB = forge.tip("feature/b");
  // The resolved change differs from what was reviewed: refused, nothing pushed.
  const changed = await run(["stack", "sync", "--json"], forge.cwd);
  expect(changed.code).toBe(3);
  expect(changed.json()).toMatchObject({
    code: "blocked",
    data: { reason: "content_changed", branch: "feature/b" },
  });
  expect(changed.json().unblock).toContain("workit stack sync --force");
  expect(forge.tip("feature/b")).toBe(oldRemoteB);
  // Pushed only when forced on purpose.
  // Only a named branch can be forced; a bare --force is a usage error.
  expect((await run(["stack", "sync", "--force", "--json"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "sync", "--force", "feature/zz", "--json"], forge.cwd)).code).toBe(2);
  // Forcing another branch does not cover feature/b.
  const other = await run(["stack", "sync", "--force", "feature/c", "--json"], forge.cwd);
  expect(other.json()).toMatchObject({ data: { reason: "content_changed", branch: "feature/b" } });
  expect(forge.tip("feature/b")).toBe(oldRemoteB);
  const resumed = await run(["stack", "sync", "--force", "feature/b", "--json"], forge.cwd);
  expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
  expect(resumed.json().data.steps[0]).toMatchObject({
    branch: "feature/b",
    restack: { carried: false },
    retarget: { to: "main" },
  });
  // A resolved conflict is a different change: the verdict does not carry.
  const check = await run(["ledger", "check", "--branch", "feature/b", "--json"], forge.cwd);
  expect(check.json().data).toMatchObject({
    current: { basis: "stale" },
    accepted: { accepted: false },
  });
  expect(
    isAncestor(forge.bare, forge.tip("main") as string, forge.tip("feature/b") as string),
  ).toBe(true);
});

test("stack sync --local rebases without the forge, and --dry-run reports without moving refs", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  forge.git("switch", "-q", "feature/b");
  const planned = await run(["stack", "plan", "--json"], forge.cwd);
  expect(planned.code, planned.stderr).toBe(0);
  expect(
    planned.json().data.stack.branches.map((entry: { branch: string }) => entry.branch),
  ).toEqual(["feature/a", "feature/b"]);
  forge.commitElsewhere("main", "other.txt", "x\n");
  const refs = forge.git("for-each-ref", "refs/heads");
  const dry = await run(["stack", "sync", "--local", "--dry-run", "--json"], forge.cwd);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.json().data.steps[0]).toMatchObject({ branch: "feature/a", restack: { head: null } });
  expect(forge.git("for-each-ref", "refs/heads")).toBe(refs);
  const local = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(local.code, local.stderr).toBe(0);
  forge.git("fetch", "-q", "origin");
  expect(isAncestor(forge.cwd, "origin/main", "feature/a")).toBe(true);
  expect(isAncestor(forge.cwd, "feature/a", "feature/b")).toBe(true);
  expect(forge.writes).toEqual([]);
  expect(rows(forge.cwd, "push.verified")).toEqual([]);
});

// ---------------------------------------------------------------------------
// single writer and store root

const lockOf = (forge: StackForge) => {
  const dir = stacksDir(forge.cwd);
  if (!dir.ok) throw new Error(dir.error);
  return path.join(dir.data, `${stackFileName("feature/a")}.lock`);
};
const holdLock = (lock: string, owner: Record<string, unknown> | string, ageMs = 0) => {
  mkdirSync(lock, { recursive: true });
  const file = path.join(lock, "owner");
  writeFileSync(file, typeof owner === "string" ? owner : JSON.stringify(owner));
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  utimesSync(lock, when, when);
};
const owner = (pid: number, host = localLockHost()) => ({
  pid,
  processStart: null,
  host,
  nonce: "n",
});

test("stack: a live writer holding the stack makes a second command busy (exit 4); a dead writer's lock is reclaimed", async () => {
  const forge = setup("github");
  await plan(forge);
  const lock = lockOf(forge);
  holdLock(lock, owner(process.pid));
  const busy = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(busy.code).toBe(4);
  expect(busy.json()).toMatchObject({ code: "busy", data: { pid: process.pid } });
  // A pid that no longer exists, same machine identity.
  const dead = spawnSync(process.execPath, ["-e", "process.pid"], { encoding: "utf8" }).pid;
  rmSync(lock, { recursive: true, force: true });
  holdLock(lock, owner(dead));
  const reclaimed = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(reclaimed.code, reclaimed.stderr + reclaimed.stdout).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

test("stack lock: a foreign-identity holder is never judged by local pids (busy while it heartbeats, reclaimed once its heartbeat is stale); an owner-less lock is reclaimed only after a short age", async () => {
  const forge = setup("github");
  await plan(forge);
  const lock = lockOf(forge);
  const dead = spawnSync(process.execPath, ["-e", "process.pid"], { encoding: "utf8" }).pid;
  // Same pid that is dead here, but from another host / pid namespace: not ours to judge.
  holdLock(lock, owner(dead, "other-host#1:boot"));
  expect((await run(["stack", "sync", "--local", "--json"], forge.cwd)).code).toBe(4);
  rmSync(lock, { recursive: true, force: true });
  holdLock(lock, owner(dead, "other-host#1:boot"), 3 * 60_000);
  expect((await run(["stack", "sync", "--local", "--json"], forge.cwd)).code).toBe(0);
  // Owner-less: an mkdir that never wrote its owner. Fresh: busy; old: debris.
  mkdirSync(lock);
  expect((await run(["stack", "sync", "--local", "--json"], forge.cwd)).code).toBe(4);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  expect((await run(["stack", "sync", "--local", "--json"], forge.cwd)).code).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

test("stack: concurrent land runs on one stack are serialized: one lands, the other is busy", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  await verdict(forge, "feature/b");
  // The fake sleep yields, so the first land holds the lock while it waits for CI.
  forgeDeps.sleep = () => new Promise((resolve) => setTimeout(resolve, 2_500));
  const [first, second] = await Promise.all([
    run(["stack", "land", "--max", "2", "--json"], forge.cwd),
    new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
      run(["stack", "land", "--json"], forge.cwd),
    ),
  ]);
  expect([first.code, second.code].toSorted((a, b) => a - b)).toEqual([0, 4]);
  expect(forge.writes.filter((write) => write.startsWith("merge"))).toEqual([
    "merge 11",
    "merge 12",
  ]);
});

test("stack: the stack lives under the git common dir and survives removing the worktree it was planned in", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  const linked = path.join(forge.root, "linked");
  forge.git("switch", "-q", "main");
  forge.git("worktree", "add", "-q", linked, "feature/b");
  const planned = await run(["stack", "plan", "--json"], linked);
  expect(planned.code, planned.stderr).toBe(0);
  forge.git("worktree", "remove", "--force", linked);
  expect(existsSync(linked)).toBe(false);
  const common = forge.git("rev-parse", "--path-format=absolute", "--git-common-dir");
  expect(existsSync(path.join(common, "workit", "stacks", stackFileName("feature/a")))).toBe(true);
  const status = await run(["stack", "status", "--name", "feature/a", "--json"], forge.cwd);
  expect(status.code, status.stderr).toBe(0);
  expect(status.json().data.branches.map((row: { branch: string }) => row.branch)).toEqual([
    "feature/a",
    "feature/b",
  ]);
});

test("stack status: all merged reads COMPLETE", async () => {
  const forge = setup("gitlab", undefined, ["feature/a"]);
  await run(["stack", "plan", "feature/a", "--json"], forge.cwd);
  forge.mergeExternally(11);
  const status = await run(["stack", "status", "--json"], forge.cwd);
  expect(status.json().data).toMatchObject({ verdict: "COMPLETE" });
});

test("stack: usage errors exit 2", async () => {
  const forge = setup("github");
  expect((await run(["stack"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "frob"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "land", "--max", "0"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "land", "--method", "octopus"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "status", "extra"], forge.cwd)).code).toBe(2);
  expect((await run(["stack", "plan", "feature/a", "feature/a"], forge.cwd)).code).toBe(2);
  const missing = await run(["stack", "status", "--json"], forge.cwd);
  expect(missing.json()).toMatchObject({ code: "not_found" });
  const help = await run(["help", "stack"], forge.cwd);
  expect(help.stdout).toContain("usage: workit stack plan");
});

// ---------------------------------------------------------------------------
// review fixes: content safety, PR binding, parent rewrites, mutants

const onBranch = (forge: StackForge, branch: string, fn: () => void) => {
  forge.git("switch", "-q", branch);
  try {
    fn();
  } finally {
    forge.git("switch", "-q", "-");
  }
};

test("stack sync: a branch with a merge commit (an evil merge resolution) is refused before any rebase; nothing moves", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  onBranch(forge, "feature/b", () => {
    forge.git("switch", "-q", "-c", "side", "feature/a");
    writeFileSync(path.join(forge.cwd, "side.txt"), "side\n");
    forge.git("add", "-A");
    forge.git("commit", "-q", "-m", "feat: side");
    forge.git("switch", "-q", "feature/b");
    forge.git("merge", "-q", "--no-ff", "--no-commit", "side");
    writeFileSync(path.join(forge.cwd, "resolution.txt"), "only in the merge\n");
    forge.git("add", "-A");
    forge.git("commit", "-q", "-m", "merge side");
  });
  forge.git("push", "-q", forge.bare, "feature/b");
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  const localB = forge.git("rev-parse", "feature/b");
  forge.mergeExternally(11);
  const result = await run(["stack", "sync", "--json"], forge.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("merge_commits");
  expect(result.json().unblock).toContain("--rebase-merges");
  expect(forge.git("rev-parse", "feature/b")).toBe(localB);
  expect(forge.tip("feature/b")).toBe(localB);
  expect(forge.writes.filter((write) => write.startsWith("retarget"))).toEqual([]);
});

test("stack sync: a commit dropped as already applied is content_changed: the rebased branch stays local, nothing is pushed", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  const remoteB = forge.tip("feature/b");
  // The trunk already holds feature/b's first commit (cherry-picked by someone).
  forge.commitElsewhere("main", "b.txt", "b draft\n");
  const result = await run(["stack", "sync", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(3);
  expect(result.json()).toMatchObject({
    code: "blocked",
    data: { reason: "content_changed", branch: "feature/b", dropped: 1 },
  });
  expect(result.json().data.before.commits).toBe(2);
  expect(result.json().data.after.commits).toBe(1);
  expect(forge.tip("feature/b")).toBe(remoteB);
  expect(forge.git("rev-parse", "feature/b")).not.toBe(remoteB);
  expect(rows(forge.cwd, "push.verified").map((row) => row.branch)).toEqual(["feature/a"]);
});

test("stack sync: a dirty checkout that has a stack branch checked out is refused; branches nobody has checked out restack in temporary worktrees", async () => {
  const forge = setup("github");
  await plan(forge);
  forge.mergeExternally(11);
  writeFileSync(path.join(forge.cwd, "README.md"), "local edit\n");
  const d = forge.git("rev-parse", "feature/d");
  const result = await run(["stack", "sync", "--json"], forge.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ code: "blocked", data: { branch: "feature/d" } });
  expect(result.json().error).toContain("dirty_worktree");
  expect(forge.git("rev-parse", "feature/d")).toBe(d);
  expect(readFileSync(path.join(forge.cwd, "README.md"), "utf8")).toBe("local edit\n");
  forge.git("fetch", "-q", "origin");
  expect(isAncestor(forge.cwd, "origin/main", "feature/b")).toBe(true);
  expect(forge.git("worktree", "list").split("\n")).toHaveLength(1);
});

test("stack land/status: a stack whose PR number now belongs to another branch is refused (pr_mismatch), and a stack planned on another repo is blocked (repo_mismatch)", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  const read = readStack(forge.cwd, "feature/a");
  if (!read.ok || !read.data) throw new Error("no stack");
  const stack = read.data;
  stack.branches[0].pr = 13;
  writeStack(forge.cwd, stack);
  const status = await run(["stack", "status", "--json"], forge.cwd);
  expect(status.json().data).toMatchObject({ verdict: "WAITING" });
  expect(status.json().data.reason).toContain("pr_mismatch");
  const land = await run(["stack", "land", "--json"], forge.cwd);
  expect(land.code).toBe(3);
  expect(land.json().error).toContain("pr_mismatch");
  expect(forge.writes).toEqual([]);

  stack.branches[0].pr = 11;
  stack.repo = "o/other";
  writeStack(forge.cwd, stack);
  const other = await run(["stack", "land", "--json"], forge.cwd);
  expect(other.code).toBe(3);
  expect(other.json().error).toContain("repo_mismatch");
  expect(forge.writes).toEqual([]);
});

test("stack land: the owner/project binding is re-checked: a same-named PR the lookup does not return is not landed", async () => {
  const forge = setup("github", undefined, ["feature/a"]);
  await run(["stack", "plan", "feature/a", "--json"], forge.cwd);
  await verdict(forge, "feature/a");
  // The forge now reports another PR as feature/a's (e.g. reopened elsewhere).
  forge.prs.set(99, { number: 99, branch: "feature/a", base: "main", state: "open" });
  (forge.prs.get(11) as { state: string }).state = "closed";
  const dry = await run(["stack", "land", "--dry-run", "--json"], forge.cwd);
  expect(dry.json().data.stoppedAt).toMatchObject({ pr: 11 });
  expect(["pr_mismatch", "pr_closed"]).toContain(dry.json().data.stoppedAt.reason);
  (forge.prs.get(11) as { state: string }).state = "open";
  const land = await run(["stack", "land", "--dry-run", "--json"], forge.cwd);
  expect(land.json().data.stoppedAt).toMatchObject({ pr: 11, reason: "pr_mismatch" });
});

test("stack plan: a parent rewritten under its child keeps the recorded base, so sync replays only the child's commits; a fresh plan over a rewritten parent is refused with the exact rebase", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  const oldA = forge.git("rev-parse", "feature/a");
  onBranch(forge, "feature/a", () => {
    writeFileSync(path.join(forge.cwd, "a.txt"), "a amended\n");
    forge.git("commit", "-q", "-a", "--amend", "--no-edit");
  });
  // Re-plan keeps lastParentHead = the old feature/a tip (still in feature/b).
  const replanned = await run(["stack", "plan", "--name", "feature/a", "--json"], forge.cwd);
  expect(replanned.code, replanned.stderr).toBe(0);
  expect(replanned.json().data.stack.branches[1]).toMatchObject({
    branch: "feature/b",
    lastParentHead: oldA,
  });
  const synced = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(synced.code, synced.stderr + synced.stdout).toBe(0);
  expect(isAncestor(forge.cwd, "feature/a", "feature/b")).toBe(true);
  expect(forge.git("rev-list", "--count", "feature/a..feature/b")).toBe("2");
  expect(forge.git("show", "feature/b:a.txt")).toBe("a amended");

  // A fresh plan (no record) over a rewritten parent refuses to guess.
  const fresh = setup("github", undefined, ["feature/a", "feature/b"]);
  const freshOld = fresh.git("rev-parse", "feature/a");
  onBranch(fresh, "feature/a", () => {
    writeFileSync(path.join(fresh.cwd, "a.txt"), "a amended\n");
    fresh.git("commit", "-q", "-a", "--amend", "--no-edit");
  });
  const refused = await run(["stack", "plan", "feature/a", "feature/b", "--json"], fresh.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("parent_rewritten");
  expect(refused.json().unblock).toContain(`git rebase --onto feature/a ${freshOld} feature/b`);
});

test("stack: an empty branch is not merged, and a recorded merge is re-checked by a re-plan", async () => {
  const forge = setup("github", undefined, ["feature/a"]);
  forge.git("branch", "feature/empty", "main");
  const planned = await run(["stack", "plan", "--name", "e", "feature/empty", "--json"], forge.cwd);
  expect(planned.code, planned.stderr).toBe(0);
  const synced = await run(["stack", "sync", "--name", "e", "--local", "--json"], forge.cwd);
  expect(synced.json().data.merged).toEqual([]);

  await run(["stack", "plan", "feature/a", "--json"], forge.cwd);
  const read = readStack(forge.cwd, "feature/a");
  if (!read.ok || !read.data) throw new Error("no stack");
  read.data.branches[0].merged = { pr: 11, mergeSha: null, at: "x" };
  writeStack(forge.cwd, read.data);
  const replanned = await run(["stack", "plan", "--name", "feature/a", "--json"], forge.cwd);
  expect(replanned.json().data.stack.branches[0].merged).toBeNull();
  expect(replanned.json().data.notes.join("\n")).toContain("recorded as merged but is not");
});

test("verdict carry: only CLI-observed, patch-equal restack rows carry; an agent-asserted row is ignored", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await verdict(forge, "feature/b");
  const b1 = forge.git("rev-parse", "feature/b");
  onBranch(forge, "feature/b", () => {
    writeFileSync(path.join(forge.cwd, "b.txt"), "b changed\n");
    forge.git("commit", "-q", "-a", "--amend", "--no-edit");
  });
  const b2 = forge.git("rev-parse", "feature/b");
  const link = { branch: "feature/b", fromHead: b1, head: b2, patchEqual: true };
  const actor = { host: "cli", session: "agent-x", agentId: null };
  const asserted = appendRow(forge.cwd, { type: "stack.restacked", actor, ...link } as never);
  expect(asserted.ok).toBe(true);
  const check = async () =>
    (await run(["ledger", "check", "--branch", "feature/b", "--json"], forge.cwd)).json().data;
  expect(await check()).toMatchObject({ accepted: { accepted: false } });
  appendObserved(forge.cwd, { type: "stack.restacked", actor, ...link, patchEqual: false });
  expect(await check()).toMatchObject({ accepted: { accepted: false } });
  // Positive control: the same link observed as patch-equal does carry.
  appendObserved(forge.cwd, { type: "stack.restacked", actor, ...link });
  expect(await check()).toMatchObject({
    current: { basis: "carried" },
    accepted: { accepted: true },
  });
});

test("stack sync: a whitespace-only change since the verdict (equal patch-id, different exact diff) is pushed as rebased, but its verdict does not carry", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  await verdict(forge, "feature/b");
  onBranch(forge, "feature/b", () => {
    writeFileSync(path.join(forge.cwd, "b.txt"), "b \n");
    forge.git("commit", "-q", "-a", "--amend", "--no-edit");
  });
  forge.mergeExternally(11);
  const synced = await run(["stack", "sync", "--json"], forge.cwd);
  expect(synced.code, synced.stderr + synced.stdout).toBe(0);
  const restacked = rows(forge.cwd, "stack.restacked").find((row) => row.branch === "feature/b");
  expect(restacked).toMatchObject({ patchEqual: false, forced: false });
  const check = await run(["ledger", "check", "--branch", "feature/b", "--json"], forge.cwd);
  expect(check.json().data).toMatchObject({ accepted: { accepted: false } });
});

test("stack sync: commits added on a child since the last sync are rebased with it after the parent's squash merge, without --force", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  onBranch(forge, "feature/b", () => {
    writeFileSync(path.join(forge.cwd, "b2.txt"), "more\n");
    forge.git("add", "-A");
    forge.git("commit", "-q", "-m", "feat: b more");
  });
  forge.mergeExternally(11);
  const synced = await run(["stack", "sync", "--json"], forge.cwd);
  expect(synced.code, synced.stderr + synced.stdout).toBe(0);
  expect(
    isAncestor(forge.bare, forge.tip("main") as string, forge.tip("feature/b") as string),
  ).toBe(true);
  expect(forge.git("show", "feature/b:b2.txt")).toBe("more");
  expect(forge.git("rev-list", "--count", "main..feature/b").length).toBeGreaterThan(0);
  expect(forge.tip("feature/b")).toBe(forge.git("rev-parse", "feature/b"));
});

test("stack plan: a parent rewritten under its child is detected without a reflog (expired / fresh clone)", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  const oldA = forge.git("rev-parse", "feature/a");
  onBranch(forge, "feature/a", () => {
    writeFileSync(path.join(forge.cwd, "a.txt"), "a amended\n");
    forge.git("commit", "-q", "-a", "--amend", "--no-edit");
  });
  forge.git("reflog", "expire", "--expire=now", "--all");
  expect(forge.git("reflog", "show", "feature/a")).toBe("");
  const refused = await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("parent_rewritten");
  expect(refused.json().unblock).toContain(`git rebase --onto feature/a ${oldA} feature/b`);
});

test("stack lock: a live holder on this machine is never stale, however old its heartbeat", async () => {
  const forge = setup("github");
  await plan(forge);
  const lock = lockOf(forge);
  holdLock(lock, { ...owner(process.pid), processStart: processStartOf(process.pid) }, 10 * 60_000);
  const busy = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(busy.code).toBe(4);
  expect(existsSync(lock)).toBe(true);
});

const hook = (forge: StackForge, name: string, seconds: number) =>
  writeFileSync(path.join(forge.hooks, name), `#!/bin/sh\nsleep ${seconds}\n`, { mode: 0o755 });

test("stack sync: while another process is inside a slow rebase (post-rewrite hook), a second sync is busy", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  forge.commitElsewhere("main", "other.txt", "x\n");
  hook(forge, "post-rewrite", 6);
  const lock = lockOf(forge);
  const child = Bun.spawn(["bun", MAIN, "--cwd", forge.cwd, "stack", "sync", "--local", "--json"], {
    env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG: configDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let waited = 0; !existsSync(lock) && waited < 30_000; waited += 100)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(second.code, second.stdout).toBe(4);
  expect(await child.exited).toBe(0);
});

test("stack sync: a rebase that outlives the bound reports timed_out, not a conflict", async () => {
  const forge = setup("github", undefined, ["feature/a", "feature/b"]);
  await run(["stack", "plan", "feature/a", "feature/b", "--json"], forge.cwd);
  forge.commitElsewhere("main", "other.txt", "x\n");
  hook(forge, "post-rewrite", 5);
  stackDeps.rebaseTimeoutMs = 1_000;
  const result = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(result.code).toBe(1);
  expect(result.json()).toMatchObject({ code: "failed", data: { reason: "timed_out" } });
  expect(result.json().error).toContain("timed_out");
  expect(result.json().data.conflict).toBeUndefined();
});

test("stack file names are portable: case-distinct names never collide and reserved device names are never a file name", () => {
  expect(stackFileName("Feature/A")).not.toBe(stackFileName("feature/a"));
  expect(stackFileName("Feature/A").toLowerCase()).not.toBe(
    stackFileName("feature/a").toLowerCase(),
  );
  expect(stackFileName("CON")).toMatch(/^con-[0-9a-f]{12}\.json$/u);
  expect(stackFileName("a:b*c?")).toMatch(/^a_b_c_-[0-9a-f]{12}\.json$/u);
});
