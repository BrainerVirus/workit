import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import type { Io } from "@/packages/workit-cli/src/output";
import type { GrantDeps } from "@/packages/workit-cli/src/verbs/grant";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit workspace` (#444): edit workspaces.json without the wizard, never
// raising authority, so an agent shell may run it.

let configHome: ConfigHome;
let root = "";
beforeAll(() => {
  configHome = useConfigHome("wk-workspace-verb-");
});
afterAll(() => configHome.restore());

const file = () => path.join(configHome.configDir, "workspaces.json");
const backup = () => `${file()}.bak`;
const doc = () => JSON.parse(readFileSync(file(), "utf8"));
const byName = (name: string) =>
  doc().workspaces.find((entry: { name: string }) => entry.name === name);

const WORK = () => ({
  name: "work",
  glob: `${root}/work/**`,
  vcs: { provider: "gitlab", account: "me", defaultTargetBranch: "develop" },
  issues: { provider: "youtrack", link: true },
  branchPolicy: { preset: "gitflow", developBranch: "develop" },
  commitPolicy: { preset: "conventional" },
  trailers: false,
  youtrack: { baseUrl: "https://yt.example" },
  models: { roles: { verifier: "sonnet" } },
  autonomy: { push: true, pr: true, merge: true, rerun: false },
  defaultEndpoint: "merged",
  verification: "independent",
  delegation: "lead-orchestrates",
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wk-workspace-root-")).replaceAll("\\", "/");
  mkdirSync(path.join(root, "work", "libs", "kit"), { recursive: true });
  writeFileSync(file(), `${JSON.stringify({ workspaces: [WORK()] }, null, 2)}\n`);
});
afterEach(() => {
  for (const name of [file(), backup()]) rmSync(name, { force: true });
  rmSync(root, { recursive: true, force: true });
});

/** An agent shell: every host marker set, headless. */
const AGENT_ENV = { CLAUDECODE: "1", OPENCODE: "1", CODEX_SANDBOX: "seatbelt" };

const run = async (
  argv: string[],
  cwd = root,
  env: NodeJS.ProcessEnv = AGENT_ENV,
  deps?: GrantDeps,
) => {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    json: true,
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await runWorkspace(argv, io, deps);
  return { code, json: () => JSON.parse(stdout), stderr };
};

test("add --from in an agent shell copies config keys, never grants, and keeps a .bak", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["add", "kit", "--glob", `${root}/work/libs/kit/**`, "--from", "work"]);
  expect(result.code).toBe(0);
  expect(readFileSync(backup(), "utf8")).toBe(before);
  const kit = byName("kit");
  const parent = WORK();
  for (const key of [
    "vcs",
    "issues",
    "branchPolicy",
    "commitPolicy",
    "trailers",
    "youtrack",
    "models",
  ])
    expect(kit[key]).toEqual(parent[key as keyof typeof parent]);
  for (const key of ["defaultEndpoint", "delegation"]) expect(kit[key]).toBeUndefined();
  // The parent's raised grants never travel; its lower ones clamp the defaults.
  expect(kit.autonomy).toEqual({ rerun: false });
  expect(kit.verification).toBe("independent");
  expect(result.json().data.grants).toEqual({
    push: true,
    pr: true,
    merge: false,
    release: false,
    rerun: false,
  });
  // The parent entry is untouched, byte-for-byte.
  expect(JSON.stringify(byName("work"), null, 2)).toBe(JSON.stringify(WORK(), null, 2));
});

test("a new entry's effective grants never exceed the entry it shadows", async () => {
  await run(["add", "kit", "--glob", `${root}/work/libs/kit/**`]);
  // Grants are read from the account home; the test home points there.
  const kit = resolveAutonomy(path.join(root, "work", "libs", "kit"));
  const work = resolveAutonomy(path.join(root, "work"));
  expect(kit.workspace).toBe("kit");
  expect(work.workspace).toBe("work");
  const rank = (value: unknown) => (value === true ? 2 : value === "verified" ? 1 : 0);
  for (const kind of ["push", "pr", "merge", "release", "rerun"] as const)
    expect(rank(kit.grants[kind])).toBeLessThanOrEqual(rank(work.grants[kind]));
  expect(kit.defaultEndpoint).toBe("commit");
  expect(kit.verification).toBe("independent");
});

test("set refuses grant keys with the grant set unblock and changes nothing", async () => {
  const before = readFileSync(file(), "utf8");
  for (const spec of ["autonomy.merge=true", "defaultEndpoint=merged", "verification=self"]) {
    const result = await run(["set", "work", spec]);
    expect(result.code).toBe(3);
    expect(result.json().unblock).toContain(`workit grant set work ${spec}`);
    expect(result.json().unblock).toContain("own terminal outside the agent host");
  }
  // name and glob decide where grants apply: refused too.
  expect((await run(["set", "work", "glob=/**"])).code).toBe(3);
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("set changes non-grant keys by dotted path and keeps the rest", async () => {
  const result = await run([
    "set",
    "work",
    "branchPolicy.integration=merge",
    "trailers=true",
    "youtrack=null",
  ]);
  expect(result.code).toBe(0);
  const work = byName("work");
  expect(work.branchPolicy).toEqual({
    preset: "gitflow",
    developBranch: "develop",
    integration: "merge",
  });
  expect(work.trailers).toBe(true);
  expect(work.youtrack).toBeUndefined();
  expect(work.autonomy).toEqual(WORK().autonomy);
  // An invalid value is refused by the schema, nothing written.
  const before = readFileSync(file(), "utf8");
  expect((await run(["set", "work", "commitPolicy.preset=nope"])).code).toBe(2);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("set deleteBranch=false is a non-grant key; a non-boolean is refused (#384)", async () => {
  expect((await run(["set", "work", "deleteBranch=false"])).code).toBe(0);
  expect(byName("work").deleteBranch).toBe(false);
  expect((await run(["set", "work", "deleteBranch=maybe"])).code).toBe(2);
  expect(byName("work").deleteBranch).toBe(false);
});

test("list names the effective entry for the cwd and why", async () => {
  await run(["add", "kit", "--glob", `${root}/work/libs/kit/**`]);
  const result = await run(["list"], path.join(root, "work", "libs", "kit"));
  expect(result.code).toBe(0);
  const data = result.json().data;
  expect(data.workspaces.map((row: { name: string }) => row.name)).toEqual(["work", "kit"]);
  expect(data.effective).toBe("kit");
  expect(data.matches.toSorted()).toEqual(["kit", "work"]);
  expect(data.reason).toContain("most specific");
});

test("add refuses a duplicate name and an unknown parent", async () => {
  expect((await run(["add", "work", "--glob", `${root}/x/**`])).code).toBe(2);
  expect((await run(["add", "x", "--glob", `${root}/x/**`, "--from", "nope"])).json().code).toBe(
    "not_found",
  );
  expect((await run(["add", "x", "--glob", `${root}/[ab]/**`])).code).toBe(2);
});

test("doctor reports overlapping globs and which entry wins", async () => {
  await run(["add", "kit", "--glob", `${root}/work/libs/kit/**`]);
  await run(["add", "twin", "--glob", `${root}/work/*`]);
  const check = runDoctor({
    cwd: root,
    home: configHome.home,
    configDir: configHome.configDir,
    stateDir: path.join(root, "state"),
    env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG: configHome.configDir },
  }).checks.find((item) => item.id === "workspace_mismatch");
  expect(check?.detail).toContain(`overlap: kit inside work, kit wins at ${root}/work/libs/kit`);
  // `work/**` and `work/*` share one literal segment count: a tie.
  expect(check?.detail).toContain(`overlap: twin and work tie at ${root}/work (ambiguous)`);
  expect(check?.status).toBe("fail");
});

const grantsAt = (...parts: string[]) => {
  const dir = path.join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  const view = resolveAutonomy(dir);
  return {
    workspace: view.workspace,
    grants: view.grants,
    endpoint: view.effectiveEndpoint,
    verification: view.verification,
  };
};
const RANK = (value: unknown) => (value === true ? 2 : value === "verified" ? 1 : 0);
const STRICT = ["independent", "self", "proportional"];
const expectNoRaise = (before: ReturnType<typeof grantsAt>, after: ReturnType<typeof grantsAt>) => {
  for (const kind of ["push", "pr", "merge", "release", "rerun"] as const)
    expect(RANK(after.grants[kind]), kind).toBeLessThanOrEqual(RANK(before.grants[kind]));
  expect(STRICT.indexOf(after.verification)).toBeLessThanOrEqual(
    STRICT.indexOf(before.verification),
  );
};
const seed = (workspaces: Record<string, unknown>[]) =>
  writeFileSync(file(), `${JSON.stringify({ workspaces }, null, 2)}\n`);

test("add with a mid-glob * is clamped below a stricter entry it may overlap", async () => {
  // work at <S>/w/**, strict at <S>/w/ui/**; the new glob's root is <S>/w, but
  // at <S>/w/ui/ui/sub/q it beats strict (more literal segments).
  seed([
    {
      name: "work",
      glob: `${root}/w/**`,
      vcs: { provider: "github", account: "me" },
      autonomy: { push: true, pr: true, merge: true },
    },
    {
      name: "strict",
      glob: `${root}/w/ui/**`,
      vcs: { provider: "github", account: "me" },
      autonomy: { push: false, pr: false, merge: false, release: false, rerun: false },
      verification: "independent",
    },
  ]);
  const before = grantsAt("w", "ui", "ui", "sub", "q");
  expect(before.workspace).toBe("strict");
  const added = await run(["add", "ev", "--glob", `${root}/w/*/ui/sub/**`, "--from", "work"]);
  expect(added.code).toBe(0);
  const after = grantsAt("w", "ui", "ui", "sub", "q");
  expect(after.workspace).toBe("ev");
  expectNoRaise(before, after);
  expect(after.grants).toEqual({
    push: false,
    pr: false,
    merge: false,
    release: false,
    rerun: false,
  });
  expect(after.verification).toBe("independent");
});

test("add with a ? in the glob is refused before anything is written", async () => {
  seed([{ name: "work", glob: `${root}/w/**` }]);
  const before = readFileSync(file(), "utf8");
  const result = await run(["add", "ev", "--glob", `${root}/w/?/ui/**`, "--from", "work"]);
  expect(result.code).toBe(2);
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("set refuses unknown keys, case variants of known ones and unsafe segments", async () => {
  const before = readFileSync(file(), "utf8");
  for (const spec of [
    "Autonomy.merge=true",
    "DefaultEndpoint=merged",
    "GLOB=/**",
    "__proto__.x=1",
    " trailers=true",
    "vcs.__proto__=1",
    "nonsense=1",
  ]) {
    const result = await run(["set", "work", spec]);
    expect(result.code, spec).toBe(2);
  }
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("set refuses vcs changes on an entry with grants of its own", async () => {
  const result = await run(["set", "work", "vcs.account=someone-else"]);
  expect(result.code).toBe(3);
  expect(byName("work").vcs.account).toBe("me");
  // An entry without grants of its own may change its vcs. (A new entry from
  // `add` carries the lowered grants of the strictest entry, so it is seeded.)
  seed([WORK(), { name: "plain", glob: `${root}/plain/**` }]);
  expect((await run(["set", "plain", 'vcs={"provider":"github","account":"me"}'])).code).toBe(0);
});

// Model test (decider ruling mvrgug5f): for generated configs and every cwd,
// including a linked worktree outside every glob, `add` never raises the
// effective grants, default endpoint or verification the real resolver reports.
test("model: add never raises effective authority for any cwd, worktrees included", async () => {
  const S = root;
  const outside = mkdtempSync(path.join(os.tmpdir(), "wk-workspace-outside-")).replaceAll(
    "\\",
    "/",
  );
  try {
    const repo = path.join(S, "w", "ui", "repo");
    mkdirSync(repo, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      expect(
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).status,
      ).toBe(0);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(outside, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", worktree);

    const GLOBS = [
      `${S}/w/**`,
      `${S}/w`,
      `${S}/w/ui`,
      `${S}/w/ui/**`,
      `${S}/w/ui/repo/**`,
      `${S}/w/*/ui/sub/**`,
      `${S}/w/*/x/y/**`,
      `${S}/w*/**`,
      `${S}/wx/**`,
      `${S}/*/q/**`,
      `${S}/l/**`,
      // The worktree lives outside every glob above and resolves through its
      // main checkout; a new glob over it shares no text with those globs.
      `${outside}/**`,
      `${outside}/wt/**`,
    ];
    const CWDS = [
      [S, "w"],
      [S, "w", "ui"],
      [S, "w", "ui", "ui", "sub", "q"],
      [S, "w", "a", "x", "y", "q"],
      [S, "w", "ui", "x", "y", "q"],
      [S, "wx", "q"],
      [S, "wy"],
      [S, "other", "q"],
      [S, "w", "ui", "repo"],
    ].map((parts) => path.join(...parts));
    for (const cwd of CWDS) mkdirSync(cwd, { recursive: true });
    // A symlink into the tree: S/l -> S/w.
    symlinkSync(path.join(S, "w"), path.join(S, "l"));
    CWDS.push(path.join(S, "l", "ui", "ui", "sub", "q"));
    CWDS.push(worktree);

    let seedValue = 444;
    const rand = () => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const VALUES = [true, false, "verified", undefined];
    const ENDPOINTS = ["commit", "pr", "green", "merged", undefined];
    const MODES = ["proportional", "self", "independent", undefined];
    const ENDPOINT_ORDER = ["commit", "pr", "green", "merged"];

    const view = (cwd: string) => {
      try {
        const v = resolveAutonomy(cwd);
        return {
          grants: v.grants,
          endpoint: v.defaultEndpoint,
          effective: v.effectiveEndpoint,
          verification: v.verification,
        };
      } catch {
        return null; // ambiguous: every command there fails, nothing is granted
      }
    };

    let compared = 0;
    for (let round = 0; round < 120; round++) {
      const globs = GLOBS.toSorted(() => rand() - 0.5);
      const count = 1 + Math.floor(rand() * 4);
      const existing = globs.slice(0, count).map((glob, index) => {
        const autonomy = Object.fromEntries(
          (["push", "pr", "merge", "release", "rerun"] as const)
            .map((kind) => [kind, pick(VALUES)])
            .filter(([, value]) => value !== undefined),
        );
        const endpoint = pick(ENDPOINTS);
        const verification = pick(MODES);
        return {
          name: `e${index}`,
          glob,
          vcs: { provider: "github", account: "me" },
          ...(Object.keys(autonomy).length ? { autonomy } : {}),
          ...(endpoint ? { defaultEndpoint: endpoint } : {}),
          ...(verification ? { verification } : {}),
        };
      });
      seed(existing);
      const before = CWDS.map(view);
      const added = await run([
        "add",
        "fresh",
        "--glob",
        globs[count],
        ...(rand() < 0.5 ? ["--from", "e0"] : []),
      ]);
      expect(added.code, JSON.stringify({ existing, glob: globs[count] })).toBe(0);
      const after = CWDS.map(view);
      for (const [index, cwd] of CWDS.entries()) {
        const was = before[index];
        const now = after[index];
        if (!now) continue;
        const label = JSON.stringify({ cwd, existing, glob: globs[count], was, now });
        // Ambiguous before (every command failed there): now it must still
        // stay within the defaults.
        const baseline = was ?? {
          grants: { push: true, pr: true, merge: false, release: false, rerun: true },
          endpoint: "commit",
          effective: "commit",
          verification: "proportional",
        };
        for (const kind of ["push", "pr", "merge", "release", "rerun"] as const)
          expect(RANK(now.grants[kind]), `${kind} ${label}`).toBeLessThanOrEqual(
            RANK(baseline.grants[kind]),
          );
        expect(ENDPOINT_ORDER.indexOf(now.endpoint), label).toBeLessThanOrEqual(
          ENDPOINT_ORDER.indexOf(baseline.endpoint),
        );
        expect(ENDPOINT_ORDER.indexOf(now.effective), label).toBeLessThanOrEqual(
          ENDPOINT_ORDER.indexOf(baseline.effective),
        );
        expect(STRICT.indexOf(now.verification), label).toBeLessThanOrEqual(
          STRICT.indexOf(baseline.verification),
        );
        compared++;
      }
      rmSync(backup(), { force: true });
    }
    expect(compared).toBeGreaterThan(300);
    // The worktree outside every glob resolved through its main checkout at least once.
    seed([{ name: "repo", glob: `${S}/w/ui/repo/**`, autonomy: { merge: false } }]);
    expect(resolveAutonomy(worktree).workspace).toBe("repo");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}, 60_000);

// `workspace rm` (#453): removing an entry hands its folders to another entry
// or the defaults, so a removal that might raise anything needs the user at
// their own terminal, like a grant raise.
const headless: GrantDeps = {
  interactive: () => false,
  ask: async () => {
    throw new Error("a headless call must never prompt");
  },
};
const terminal = (answer: string, asked: string[] = []): GrantDeps => ({
  interactive: () => true,
  ask: async (question) => {
    asked.push(question);
    return answer;
  },
});
const GH = { provider: "github", account: "me" };
/** Under work, more specific: removing it hands its folders back to work (merge=true). */
const KIT = () => ({
  name: "kit",
  glob: `${root}/work/libs/kit/**`,
  vcs: GH,
  autonomy: { merge: false },
});

test("rm that would raise merge for a path is refused from an agent shell, even interactive", async () => {
  seed([WORK(), KIT()]);
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await run(["rm", "kit"], root, AGENT_ENV, terminal("kit", asked));
  expect(result.code).not.toBe(0);
  const envelope = result.json();
  expect(envelope.code).toBe("blocked");
  expect(envelope.error).toContain("grant_raise_refused");
  expect(envelope.error).toContain("merge");
  expect(envelope.unblock).toContain("workit workspace rm kit");
  expect(asked).toEqual([]);
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
  // Headless without an agent marker is refused too.
  expect((await run(["rm", "kit"], root, {}, headless)).json().error).toContain(
    "grant_raise_refused",
  );
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("rm that would raise needs the workspace name typed at the user's own terminal", async () => {
  seed([WORK(), KIT()]);
  const before = readFileSync(file(), "utf8");
  expect((await run(["rm", "kit"], root, {}, terminal("nope"))).json().code).toBe("blocked");
  expect(readFileSync(file(), "utf8")).toBe(before);
  const asked: string[] = [];
  const result = await run(["rm", "kit"], root, {}, terminal("kit\n", asked));
  expect(result.code).toBe(0);
  expect(asked[0]).toContain("merge");
  expect(readFileSync(backup(), "utf8")).toBe(before);
  expect(doc().workspaces.map((entry: { name: string }) => entry.name)).toEqual(["work"]);
  expect(resolveAutonomy(path.join(root, "work", "libs", "kit")).workspace).toBe("work");
});

test("rm that lowers or keeps every grant succeeds from an agent shell, with a backup", async () => {
  // loose is at least as loose as work and the defaults in every kind, and no
  // other entry is as specific (so no folder was ambiguous before).
  const loose = {
    name: "loose",
    glob: `${root}/work/libs/kit/**`,
    vcs: GH,
    autonomy: { push: true, pr: true, merge: true, release: true, rerun: true },
    defaultEndpoint: "merged",
    verification: "proportional",
  };
  seed([WORK(), loose]);
  const before = readFileSync(file(), "utf8");
  const kitDir = path.join(root, "work", "libs", "kit");
  const was = resolveAutonomy(kitDir);
  expect(was.workspace).toBe("loose");
  const result = await run(["rm", "loose"]);
  expect(result.code).toBe(0);
  expect(readFileSync(backup(), "utf8")).toBe(before);
  expect(byName("loose")).toBeUndefined();
  expect(JSON.stringify(byName("work"), null, 2)).toBe(JSON.stringify(WORK(), null, 2));
  const data = result.json().data;
  expect(data.removed.name).toBe("loose");
  expect(data.raises).toEqual([]);
  // What covers the removed folders now, and with which grants.
  expect(data.covers).toMatchObject({ at: `${root}/work/libs/kit`, workspace: "work" });
  expect(data.takers).toContain("work");
  const now = resolveAutonomy(kitDir);
  expect(now.workspace).toBe("work");
  for (const kind of ["push", "pr", "merge", "release", "rerun"] as const)
    expect(RANK(now.grants[kind])).toBeLessThanOrEqual(RANK(was.grants[kind]));
});

test("rm of an entry stricter than the defaults is a raise: the defaults take its folders", async () => {
  seed([WORK(), { name: "solo", glob: `${root}/solo/**`, vcs: GH, autonomy: { push: false } }]);
  const result = await run(["rm", "solo"]);
  expect(result.json().error).toContain("grant_raise_refused");
  expect(result.json().error).toContain("push");
});

test("rm never removes the last entry, and refuses an unknown name", async () => {
  const before = readFileSync(file(), "utf8");
  const last = await run(["rm", "work"], root, {}, terminal("work"));
  expect(last.json().code).toBe("blocked");
  expect(last.json().error).toContain("last workspace");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect((await run(["rm", "nope"])).json().code).toBe("not_found");
  expect((await run(["rm"])).code).toBe(2);
});

// Model test (#453): for generated configs and every cwd, including a symlink
// and a linked worktree outside every glob, an `rm` an agent shell is allowed
// to run never raises the effective grants, endpoint or verification the real
// resolver reports; one it refuses writes nothing.
test("model: rm from an agent shell never raises effective authority for any cwd", async () => {
  const S = root;
  const outside = mkdtempSync(path.join(os.tmpdir(), "wk-workspace-rm-outside-")).replaceAll(
    "\\",
    "/",
  );
  try {
    const repo = path.join(S, "w", "ui", "repo");
    mkdirSync(repo, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      expect(
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).status,
      ).toBe(0);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(outside, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", worktree);

    const GLOBS = [
      `${S}/w/**`,
      `${S}/w`,
      `${S}/w/ui/**`,
      `${S}/w/ui/repo/**`,
      `${S}/w/*/ui/sub/**`,
      `${S}/w*/**`,
      `${S}/wx/**`,
      `${S}/*/q/**`,
      `${S}/l/**`,
      `${outside}/wt/**`,
    ];
    const CWDS = [
      [S, "w"],
      [S, "w", "ui"],
      [S, "w", "ui", "ui", "sub", "q"],
      [S, "wx", "q"],
      [S, "other", "q"],
      [S, "w", "ui", "repo"],
    ].map((parts) => path.join(...parts));
    for (const cwd of CWDS) mkdirSync(cwd, { recursive: true });
    symlinkSync(path.join(S, "w"), path.join(S, "l"));
    CWDS.push(path.join(S, "l", "ui", "ui", "sub", "q"));
    CWDS.push(worktree);

    let seedValue = 453;
    const rand = () => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const VALUES = [true, false, "verified", undefined];
    const ENDPOINTS = ["commit", "pr", "green", "merged", undefined];
    const MODES = ["proportional", "self", "independent", undefined];
    const ENDPOINT_ORDER = ["commit", "pr", "green", "merged"];
    // An ambiguous folder: every command there fails, so nothing is granted.
    const NOTHING = {
      grants: { push: false, pr: false, merge: false, release: false, rerun: false },
      endpoint: "commit",
      effective: "commit",
      verification: "independent",
    };
    const view = (cwd: string) => {
      try {
        const v = resolveAutonomy(cwd);
        return {
          grants: v.grants,
          endpoint: v.defaultEndpoint,
          effective: v.effectiveEndpoint,
          verification: v.verification,
        };
      } catch {
        return null; // ambiguous: every command there fails, nothing is granted
      }
    };

    let removed = 0;
    let refused = 0;
    for (let round = 0; round < 150; round++) {
      const globs = GLOBS.toSorted(() => rand() - 0.5);
      const count = 2 + Math.floor(rand() * 3);
      // Loose entries first so some removals raise nothing.
      const loose = rand() < 0.5;
      const existing = globs.slice(0, count).map((glob, index) => {
        const autonomy = Object.fromEntries(
          (["push", "pr", "merge", "release", "rerun"] as const)
            .map((kind) => [kind, loose && index === 0 ? true : pick(VALUES)])
            .filter(([, value]) => value !== undefined),
        );
        const endpoint = loose && index === 0 ? "merged" : pick(ENDPOINTS);
        const verification = loose && index === 0 ? "proportional" : pick(MODES);
        return {
          name: `e${index}`,
          glob,
          vcs: rand() < 0.85 ? { provider: "github", account: "me" } : { provider: "github" },
          ...(Object.keys(autonomy).length ? { autonomy } : {}),
          ...(endpoint ? { defaultEndpoint: endpoint } : {}),
          ...(verification ? { verification } : {}),
        };
      });
      seed(existing);
      const text = readFileSync(file(), "utf8");
      const before = CWDS.map(view);
      const target = loose ? "e0" : `e${Math.floor(rand() * count)}`;
      const result = await run(["rm", target]);
      const label0 = JSON.stringify({ existing, target });
      if (result.code !== 0) {
        expect(result.json().error, label0).toContain("grant_raise_refused");
        expect(readFileSync(file(), "utf8"), label0).toBe(text);
        refused++;
        continue;
      }
      removed++;
      const after = CWDS.map(view);
      for (const [index, cwd] of CWDS.entries()) {
        const now = after[index];
        if (!now) continue;
        const was = before[index] ?? NOTHING;
        const label = JSON.stringify({ cwd, existing, target, was, now });
        for (const kind of ["push", "pr", "merge", "release", "rerun"] as const)
          expect(RANK(now.grants[kind]), `${kind} ${label}`).toBeLessThanOrEqual(
            RANK(was.grants[kind]),
          );
        expect(ENDPOINT_ORDER.indexOf(now.endpoint), label).toBeLessThanOrEqual(
          ENDPOINT_ORDER.indexOf(was.endpoint),
        );
        expect(ENDPOINT_ORDER.indexOf(now.effective), label).toBeLessThanOrEqual(
          ENDPOINT_ORDER.indexOf(was.effective),
        );
        expect(STRICT.indexOf(now.verification), label).toBeLessThanOrEqual(
          STRICT.indexOf(was.verification),
        );
      }
      rmSync(backup(), { force: true });
    }
    // Both outcomes happen: the model is not vacuous either way.
    expect(removed).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(10);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}, 60_000);

test("rm of an entry whose grants lack vcs.account is a raise: it delivered nothing to a forge", async () => {
  // Explicit grants without vcs.account reach no forge (autonomy.ts), so the
  // folders had push=false in effect; work would hand them push, pr and merge.
  seed([
    WORK(),
    {
      name: "noaccount",
      glob: `${root}/work/libs/kit/**`,
      vcs: { provider: "github" },
      autonomy: { push: true, pr: true, merge: true, release: true, rerun: true },
      defaultEndpoint: "merged",
    },
  ]);
  const result = await run(["rm", "noaccount"]);
  expect(result.json().error).toContain("grant_raise_refused");
  expect(result.json().error).toContain("push");
});

test("rm of one of two equally specific entries is a raise: their shared folder was ambiguous", async () => {
  // <S>/work/repo matches both with the same specificity: every command there
  // fails (nothing granted). Removing r would hand it to x with the defaults.
  const folder = path.join(root, "work", "repo");
  mkdirSync(folder, { recursive: true });
  seed([
    { name: "r", glob: `${root}/work/**`, vcs: GH },
    { name: "x", glob: `${root}/*/repo/**`, vcs: GH },
  ]);
  expect(() => resolveAutonomy(folder)).toThrow();
  const before = readFileSync(file(), "utf8");
  const result = await run(["rm", "r"], root, AGENT_ENV, headless);
  expect(result.code).not.toBe(0);
  expect(result.json().error).toContain("grant_raise_refused");
  expect(result.json().error).toContain("push");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});
