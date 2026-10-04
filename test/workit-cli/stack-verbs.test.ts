import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { success } from "@/packages/workit-core/src/forge/types";
import { pushPreflight } from "@/packages/workit-core/src/git/ops";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { readStack, stackDeps, stacksDir } from "@/packages/workit-core/src/stack";
import { makeStackForge, type StackForge } from "@/test/shared/helpers/stack-forge";

// S12 `workit stack plan|status|sync|land` over a real bare remote and a
// stateful fake gh/glab (squash merges really land in the bare repo).

setDefaultTimeout(120_000);

let configDir = "";
const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
const original = { ...forgeDeps };
const originalStack = { ...stackDeps };
beforeAll(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), "wk-stack-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
});
afterAll(() => {
  if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
  rmSync(configDir, { recursive: true, force: true });
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
  expect(result.json().data.stoppedAt.unblock).toContain('"merge"');
  expect(forge.writes).toEqual([]);
  const human = await run(["stack", "land"], forge.cwd);
  expect(human.stdout).toContain("grant_required (verified, ready)");
});

test("stack land --dry-run: reports the contiguous verified run and mutates nothing", async () => {
  const forge = setup("github");
  await plan(forge);
  await verdict(forge, "feature/a");
  await verdict(forge, "feature/b");
  const dir = stacksDir(forge.cwd);
  if (!dir.ok) throw new Error(dir.error);
  const file = path.join(dir.data, `${encodeURIComponent("feature/a")}.json`);
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
  for (const branch of ["feature/b", "feature/c", "feature/d"])
    expect(byBranch.get(branch) as unknown).toEqual(plannedBy.get(branch));
  expect(forge.writes).toEqual(["merge 11 (external)"]);

  // Resolve and continue; the next sync finishes the job.
  writeFileSync(path.join(forge.cwd, "b.txt"), "b\n");
  forge.git("add", "b.txt");
  spawnSync("git", ["-c", "core.editor=true", "rebase", "--continue"], {
    cwd: forge.cwd,
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  forge.git("switch", "-q", "feature/d");
  const resumed = await run(["stack", "sync", "--json"], forge.cwd);
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

test("stack: a live writer holding the stack makes a second command busy (exit 4); a dead writer's lock is reclaimed", async () => {
  const forge = setup("github");
  await plan(forge);
  const dir = stacksDir(forge.cwd);
  if (!dir.ok) throw new Error(dir.error);
  const lock = path.join(dir.data, `${encodeURIComponent("feature/a")}.json.lock`);
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), `${process.pid}-live`);
  const busy = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(busy.code).toBe(4);
  expect(busy.json()).toMatchObject({ code: "busy", data: { pid: process.pid } });
  // A pid that no longer exists.
  const dead = spawnSync(process.execPath, ["-e", "process.pid"], { encoding: "utf8" }).pid;
  writeFileSync(path.join(lock, "owner"), `${dead}-gone`);
  const reclaimed = await run(["stack", "sync", "--local", "--json"], forge.cwd);
  expect(reclaimed.code, reclaimed.stderr + reclaimed.stdout).toBe(0);
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
  expect(
    existsSync(path.join(common, "workit", "stacks", `${encodeURIComponent("feature/a")}.json`)),
  ).toBe(true);
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
