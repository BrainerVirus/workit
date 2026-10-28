import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import type { Io } from "@/packages/workit-cli/src/output";
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

const run = async (argv: string[], cwd = root) => {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    json: true,
    cwd,
    env: AGENT_ENV,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await runWorkspace(argv, io);
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
  expect((await run(["set", "work", "vcs.provider=svn"])).code).toBe(2);
  expect(readFileSync(file(), "utf8")).toBe(before);
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

test("rm removes an entry, but not one whose removal raises a grant", async () => {
  await run(["add", "solo", "--glob", `${root}/solo/**`]);
  expect((await run(["rm", "solo"])).code).toBe(0);
  expect(byName("solo")).toBeUndefined();
  // kit is clamped below work: removing it hands its folders work's merge grant.
  await run(["add", "kit", "--glob", `${root}/work/libs/kit/**`]);
  expect((await run(["rm", "kit"])).code).toBe(3);
  // A nested entry stricter than its parent: removing it would hand its
  // folders the parent's merge grant.
  writeFileSync(
    file(),
    JSON.stringify({
      workspaces: [
        WORK(),
        {
          name: "brasil",
          glob: `${root}/work/brasil/**`,
          autonomy: { merge: false },
        },
      ],
    }),
  );
  const refused = await run(["rm", "brasil"]);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("merge");
  expect(byName("brasil")).toBeDefined();
  expect((await run(["rm", "nope"])).code).not.toBe(0);
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
