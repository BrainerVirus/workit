import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// G1 + G2: `workit fanout plan` registers slices and refuses overlap;
// `workit fanout check` gates fan-in on real branches with git diff and
// git merge-tree. Every repository here is a real git repository.

// An empty config home: the trunk may come from release tracks in workspaces.json.
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
const remotes: RemoteRepo[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const remote of remotes.splice(0)) remote.cleanup();
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

type Repo = {
  root: string;
  cwd: string;
  /** Commit `files` (null deletes) on a new branch cut from `from`, then return to main. */
  branch: (name: string, from: string, files: Record<string, string | null>) => void;
  /** Commit `files` on main. */
  onMain: (files: Record<string, string>) => void;
  plan: (doc: unknown) => string;
};

const BASE_FILES: Record<string, string> = {
  "package.json": '{ "name": "app" }\n',
  "README.md": "# app\n",
  "src/api/users.ts": "export const users = [];\n",
  "src/api/index.ts": 'export * from "./users";\n',
  "src/ui/page.tsx": "export const Page = () => null;\n",
  "src/core/model.ts": "export type User = { id: string };\n",
};

const write = (cwd: string, files: Record<string, string | null>) => {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(cwd, file);
    if (text === null) rmSync(target, { force: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
};

const makeRepo = (): Repo => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-fanout-"));
  dirs.push(root);
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "core.hooksPath", hooks);
  write(cwd, BASE_FILES);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  let plans = 0;
  return {
    root,
    cwd,
    branch: (name, from, files) => {
      git(cwd, "switch", "-q", "-c", name, from);
      write(cwd, files);
      git(cwd, "add", "-A");
      git(cwd, "commit", "-qm", `feat: ${name}`);
      git(cwd, "switch", "-q", "main");
    },
    onMain: (files) => {
      write(cwd, files);
      git(cwd, "add", "-A");
      git(cwd, "commit", "-qm", "chore: trunk moved");
    },
    plan: (doc) => {
      plans += 1;
      const file = path.join(root, `plan-${plans}.json`);
      writeFileSync(file, JSON.stringify(doc));
      return file;
    },
  };
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

type SliceInput = Record<string, unknown> & { id: string };

/** A slice with a complete brief; override any field. */
const slice = (id: string, scope: string[], extra: Record<string, unknown> = {}): SliceInput => ({
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

const planDoc = (slices: SliceInput[], extra: Record<string, unknown> = {}) => ({
  name: "wave",
  trunk: "main",
  slices,
  ...extra,
});

const fanoutsDir = (repo: Repo) => path.join(repo.cwd, ".git", "workit", "fanouts");

// ---------------------------------------------------------------------------
// plan

test("fanout plan: given two slices with complete briefs and disjoint scopes, when planned, then the slice file is stored under the git common dir, both run in one wave off main, and the ledger records it", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(
      planDoc([slice("api", ["src/api/**"]), slice("ui", ["src/ui/**"], { tier: "mundane" })]),
    ),
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  const data = result.json().data;
  expect(data.created).toBe(true);
  expect(
    data.slices.map((s: { id: string; base: string; tier: string }) => [s.id, s.base, s.tier]),
  ).toEqual([
    ["api", "main", "standard"],
    ["ui", "main", "mundane"],
  ]);
  expect(data.slices[0].worktree).toBe(path.join(repo.root, "app-wt", "api"));
  expect(data.waves).toEqual([["api", "ui"]]);
  expect(data.overlaps).toEqual([]);
  expect(path.dirname(data.file)).toBe(fanoutsDir(repo));
  expect(readdirSync(fanoutsDir(repo))).toHaveLength(1);
  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  expect(ledger.value.rows.filter((row) => row.type === "fanout.planned")).toMatchObject([
    { fanout: "wave", slices: 2, ids: ["api", "ui"], observer: "workit_cli" },
  ]);
});

test("fanout plan: given a brief with a template placeholder goal and no verify command, when planned, then it is invalid (exit 2), every gap is listed, and nothing is stored", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(
      planDoc([
        slice("api", ["src/api/**"], { goal: "<one observable outcome>", verify: [] }),
        slice("ui", ["src/ui/**"], { tier: "huge" }),
      ]),
    ),
    "--json",
  ]);
  expect(result.code).toBe(2);
  const envelope = result.json();
  expect(envelope.code).toBe("invalid_input");
  expect(envelope.data.problems).toEqual([
    "slice api: goal is empty",
    "slice api: verify is empty",
    "slice ui: tier must be one of mundane, standard, hard",
  ]);
  expect(existsSync(fanoutsDir(repo))).toBe(false);
});

test("fanout plan: given a dependency cycle, when planned, then it is invalid and names the cycle", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(
      planDoc([
        slice("a", ["src/api/**"], { dependsOn: ["b"], base: "main" }),
        slice("b", ["src/ui/**"], { dependsOn: ["a"], base: "main" }),
      ]),
    ),
    "--json",
  ]);
  expect(result.code).toBe(2);
  expect(result.json().data.problems).toEqual(["dependency cycle: a -> b -> a"]);
});

test("fanout plan: given two independent slices whose globs both cover an existing source file, when planned, then it is blocked (exit 3) with a suggestion to serialize the later slice after the earlier", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(planDoc([slice("api", ["src/api/**"]), slice("users", ["src/**/users.ts"])])),
    "--json",
  ]);
  expect(result.code).toBe(3);
  const envelope = result.json();
  expect(envelope.code).toBe("blocked");
  expect(envelope.data.conflicts).toEqual([
    {
      slices: ["api", "users"],
      paths: ["src/api/users.ts"],
      shared: false,
      reason: "overlap",
      suggestion: {
        kind: "serialize",
        edges: [{ slice: "users", dependsOn: "api" }],
        text: 'add "api" to "dependsOn" of slice users',
      },
      alternative: {
        kind: "owner",
        slice: "api",
        paths: ["src/api/users.ts"],
        text: 'add "src/api/users.ts" to "owns" of slice api',
      },
    },
  ]);
  expect(envelope.unblock).toBe('add "api" to "dependsOn" of slice users');
  expect(existsSync(fanoutsDir(repo))).toBe(false);
});

test("fanout plan: given two slices that both create the same new file, when planned, then the overlap is caught although the file does not exist yet", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(
      planDoc([
        slice("a", ["src/api/**", "src/shared/date.ts"]),
        slice("b", ["src/ui/**", "src/shared/date.ts"]),
      ]),
    ),
    "--json",
  ]);
  expect(result.code).toBe(3);
  expect(result.json().data.conflicts.map((c: { paths: string[] }) => c.paths)).toEqual([
    ["src/shared/date.ts"],
  ]);
});

test("fanout plan: given two slices that both list package.json, when planned, then the shared file needs one owner; once the suggested owner lists it under owns, the plan is accepted", async () => {
  const repo = makeRepo();
  const shared = (owns: string[] = []) =>
    planDoc([
      slice("ui", ["src/ui/**", "**/package.json"]),
      slice("api", ["src/api/**", "package.json"], { owns }),
    ]);
  const blocked = await run(repo.cwd, ["fanout", "plan", repo.plan(shared()), "--json"]);
  expect(blocked.code).toBe(3);
  const [conflict] = blocked.json().data.conflicts;
  expect(conflict).toMatchObject({
    slices: ["ui", "api"],
    paths: ["package.json"],
    shared: true,
    // api names the file literally, so it is the suggested owner.
    suggestion: { kind: "owner", slice: "api", paths: ["package.json"] },
  });

  const accepted = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(shared(["package.json"])),
    "--json",
  ]);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.json().data.overlaps).toEqual([
    { path: "package.json", slices: ["ui", "api"], resolution: "owner", owner: "api" },
  ]);
});

test("fanout plan: given a slice that depends on another and shares its files, when planned, then the overlap is serialized, it is stacked on its dependency's branch and runs in the second wave", async () => {
  const repo = makeRepo();
  const result = await run(repo.cwd, [
    "fanout",
    "plan",
    repo.plan(
      planDoc([
        slice("routes", ["src/api/**"], { dependsOn: ["model"] }),
        slice("model", ["src/core/**", "src/api/users.ts"]),
      ]),
    ),
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  const data = result.json().data;
  expect(data.overlaps).toEqual([
    { path: "src/api/users.ts", slices: ["routes", "model"], resolution: "serialized" },
  ]);
  expect(data.slices.find((s: { id: string }) => s.id === "routes").base).toBe("feature/model");
  expect(data.waves).toEqual([["model"], ["routes"]]);
  expect(data.landingOrder).toEqual(["model", "routes"]);
});

// ---------------------------------------------------------------------------
// check

const planned = async (repo: Repo, slices: SliceInput[]) => {
  const result = await run(repo.cwd, ["fanout", "plan", repo.plan(planDoc(slices)), "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

const checkJson = async (repo: Repo, ...args: string[]) => {
  const result = await run(repo.cwd, ["fanout", "check", ...args, "--json"]);
  const envelope = result.json();
  const byId = Object.fromEntries(
    envelope.data.slices.map((s: { id: string }) => [s.id, s]),
  ) as Record<string, Record<string, unknown>>;
  return { code: result.code, envelope, byId, stdout: result.stdout, stderr: result.stderr };
};

test("fanout check: given slice branches that each stay in scope and merge cleanly, when checked, then it is ready (exit 0) with the landing order", async () => {
  const repo = makeRepo();
  await planned(repo, [slice("api", ["src/api/**"]), slice("ui", ["src/ui/**"])]);
  repo.branch("feature/api", "main", { "src/api/users.ts": "export const users = [1];\n" });
  repo.branch("feature/ui", "main", { "src/ui/page.tsx": "export const Page = () => 1;\n" });
  const { code, envelope, byId } = await checkJson(repo);
  expect(code).toBe(0);
  expect(envelope.code).toBe("ok");
  expect(envelope.data.ready).toBe(true);
  expect(envelope.data.landingOrder).toEqual(["api", "ui"]);
  expect(byId.api).toMatchObject({ status: "ready", changed: 1, outOfScope: [], reasons: [] });
  expect(envelope.data.next).toStartWith("land in this order: api, ui");
});

test("fanout check: given a slice that also edited a file outside its scope, when checked, then that slice is blocked (exit 3) naming the file, and its sibling stays ready", async () => {
  const repo = makeRepo();
  await planned(repo, [slice("api", ["src/api/**"]), slice("ui", ["src/ui/**"])]);
  repo.branch("feature/api", "main", {
    "src/api/users.ts": "export const users = [1];\n",
    "README.md": "# app, now with users\n",
  });
  repo.branch("feature/ui", "main", { "src/ui/page.tsx": "export const Page = () => 1;\n" });
  const { code, envelope, byId } = await checkJson(repo);
  expect(code).toBe(3);
  expect(envelope.code).toBe("blocked");
  expect(byId.api).toMatchObject({ status: "blocked", changed: 2, outOfScope: ["README.md"] });
  expect(byId.ui).toMatchObject({ status: "ready", outOfScope: [] });
  expect(envelope.unblock).toStartWith("move README.md off feature/api");
});

test("fanout check: given a shared file owned by one slice, when the other slice (whose glob also matches it) edits it, then that edit is out of scope", async () => {
  const repo = makeRepo();
  await planned(repo, [
    slice("api", ["src/api/**", "package.json"], { owns: ["package.json"] }),
    slice("tooling", ["*.json", "src/ui/**"]),
  ]);
  repo.branch("feature/api", "main", { "package.json": '{ "name": "app", "api": 1 }\n' });
  repo.branch("feature/tooling", "main", {
    "package.json": '{ "name": "app", "tooling": 1 }\n',
    "tsconfig.json": "{}\n",
  });
  const { byId } = await checkJson(repo);
  expect(byId.api).toMatchObject({ outOfScope: [] });
  expect(byId.tooling).toMatchObject({ status: "blocked", outOfScope: ["package.json"] });
});

test("fanout check: given two sibling branches that change the same lines, when checked, then merge-tree's conflict is charged to the slice that lands later and the earlier one stays ready", async () => {
  const repo = makeRepo();
  // Listed later-first: the dependency, not the file order, decides who lands first.
  await planned(repo, [
    slice("second", ["src/api/**"], { dependsOn: ["first"], base: "main" }),
    slice("first", ["src/api/**"]),
  ]);
  repo.branch("feature/first", "main", { "src/api/users.ts": "export const users = ['a'];\n" });
  repo.branch("feature/second", "main", { "src/api/users.ts": "export const users = ['b'];\n" });
  const { code, envelope, byId } = await checkJson(repo);
  expect(code).toBe(3);
  expect(envelope.data.landingOrder).toEqual(["first", "second"]);
  expect(envelope.data.conflicts).toEqual([
    {
      first: "first",
      second: "second",
      paths: ["src/api/users.ts"],
      resolution: "rebase second onto feature/first (its dependency), then workit fanout check",
    },
  ]);
  expect(byId.first).toMatchObject({ status: "ready", siblingConflicts: [] });
  expect(byId.second).toMatchObject({
    status: "blocked",
    siblingConflicts: [{ with: "first", paths: ["src/api/users.ts"] }],
    trunkConflicts: [],
  });

  // Gating only the earlier slice passes: the conflict is the later one's to fix.
  const only = await checkJson(repo, "first");
  expect(only.code).toBe(0);
  expect(only.envelope.data.slices.map((s: { id: string }) => s.id)).toEqual(["first"]);
});

test("fanout check: given trunk moved and now conflicts with a slice branch, when checked, then the slice reports the trunk conflict", async () => {
  const repo = makeRepo();
  await planned(repo, [slice("api", ["src/api/**"])]);
  repo.branch("feature/api", "main", { "src/api/users.ts": "export const users = ['api'];\n" });
  repo.onMain({ "src/api/users.ts": "export const users = ['trunk'];\n" });
  const { code, byId } = await checkJson(repo);
  expect(code).toBe(3);
  expect(byId.api).toMatchObject({
    status: "blocked",
    outOfScope: [],
    trunkConflicts: ["src/api/users.ts"],
  });
});

test("fanout check: given a stacked slice on its dependency, when checked, then its diff is taken against the dependency branch, dependencies land first, and a blocked dependency holds it back", async () => {
  const repo = makeRepo();
  await planned(repo, [
    slice("routes", ["src/api/**"], { dependsOn: ["model"] }),
    slice("page", ["src/ui/**"]),
    slice("model", ["src/core/**"]),
  ]);
  repo.branch("feature/model", "main", {
    "src/core/model.ts": "export type User = { id: number };\n",
  });
  repo.branch("feature/routes", "feature/model", {
    "src/api/users.ts": "export const users = [0];\n",
  });
  repo.branch("feature/page", "main", { "src/ui/page.tsx": "export const Page = () => 2;\n" });

  const clean = await checkJson(repo);
  expect(clean.code).toBe(0);
  expect(clean.envelope.data.landingOrder).toEqual(["page", "model", "routes"]);
  // The model change it is stacked on is not counted against routes' scope.
  expect(clean.byId.routes).toMatchObject({ status: "ready", changed: 1, outOfScope: [] });

  // The dependency leaks out of scope: routes now waits for it.
  git(repo.cwd, "switch", "-q", "feature/model");
  write(repo.cwd, { "README.md": "# model notes\n" });
  git(repo.cwd, "commit", "-qam", "docs: stray");
  git(repo.cwd, "switch", "-q", "main");
  const held = await checkJson(repo, "routes");
  expect(held.code).toBe(3);
  expect(held.byId.routes).toMatchObject({ status: "blocked", waitsFor: ["model"] });
});

test("fanout check: given a slice whose branch does not exist yet, when checked, then it is blocked as not started", async () => {
  const repo = makeRepo();
  await planned(repo, [slice("api", ["src/api/**"])]);
  const { code, byId } = await checkJson(repo);
  expect(code).toBe(3);
  expect(byId.api).toMatchObject({ status: "blocked", head: null });
  expect((byId.api.reasons as string[])[0]).toStartWith("branch feature/api not found");
});

test("fanout check: given an unknown slice id, when checked, then it is a usage error", async () => {
  const repo = makeRepo();
  await planned(repo, [slice("api", ["src/api/**"])]);
  const result = await run(repo.cwd, ["fanout", "check", "nope", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json().error).toBe("nope: not a slice of fanout wave");
});

// ---------------------------------------------------------------------------
// trunk from release tracks (the ri-web shape: nun-develop and develop lines)

const TRACK = (line: string, production: string, tags: string) => ({
  strategy: "gitflow",
  productionBranch: production,
  integrationBranch: line,
  naming: {
    feature: "feature/{name}",
    release: `release/${tags}{version}`,
    hotfix: "hotfix/{name}",
  },
  baseBranch: line,
  mergeBackBranches: [line],
  pullRequestTarget: line,
  tagNamespace: tags,
  versionSource: { kind: "git-tag" },
  requiredChecks: [],
});

/** develop = master + 1, nun-develop = master + 2; the workspace default is nun-develop. */
const tracked = (tracks = true): RemoteRepo => {
  const repo = makeRemoteRepo();
  remotes.push(repo);
  const commit = (file: string) => {
    repo.write(file, `${file}\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", `chore: ${file}`);
  };
  repo.git("switch", "-q", "-c", "master");
  repo.git("switch", "-q", "-c", "develop");
  commit("develop-1.txt");
  repo.git("switch", "-q", "-c", "nun-develop", "master");
  commit("nun-1.txt");
  commit("nun-2.txt");
  repo.git("push", "-q", "origin", "master", "develop", "nun-develop");
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "ri-web",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", defaultTargetBranch: "nun-develop" },
          branchPolicy: { preset: "gitflow", developBranch: "nun-develop" },
          ...(tracks
            ? {
                releaseTracks: {
                  nun: TRACK("nun-develop", "master", "nun/"),
                  standard: TRACK("develop", "master", ""),
                },
              }
            : {}),
        },
      ],
    }),
  );
  return repo;
};

const trunkless = (repo: RemoteRepo) => {
  const file = path.join(repo.root, "plan.json");
  writeFileSync(file, JSON.stringify({ name: "wave", slices: [slice("api", ["src/api/**"])] }));
  return file;
};

test("fanout plan with release tracks: given the checkout is on a develop-line feature and the plan names no trunk, when planned, then the trunk and the slice base are the develop line's PR target, not the workspace default", async () => {
  const repo = tracked();
  repo.git("switch", "-q", "-c", "feature/lead", "develop");
  repo.write("lead.txt", "lead\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: lead");
  const result = await run(repo.cwd, ["fanout", "plan", trunkless(repo), "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const data = result.json().data;
  expect(data.trunk).toBe("develop");
  expect(data.slices[0].base).toBe("develop");
});

test("fanout plan with release tracks: given a checkout whose release line cannot be told apart, when planned without --trunk, then it blocks (exit 3) asking for --track, and --track nun picks nun-develop", async () => {
  const repo = tracked();
  // A branch cut from master before either line forked: both lines are equally close.
  repo.git("switch", "-q", "-c", "feature/old", "master");
  repo.write("old.txt", "old\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: old");
  const plan = trunkless(repo);
  const blocked = await run(repo.cwd, ["fanout", "plan", plan, "--json"]);
  expect(blocked.code, blocked.stdout).toBe(3);
  expect(blocked.json()).toMatchObject({
    code: "blocked",
    unblock: "workit fanout plan <plan.json> --track <name>  # or --trunk <branch>",
  });
  expect(existsSync(path.join(repo.cwd, ".git", "workit", "fanouts"))).toBe(false);

  const picked = await run(repo.cwd, ["fanout", "plan", plan, "--track", "nun", "--json"]);
  expect(picked.code, picked.stdout).toBe(0);
  expect(picked.json().data.trunk).toBe("nun-develop");

  const both = await run(repo.cwd, [
    "fanout",
    "plan",
    plan,
    "--track",
    "nun",
    "--trunk",
    "develop",
    "--json",
  ]);
  expect(both.code).toBe(2);
});

test("fanout plan without release tracks: given a workspace default of nun-develop and no tracks, when planned without a trunk, then the trunk stays origin's default branch", async () => {
  const repo = tracked(false);
  const result = await run(repo.cwd, ["fanout", "plan", trunkless(repo), "--json"]);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.trunk).toBe("main");
});

test("workit help fanout prints both subcommands", async () => {
  const result = await run(os.tmpdir(), ["help", "fanout"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("usage: workit fanout plan <plan.json>");
  expect(result.stdout).toContain("fanout check [<slice>…]");
});
