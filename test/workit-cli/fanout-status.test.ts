import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import type { ForgeRunner } from "@/packages/workit-core/src/forge/exec";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { makeStackForge, type StackForge } from "@/test/shared/helpers/stack-forge";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// G3 + G4: `workit fanout status` (liveness, PR/CI, verdict, landed, landing
// order) and `workit fanout worktree create|release`, on real git
// repositories; the forge is the stateful fake gh over a bare remote, whose
// merges really squash into main.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-status-config-");
});
afterAll(() => configHome.restore());

const cleanups: Array<() => void> = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const run = async (cwd: string, argv: string[], session = "lead-1") => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const rowsOf = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

/** A slice with a complete brief. */
const slice = (id: string, scope: string[], extra: Record<string, unknown> = {}) => ({
  id,
  branch: `feature/${id}`,
  tier: "standard",
  scope,
  goal: `ship ${id}`,
  acceptance: [`Given the app, When ${id} runs, Then it works`],
  verify: ["workit check test"],
  forbidden: ["no edits outside SCOPE"],
  ...extra,
});

const plan = async (cwd: string, root: string, slices: unknown[]) => {
  const file = path.join(root, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ name: "wave", trunk: "main", slices }));
  const result = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

const status = async (cwd: string, ...args: string[]) => {
  const result = await run(cwd, ["fanout", "status", ...args, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const data = result.json().data;
  const byId = Object.fromEntries(data.slices.map((s: { id: string }) => [s.id, s])) as Record<
    string,
    Record<string, unknown>
  >;
  return { data, byId };
};

const verify = (cwd: string, branch: string) =>
  run(
    cwd,
    ["ledger", "verdict", "verified", "--how", "ran the suite", "--branch", branch, "--json"],
    "reviewer-2",
  );

/**
 * The fake GitHub over a bare remote with a stack a <- b (PR 11, 12), each
 * branch adding `<slug>.txt` in two commits, and a workspace that routes this
 * checkout to it (account octo).
 */
const forgeSetup = (kind: "github" | "gitlab" = "github"): StackForge => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const forge = makeStackForge(kind, ["feature/a", "feature/b"]);
  cleanups.push(forge.cleanup);
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${forge.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: kind, account: "octo" },
        },
      ],
    }),
  );
  Object.assign(forgeDeps, {
    runner: forge.runner,
    sleep: async () => {},
    now: () => 0,
  });
  forge.git("switch", "-q", "main");
  return forge;
};

const stackPlan = (forge: StackForge) =>
  plan(forge.cwd, forge.root, [slice("a", ["a.txt"]), slice("b", ["b.txt"], { dependsOn: ["a"] })]);

/** gh is not installed: every forge call reports a missing binary. */
const noGh: ForgeRunner = () => ({
  status: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  missing: true,
});

// ---------------------------------------------------------------------------
// status with the forge

test("fanout status: given slice a verified with PR #11 open and passing and slice b unverified, when shown, then a is ready with PR and CI, b is active, and the landing order is a", async () => {
  const forge = forgeSetup();
  await stackPlan(forge);
  await verify(forge.cwd, "feature/a");
  const { data, byId } = await status(forge.cwd);
  expect(data.forge).toEqual({ available: true, error: null });
  expect(byId.a).toMatchObject({
    state: "ready",
    branchExists: true,
    head: forge.tip("feature/a"),
    pr: { number: 11, url: "https://github.com/o/r/pull/11", state: "open" },
    ci: "passing",
    verdict: { accepted: true, basis: "fresh" },
    landed: null,
    stuck: false,
  });
  expect(byId.b).toMatchObject({
    state: "active",
    pr: { number: 12, state: "open" },
    ci: "passing",
    verdict: { accepted: false, basis: "none" },
    waitsFor: ["a"],
  });
  expect(data.landingOrder).toEqual(["a"]);
  expect(data.next).toBe("land in this order: a (workit fanout check first; workit pr merge each)");
});

for (const kind of ["github", "gitlab"] as const)
  test(`fanout status and check (${kind}): given slice a squash-merged on the forge and its branch deleted locally, when shown and checked, then a is landed through its merged PR and b stops waiting for it`, async () => {
    const forge = forgeSetup(kind);
    await stackPlan(forge);
    await verify(forge.cwd, "feature/b");
    forge.mergeExternally(11);
    forge.git("fetch", "-q", "origin");
    forge.git("branch", "-q", "-D", "feature/a");
    forge.git("update-ref", "-d", "refs/remotes/origin/feature/a");

    const { data, byId } = await status(forge.cwd);
    expect(byId.a).toMatchObject({
      state: "landed",
      branchExists: false,
      landed: { how: "pr_merged", pr: 11 },
    });
    expect(byId.b).toMatchObject({ state: "ready", waitsFor: [] });
    expect(data.landingOrder).toEqual(["b"]);

    const check = await run(forge.cwd, ["fanout", "check", "--json"]);
    expect(check.code, check.stdout).toBe(0);
    const slices = check.json().data.slices;
    expect(slices[0]).toMatchObject({
      id: "a",
      status: "landed",
      landed: { how: "pr_merged", pr: 11 },
    });
    // b is diffed against a's merged head, so only b.txt counts as its change.
    expect(slices[1]).toMatchObject({
      id: "b",
      status: "ready",
      waitsFor: [],
      changed: 1,
    });
    expect(check.json().data.next).toBe(
      "land in this order: b (workit pr merge each once verified; stacked slices with workit stack land)",
    );
  });

test("fanout check: given the same landed slice a with the forge turned off, when checked, then a reads as not started and b waits for it (the forge is what tells a squash merge after the branch is gone)", async () => {
  const forge = forgeSetup();
  await stackPlan(forge);
  forge.mergeExternally(11);
  forge.git("fetch", "-q", "origin");
  forge.git("branch", "-q", "-D", "feature/a");
  forge.git("update-ref", "-d", "refs/remotes/origin/feature/a");
  const check = await run(forge.cwd, ["fanout", "check", "--offline", "--json"]);
  expect(check.code).toBe(3);
  const [a, b] = check.json().data.slices;
  expect(a).toMatchObject({ id: "a", status: "blocked", landed: null });
  expect(b).toMatchObject({ id: "b", status: "blocked", waitsFor: ["a"] });
});

// ---------------------------------------------------------------------------
// offline

test("fanout status: given gh is not installed and slice a was squash-merged with its branch kept, when shown, then it still answers (exit 0) without PR or CI, says the forge is off, and git alone detects the squash", async () => {
  const forge = forgeSetup();
  await stackPlan(forge);
  forge.mergeExternally(11);
  forge.git("fetch", "-q", "origin");
  Object.assign(forgeDeps, { runner: noGh });

  const result = await run(forge.cwd, ["fanout", "status"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("forge off");
  expect(result.stdout).toContain("landed (squash_patch)");

  const { data, byId } = await status(forge.cwd);
  expect(data.forge.available).toBe(false);
  expect(data.forge.error).toContain("gh is not installed");
  expect(data.notes[0]).toStartWith("forge unavailable (gh is not installed");
  expect(byId.a).toMatchObject({
    state: "landed",
    pr: null,
    landed: { how: "squash_patch", pr: null },
  });
  expect(byId.b).toMatchObject({ pr: null, ci: "unknown", waitsFor: [] });
});

// ---------------------------------------------------------------------------
// STUCK, on a local repository

const localRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-fanout-status-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "src", "core.ts"), "export const core = 1;\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  return { root, cwd };
};

/** Commit `file` on a new branch, every git timestamp (commit and reflog) `minutesAgo` ago. */
const branchAt = (cwd: string, branch: string, file: string, minutesAgo: number) => {
  const when = `${Math.floor(Date.now() / 1000) - minutesAgo * 60} +0000`;
  const env = {
    ...process.env,
    GIT_COMMITTER_DATE: when,
    GIT_AUTHOR_DATE: when,
  };
  const at = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  at("switch", "-q", "-c", branch);
  writeFileSync(path.join(cwd, file), `${branch}\n`);
  at("add", "-A");
  at("commit", "-qm", `feat: ${branch}`);
  at("switch", "-q", "main");
};

test("fanout status: given a slice whose last commit and branch update are 2 hours old, when shown, then it is STUCK at the default 30 minutes, not with --stuck-after 3h, and a ledger row on its branch counts as activity", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [
    slice("idle", ["idle.ts"]),
    slice("boxed", ["boxed.ts"], { timebox: "3 hours" }),
    slice("fresh", ["fresh.ts"]),
  ]);
  branchAt(cwd, "feature/idle", "idle.ts", 120);
  branchAt(cwd, "feature/boxed", "boxed.ts", 120);
  branchAt(cwd, "feature/fresh", "fresh.ts", 5);

  const first = await status(cwd);
  expect(first.byId.idle).toMatchObject({
    state: "stuck",
    stuck: true,
    stuckAfterMinutes: 30,
  });
  expect(first.byId.idle.idleMinutes).toBeGreaterThanOrEqual(120);
  // Its TIMEBOX (3 hours) replaces the default.
  expect(first.byId.boxed).toMatchObject({
    state: "active",
    stuck: false,
    stuckAfterMinutes: 180,
  });
  expect(first.byId.fresh).toMatchObject({ state: "active", stuck: false });
  expect(first.data.stuck).toEqual(["idle"]);
  expect(first.data.next).toStartWith(
    "replace idle: stop the worker, then workit fanout worktree release idle",
  );

  const patient = await status(cwd, "--stuck-after", "3h");
  expect(patient.byId.idle).toMatchObject({ state: "active", stuck: false });
  expect(patient.data.stuck).toEqual([]);

  const human = await run(cwd, ["fanout", "status"]);
  expect(human.stdout).toContain("STUCK       idle (feature/idle)");

  const ruling = await run(cwd, [
    "ledger",
    "ruling",
    "keep the old parser",
    "--why",
    "callers depend on it",
    "--cost-if-wrong",
    "one more refactor",
    "--branch",
    "feature/idle",
  ]);
  expect(ruling.code, ruling.stderr).toBe(0);
  const after = await status(cwd);
  expect(after.byId.idle).toMatchObject({ state: "active", stuck: false });
});

test("fanout status: given --stuck-after with no unit it understands, when shown, then it is a usage error", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const result = await run(cwd, ["fanout", "status", "--stuck-after", "soon", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json().error).toContain("--stuck-after takes a duration");
});

test("fanout status: given a merge-commit landing and a not-started dependent, when shown offline, then the merged slice is landed on_trunk and the dependent is spawnable", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [
    slice("api", ["api.ts"]),
    slice("docs", ["docs.md"], { dependsOn: ["api"], base: "main" }),
  ]);
  branchAt(cwd, "feature/api", "api.ts", 10);
  git(cwd, "merge", "-q", "--no-ff", "-m", "Merge feature/api", "feature/api");
  const { data, byId } = await status(cwd, "--offline");
  expect(byId.api).toMatchObject({
    state: "landed",
    landed: { how: "on_trunk", pr: null },
  });
  expect(byId.docs).toMatchObject({ state: "not_started", waitsFor: [] });
  expect(data.spawnable).toEqual(["docs"]);
  expect(data.next).toStartWith("spawn docs");
});

test("fanout status: given a fresh branch with no commits of its own, when shown offline, then it is not mistaken for landed", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  git(cwd, "branch", "feature/a", "main");
  const { byId } = await status(cwd, "--offline");
  expect(byId.a).toMatchObject({ landed: null, branchExists: true });
  expect(byId.a.state).not.toBe("landed");
});

// ---------------------------------------------------------------------------
// worktree create | release

test("fanout worktree: given a planned slice, when created, released while dirty, then forced, then created again, then the worktree follows the branch, dirty state is recorded before removal, and nothing outside it is touched", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"]), slice("b", ["b.ts"])]);
  const wt = path.join(root, "app-wt", "a");
  const neighbour = path.join(root, "app-wt", "keep", "notes.txt");
  mkdirSync(path.dirname(neighbour), { recursive: true });
  writeFileSync(neighbour, "mine\n");

  const created = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(created.code, created.stderr + created.stdout).toBe(0);
  expect(created.json().data).toMatchObject({
    slice: "a",
    branch: "feature/a",
    path: wt,
    scratch: path.join(wt, ".workit-scratch"),
    mode: "new",
    created: true,
    head: git(cwd, "rev-parse", "main"),
  });
  expect(git(wt, "branch", "--show-current")).toBe("feature/a");
  // The scratch dir is invisible to git: a worker's temp files never get committed.
  writeFileSync(path.join(wt, ".workit-scratch", "body.md"), "draft\n");
  expect(git(wt, "status", "--porcelain")).toBe("");
  expect(rowsOf(cwd, "fanout.worktree.created")).toMatchObject([
    { fanout: "wave", slice: "a", branch: "feature/a", mode: "new" },
  ]);

  const again = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(again.json().data).toMatchObject({ created: false, mode: "resume" });

  writeFileSync(path.join(wt, "a.ts"), "export const a = 1;\n");
  const refused = await run(cwd, ["fanout", "worktree", "release", "a", "--json"]);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("has 1 uncommitted change (?? a.ts)");
  expect(existsSync(path.join(wt, "a.ts"))).toBe(true);
  expect(rowsOf(cwd, "fanout.worktree.released")).toMatchObject([
    {
      slice: "a",
      outcome: "refused",
      uncommittedCount: 1,
      uncommitted: ["?? a.ts"],
      forced: false,
    },
  ]);

  const forced = await run(cwd, ["fanout", "worktree", "release", "a", "--force", "--json"]);
  expect(forced.code, forced.stderr + forced.stdout).toBe(0);
  expect(forced.json().data).toMatchObject({
    removed: true,
    dirty: ["?? a.ts"],
    forced: true,
  });
  expect(existsSync(wt)).toBe(false);
  expect(git(cwd, "worktree", "list")).not.toContain(wt);
  expect(git(cwd, "rev-parse", "--verify", "-q", "refs/heads/feature/a")).not.toBe("");
  expect(readFileSync(neighbour, "utf8")).toBe("mine\n");
  expect(rowsOf(cwd, "fanout.worktree.released").map((row) => row.outcome)).toEqual([
    "refused",
    "removed",
  ]);

  // Resume: commit on the branch elsewhere, then create again checks it out as it is.
  git(cwd, "switch", "-q", "feature/a");
  writeFileSync(path.join(cwd, "a.ts"), "export const a = 2;\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "feat: a");
  git(cwd, "switch", "-q", "main");
  const resumed = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
  expect(resumed.json().data).toMatchObject({ mode: "resume", created: true });
  expect(readFileSync(path.join(wt, "a.ts"), "utf8")).toBe("export const a = 2;\n");
  const clean = await run(cwd, ["fanout", "worktree", "release", "a", "--json"]);
  expect(clean.code, clean.stderr + clean.stdout).toBe(0);
  expect(clean.json().data).toMatchObject({ removed: true, dirty: [] });
});

test("fanout worktree release: given a plain directory at the slice's path, when released, then it is refused and the directory is untouched", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const wt = path.join(root, "app-wt", "a");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "precious.txt"), "keep\n");
  const result = await run(cwd, ["fanout", "worktree", "release", "a", "--force", "--json"]);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("is not a worktree of this repository");
  expect(readFileSync(path.join(wt, "precious.txt"), "utf8")).toBe("keep\n");

  const create = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(create.code).toBe(3);
  expect(create.json().error).toContain("exists and is not empty");
});

test("fanout worktree create: given the slice branch is checked out in the main checkout, when created, then it is refused (never two workers on one branch)", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  git(cwd, "switch", "-q", "-c", "feature/a");
  const result = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("feature/a is checked out at");
  expect(existsSync(path.join(root, "app-wt", "a"))).toBe(false);
});

test("fanout worktree: given an unknown slice or a missing action, when run, then it is a usage error", async () => {
  const { root, cwd } = localRepo();
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const unknown = await run(cwd, ["fanout", "worktree", "create", "ghost", "--json"]);
  expect(unknown.code).toBe(2);
  expect(unknown.json().error).toBe("ghost: not a slice of fanout wave");
  const missing = await run(cwd, ["fanout", "worktree", "remove", "a", "--json"]);
  expect(missing.code).toBe(2);
});
