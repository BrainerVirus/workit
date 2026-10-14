import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #274: `fanout.tierModels` in the workspace config names the model for a
// slice's TIER, per host where model names differ. `workit fanout brief` and
// `workit fanout status` name it; an unknown tier or host keeps the skill's
// TIER guidance (no model line).

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-models-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const run = async (cwd: string, argv: string[], host: string) => {
  let stdout = "";
  let stderr = "";
  const previous = process.env.WORKIT_HOST;
  // `fanout status` reads the lead's host from the process environment.
  process.env.WORKIT_HOST = host;
  try {
    const code = await main(argv, {
      cwd,
      env: { ...process.env, WORKIT_SESSION_ID: "lead-1", WORKIT_HOST: host },
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  } finally {
    if (previous === undefined) delete process.env.WORKIT_HOST;
    else process.env.WORKIT_HOST = previous;
  }
};

const setup = async (tierModels: unknown) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-fanout-models-")));
  dirs.push(root);
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
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "outer", glob: `${root}/**`, fanout: { tierModels: { hard: "opus" } } },
        { name: "app", glob: `${cwd}/**`, fanout: { tierModels } },
      ],
    }),
  );
  const slice = (id: string, tier: string) => ({
    id,
    branch: `feature/${id}`,
    tier,
    scope: [`${id}.ts`],
    goal: `GET /${id} answers 200`,
    acceptance: [`Given the app, When GET /${id}, Then the status is 200`],
    verify: ["workit check test"],
    forbidden: ["no edits outside SCOPE"],
  });
  const file = path.join(root, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "usage",
      trunk: "main",
      slices: [slice("docs", "mundane"), slice("api", "standard"), slice("core", "hard")],
    }),
  );
  const planned = await run(cwd, ["fanout", "plan", file, "--json"], "claude_code");
  expect(planned.code, planned.stderr + planned.stdout).toBe(0);
  return cwd;
};

const TIER_MODELS = {
  mundane: "sonnet",
  standard: { claude_code: "opus", opencode: "anthropic/claude-opus-4", codex: "gpt-5-codex" },
};

test("G tierModels with a model for every host and one per host, W the lead renders briefs, T each brief names its tier's model for that host", async () => {
  const cwd = await setup(TIER_MODELS);

  const mundane = await run(cwd, ["fanout", "brief", "docs", "--json"], "claude_code");
  expect(mundane.code, mundane.stderr + mundane.stdout).toBe(0);
  expect(mundane.json().data.model).toBe("sonnet");
  expect(mundane.json().data.text).toContain(
    "TIER: mundane\n  model: sonnet  (fanout.tierModels in workspace app)\n",
  );

  const claude = await run(cwd, ["fanout", "brief", "api", "--json"], "claude_code");
  expect(claude.json().data.model).toBe("opus");
  const opencode = await run(cwd, ["fanout", "brief", "api", "--json"], "opencode");
  expect(opencode.json().data.model).toBe("anthropic/claude-opus-4");
  expect(opencode.json().data.text).toContain("  model: anthropic/claude-opus-4  (");

  // A tier the repo workspace leaves unset inherits from the enclosing one.
  // Codex CLI and Desktop share the `codex` key.
  const codex = await run(cwd, ["fanout", "brief", "api", "--json"], "codex_desktop");
  expect(codex.json().data.model).toBe("gpt-5-codex");

  const hard = await run(cwd, ["fanout", "brief", "core", "--json"], "pi");
  expect(hard.json().data.model).toBe("opus");
  expect(hard.json().data.text).toContain("(fanout.tierModels in workspace outer)");
});

test("G tierModels without an entry for the host or tier, W the lead renders a brief, T no model line: the TIER guidance applies", async () => {
  const cwd = await setup({ standard: { claude_code: "opus" }, mundane: 42 });
  const codex = await run(cwd, ["fanout", "brief", "api", "--json"], "codex_cli");
  expect(codex.code, codex.stderr + codex.stdout).toBe(0);
  expect(codex.json().data.model).toBeNull();
  expect(codex.json().data.text).not.toContain("model:");
  const malformed = await run(cwd, ["fanout", "brief", "docs", "--json"], "claude_code");
  expect(malformed.json().data.model).toBeNull();
});

test("G tierModels, W fanout status lists spawnable slices, T it names each one's model and leaves an unmapped one bare", async () => {
  const cwd = await setup({ mundane: "sonnet", standard: { cursor: "gpt-5" } });
  const status = await run(cwd, ["fanout", "status", "--offline", "--json"], "claude_code");
  expect(status.code, status.stderr + status.stdout).toBe(0);
  const data = status.json().data;
  expect(data.spawnable).toEqual(["docs", "api", "core"]);
  expect(data.spawnModels).toEqual({ docs: "sonnet", core: "opus" });
  expect(data.next).toContain("spawn docs (model sonnet), api, core (model opus)");

  const human = await run(cwd, ["fanout", "status", "--offline"], "cursor");
  expect(human.stdout).toContain("spawn docs (model sonnet), api (model gpt-5), core (model opus)");
});

test("G tierModels with unknown tiers, unknown hosts and non-string values, W grant show runs, T each is reported as ignored", async () => {
  const cwd = await setup({
    mundane: 42,
    huge: "opus",
    standard: { claude_code: "opus", vscode: "x" },
  });
  const shown = await run(cwd, ["grant", "show", "--json"], "claude_code");
  expect(shown.code, shown.stderr + shown.stdout).toBe(0);
  expect(shown.json().data.tierModelIssues).toEqual([
    "workspace app fanout.tierModels.mundane: not a model name or a per-host object; ignored",
    "workspace app fanout.tierModels.huge: unknown tier; ignored",
    "workspace app fanout.tierModels.standard.vscode: unknown host; ignored",
  ]);
  const human = await run(cwd, ["grant", "show"], "claude_code");
  expect(human.stdout).toContain(
    "note: workspace app fanout.tierModels.huge: unknown tier; ignored",
  );
});
