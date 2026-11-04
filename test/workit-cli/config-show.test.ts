import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// W2.8: `workit config show` answers "which workspace, forge, models and lease
// settings apply here, and from where?" without reading the config by hand;
// `workit grant show` names the vcs provider too.

let configHome: ConfigHome;
const previousVcs = process.env.WORKIT_VCS_CONFIG;
beforeAll(() => {
  configHome = useConfigHome("wk-config-show-");
  delete process.env.WORKIT_VCS_CONFIG;
});
afterAll(() => {
  configHome.restore();
  if (previousVcs !== undefined) process.env.WORKIT_VCS_CONFIG = previousVcs;
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const name of ["workspaces.json", "vcs.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
});

const project = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-config-show-cwd-")));
  dirs.push(root);
  const cwd = path.join(root, "app");
  mkdirSync(cwd);
  return cwd;
};

const workspaces = (cwd: string, entry: Record<string, unknown>): void =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${path.dirname(cwd).replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_HOST: "", WORKIT_SESSION_ID: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const workspacesFile = () => path.join(configHome.configDir, "workspaces.json");

test("Given a workspace with vcs, models and resources, When config show --json runs, Then each effective value names its source", async () => {
  const cwd = project();
  workspaces(cwd, {
    vcs: { provider: "github", defaultTargetBranch: "trunk" },
    models: { roles: { verifier: { claude_code: "haiku" } } },
    resources: { slots: 3, scope: false },
  });
  const result = await run(cwd, ["config", "show", "--json"]);
  expect(result.code).toBe(0);
  const data = result.json().data;
  expect(data.workspace).toEqual({ value: "w", source: workspacesFile() });
  expect(data.vcs.provider).toEqual({
    value: "github",
    source: `vcs.provider in workspace w in ${workspacesFile()}`,
  });
  expect(data.vcs.defaultTargetBranch).toEqual({
    value: "trunk",
    source: `vcs.defaultTargetBranch in workspace w in ${workspacesFile()}`,
  });
  expect(data.models.roles.verifier).toEqual({
    value: "haiku",
    effort: null,
    source: "models.roles in workspace w",
  });
  expect(data.resources.slots).toEqual({ value: 3, source: `resources in ${workspacesFile()}` });
  expect(data.resources.scope).toEqual({
    value: false,
    source: `resources in ${workspacesFile()}`,
  });
  expect(data.resources.waitMs.source).toBe("default");

  const text = (await run(cwd, ["config", "show"])).stdout;
  expect(text).toContain(`workspace: w  [${workspacesFile()}]`);
  expect(text).toContain(
    `  provider: github  [vcs.provider in workspace w in ${workspacesFile()}]`,
  );
  expect(text).toContain(`  slots: 3  [resources in ${workspacesFile()}]`);
});

test("Given no workspace matches, When config show runs, Then it says so and the provider falls back to vcs.json", async () => {
  const cwd = project();
  writeFileSync(
    path.join(configHome.configDir, "vcs.json"),
    JSON.stringify({ provider: "gitlab" }),
  );
  const data = (await run(cwd, ["config", "show", "--json"])).json().data;
  expect(data.workspace.value).toBeNull();
  expect(data.workspace.source).toContain("no entry in");
  expect(data.vcs.provider).toEqual({
    value: "gitlab",
    source: `provider in ${path.join(configHome.configDir, "vcs.json")}`,
  });
});

test("Given config without show, When it runs, Then the usage names config show", async () => {
  const result = await run(project(), ["config", "list"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("workit config show");
});

test("Given a workspace with vcs.provider, When grant show runs, Then it prints the provider and its source", async () => {
  const cwd = project();
  workspaces(cwd, { vcs: { provider: "github" } });
  const json = (await run(cwd, ["grant", "show", "--json"])).json().data;
  expect(json.vcs).toEqual({
    provider: "github",
    providerSource: `vcs.provider in workspace w in ${workspacesFile()}`,
  });
  const text = (await run(cwd, ["grant", "show"])).stdout;
  expect(text).toContain(
    `vcs.provider: github (vcs.provider in workspace w in ${workspacesFile()})`,
  );
});
