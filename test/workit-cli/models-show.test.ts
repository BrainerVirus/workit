import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { resolveRoleModel, roleModelIssues } from "@/packages/workit-core/src/core/role-models";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #395: `models.roles` names a model and effort per role and host; global
// default in workspaces.json, per-workspace override, inherited by nested
// workspaces; `fanout.tierModels` still feeds the implementer tiers.

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-role-models-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
});

const project = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-role-models-cwd-")));
  dirs.push(root);
  const cwd = path.join(root, "app");
  mkdirSync(cwd);
  return cwd;
};

const config = (document: unknown): void =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify(document));

const show = async (cwd: string, ...argv: string[]) => {
  let stdout = "";
  const code = await main(["models", "show", ...argv, "--json"], {
    cwd,
    env: { ...process.env, WORKIT_HOST: "", WORKIT_SESSION_ID: "" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, json: () => JSON.parse(stdout) };
};

test("G no models config, W models show --host claude_code, T the built-in Claude Code defaults print", async () => {
  const result = await show(project(), "--host", "claude_code");
  expect(result.code).toBe(0);
  expect(result.json().data.roles).toEqual({
    decider: { model: "fable", effort: "high", source: "built-in" },
    implementer: {
      mundane: { model: "haiku", effort: null, source: "built-in" },
      standard: { model: "sonnet", effort: null, source: "built-in" },
      hard: { model: "opus", effort: null, source: "built-in" },
    },
    verifier: { model: "sonnet", effort: null, source: "built-in" },
    reviewer: { model: "opus", effort: null, source: "built-in" },
    explore: { model: "haiku", effort: null, source: "built-in" },
    babysit: { model: "haiku", effort: null, source: "built-in" },
  });
});

test("G no models config, W another host, T no built-in model (the host's own default applies)", async () => {
  const result = await show(project(), "--host", "codex", "--role", "verifier");
  expect(result.json().data.roles.verifier).toEqual({ model: null, effort: null, source: "none" });
});

test("G a workspace override of the verifier, W models show --role verifier, T haiku with that workspace as source", async () => {
  const cwd = project();
  config({
    workspaces: [
      {
        name: "app",
        glob: `${cwd}/**`,
        models: { roles: { verifier: { claude_code: { model: "haiku", effort: "low" } } } },
      },
    ],
  });
  const result = await show(cwd, "--host", "claude_code", "--role", "verifier");
  expect(result.json().data.roles.verifier).toEqual({
    model: "haiku",
    effort: "low",
    source: "models.roles in workspace app",
  });
});

test("G a global default and a nested workspace, W resolved, T the nearest workspace wins, then the global default, per role", async () => {
  const cwd = project();
  const outer = path.dirname(cwd);
  config({
    models: { roles: { reviewer: { default: "sonnet" }, explore: { claude_code: "opus" } } },
    workspaces: [
      {
        name: "outer",
        glob: `${outer}/**`,
        models: { roles: { explore: { claude_code: "sonnet" } } },
      },
      { name: "app", glob: `${cwd}/**`, models: { roles: { reviewer: { claude_code: "haiku" } } } },
    ],
  });
  expect(resolveRoleModel(cwd, { role: "reviewer" }, "claude_code")?.model).toBe("haiku");
  expect(resolveRoleModel(cwd, { role: "explore" }, "claude_code")?.model).toBe("sonnet");
  expect(resolveRoleModel(cwd, { role: "reviewer" }, "pi")?.model).toBe("sonnet");
  expect(resolveRoleModel(cwd, { role: "babysit" }, "claude_code")?.model).toBe("haiku");
});

test("G only fanout.tierModels, W the implementer tiers resolve, T they come from it; models.roles wins when both name a tier", async () => {
  const cwd = project();
  config({
    workspaces: [
      {
        name: "app",
        glob: `${cwd}/**`,
        fanout: { tierModels: { hard: "tm-hard", standard: { claude_code: "tm-std" } } },
        models: { roles: { implementer: { hard: { claude_code: { model: "roles-hard" } } } } },
      },
    ],
  });
  expect(resolveRoleModel(cwd, { role: "implementer", tier: "standard" }, "claude_code")).toEqual({
    model: "tm-std",
    effort: null,
    source: "fanout.tierModels in workspace app",
  });
  expect(resolveRoleModel(cwd, { role: "implementer", tier: "hard" }, "claude_code")?.model).toBe(
    "roles-hard",
  );
});

test("G unknown role, host, tier and bad values, W checked, T each is reported and skipped", async () => {
  const cwd = project();
  config({
    workspaces: [
      {
        name: "app",
        glob: `${cwd}/**`,
        models: {
          roles: {
            judge: { claude_code: "opus" },
            verifier: { vim: "sonnet", claude_code: { model: "", effort: 3 } },
            implementer: { epic: "opus" },
          },
        },
      },
    ],
  });
  const issues = roleModelIssues(cwd).join("\n");
  expect(issues).toContain("judge: unknown role");
  expect(issues).toContain("verifier.vim: unknown host");
  expect(issues).toContain("verifier.claude_code.model: not a model name");
  expect(issues).toContain("verifier.claude_code.effort: not an effort name");
  expect(issues).toContain("implementer.epic: unknown tier");
  expect(resolveRoleModel(cwd, { role: "verifier" }, "claude_code")?.model).toBe("sonnet");
});

// #420: `models show --report` reads Claude Code's subagent transcripts.
const transcript = (
  claudeDir: string,
  id: string,
  agentType: string,
  models: string[],
  ageDays = 0,
) => {
  const dir = path.join(claudeDir, "projects", "p", "session", "subagents");
  mkdirSync(dir, { recursive: true });
  const meta = path.join(dir, `agent-${id}.meta.json`);
  writeFileSync(meta, JSON.stringify({ agentType }));
  writeFileSync(
    path.join(dir, `agent-${id}.jsonl`),
    [
      JSON.stringify({ type: "user", message: { role: "user", content: '"model":"x"' } }),
      ...models.map((model) => JSON.stringify({ type: "assistant", message: { model } })),
    ].join("\n"),
  );
  const when = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(meta, when, when);
};

test("G subagent transcripts, W models show --report, T it lists models per role over 7 days and flags a non-default one", async () => {
  const claudeDir = path.join(configHome.home, ".claude");
  rmSync(claudeDir, { recursive: true, force: true });
  transcript(claudeDir, "a", "workit:verifier", ["claude-sonnet-5-5"]);
  transcript(claudeDir, "b", "workit:verifier", ["claude-opus-5-5"]);
  transcript(claudeDir, "c", "workit:implementer", ["claude-sonnet-5-5", "claude-opus-5-5"]);
  transcript(claudeDir, "d", "workit:verifier", ["claude-opus-5-5"], 30);
  transcript(claudeDir, "e", "Plan", ["claude-opus-5-5"]);
  let stdout = "";
  const code = await main(["models", "show", "--report", "--json"], {
    cwd: project(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, WORKIT_HOST: "", WORKIT_SESSION_ID: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stdout += text),
  });
  expect(code, stdout).toBe(0);
  const { data } = JSON.parse(stdout);
  expect(data.days).toBe(7);
  expect(data.agents).toBe(4);
  expect(data.types["workit:verifier"]).toEqual({
    role: "verifier",
    defaults: ["sonnet"],
    models: { "claude-sonnet-5-5": 1, "claude-opus-5-5": 1 },
    flagged: ["claude-opus-5-5"],
  });
  // opus is an implementer tier default (hard): not flagged; Plan has no role.
  expect(data.types["workit:implementer"].flagged).toEqual([]);
  expect(data.types.Plan).toMatchObject({ role: null, flagged: [] });
});
