// Codex custom agents: rendered from the canonical Claude Code agents, shipped
// in the plugin's agents/ dir, and copied into the Codex home by the MCP
// launcher because codex-cli 0.160.1 plugins cannot register agents.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CODEX_AGENT_MARKER,
  CODEX_AGENT_ROLES,
  codexAgentFile,
  codexHomeFor,
  codexHomeOfInstall,
  installCodexAgents,
  renderCodexAgents,
} from "@/packages/workit-codex/scripts/agents";

const repo = path.resolve(import.meta.dir, "../..");
const packageRoot = path.join(repo, "packages/workit-codex");
const claudeAgents = path.join(repo, "packages/workit-claude-code/agents");
const scratch = mkdtempSync(path.join(tmpdir(), "workit-codex-agents-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type AgentToml = {
  name: string;
  description: string;
  sandbox_mode?: string;
  developer_instructions: string;
};
const parse = (text: string) => Bun.TOML.parse(text) as AgentToml;

test("Given the canonical Claude agents, When the Codex build renders them, Then the committed agents/ files match", () => {
  const rendered = renderCodexAgents(claudeAgents);
  expect([...rendered.keys()].toSorted()).toEqual([
    "workit-implementer.toml",
    "workit-reviewer.toml",
    "workit-verifier.toml",
  ]);
  for (const [file, text] of rendered)
    expect(readFileSync(path.join(packageRoot, "agents", file), "utf8"), file).toBe(text);
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  expect(pkg.files).toContain("agents/");
});

test("Given a rendered agent, Then it carries the Codex custom-agent fields and the canonical text in Codex terms", () => {
  for (const role of CODEX_AGENT_ROLES) {
    const text = readFileSync(path.join(packageRoot, "agents", codexAgentFile(role)), "utf8");
    expect(text.startsWith(CODEX_AGENT_MARKER)).toBe(true);
    const agent = parse(text);
    // Codex keys roles on the name; the SubagentStart hook expects workit-<role>.
    expect(agent.name).toBe(`workit-${role}`);
    const canonical = readFileSync(path.join(claudeAgents, `${role}.md`), "utf8");
    expect(canonical).toContain(`description: ${agent.description}`);
    expect(agent.developer_instructions).not.toContain("Claude");
    expect(agent.developer_instructions).not.toContain("/workit:");
    // The first canonical paragraph survives verbatim.
    const firstLine = canonical.split("---")[2].trim().split("\n")[0];
    expect(agent.developer_instructions.startsWith(firstLine)).toBe(true);
  }
});

test("Given the judges, Then they run read-only and record verdicts as their own SubagentStart session; the implementer never records one", () => {
  const read = (role: string) =>
    parse(readFileSync(path.join(packageRoot, "agents", `workit-${role}.toml`), "utf8"));
  for (const judge of ["verifier", "reviewer"]) {
    const agent = read(judge);
    expect(agent.sandbox_mode, judge).toBe("read-only");
    expect(agent.developer_instructions, judge).toContain("workit ledger verdict");
    expect(agent.developer_instructions, judge).toContain("--session <id>");
    expect(agent.developer_instructions, judge).toContain("SubagentStart hook");
  }
  const implementer = read("implementer");
  expect(implementer.sandbox_mode).toBeUndefined();
  expect(implementer.developer_instructions).not.toContain("workit ledger verdict");
  expect(implementer.developer_instructions).toContain("Never record a verdict on your own work");
  expect(implementer.developer_instructions).toContain("workit fanout worktree create");
});

test("Given a plugin install path, Then the owning Codex home comes from it, else from CODEX_HOME or ~/.codex", () => {
  const home = path.join(scratch, "h", ".codex");
  const install = path.join(home, "plugins", "cache", "workflow-toolkit", "workit", "8.5.2");
  expect(codexHomeOfInstall(install)).toBe(home);
  expect(codexHomeOfInstall(packageRoot)).toBeNull();
  expect(codexHomeFor(install, { CODEX_HOME: "/elsewhere" })).toBe(home);
  expect(codexHomeFor(packageRoot, { CODEX_HOME: "/elsewhere" })).toBe("/elsewhere");
  expect(codexHomeFor(packageRoot, { HOME: "/u" })).toBe(path.join("/u", ".codex"));
});

test("Given a Codex home, When the agents install, Then missing files are written, Workit files refreshed and a user's same-named file kept", () => {
  const codexHome = path.join(scratch, "install", ".codex");
  const first = installCodexAgents(packageRoot, codexHome);
  expect(first.map((r) => r.action)).toEqual(["installed", "installed", "installed"]);
  expect(installCodexAgents(packageRoot, codexHome).map((r) => r.action)).toEqual([
    "current",
    "current",
    "current",
  ]);
  const verifier = path.join(codexHome, "agents", "workit-verifier.toml");
  writeFileSync(verifier, `${CODEX_AGENT_MARKER} from an older plugin\nname = "workit-verifier"\n`);
  const reviewer = path.join(codexHome, "agents", "workit-reviewer.toml");
  writeFileSync(reviewer, 'name = "workit-reviewer"\n# mine\n');
  const actions = Object.fromEntries(
    installCodexAgents(packageRoot, codexHome).map((r) => [path.basename(r.file), r.action]),
  );
  expect(actions).toEqual({
    "workit-implementer.toml": "current",
    "workit-reviewer.toml": "kept-user-file",
    "workit-verifier.toml": "updated",
  });
  expect(readFileSync(verifier, "utf8")).toBe(
    readFileSync(path.join(packageRoot, "agents", "workit-verifier.toml"), "utf8"),
  );
  expect(readFileSync(reviewer, "utf8")).toContain("# mine");
  const empty = path.join(scratch, "no-agents");
  mkdirSync(empty, { recursive: true });
  expect(installCodexAgents(empty, codexHome)).toEqual([]);
  expect(existsSync(path.join(scratch, "no-agents", "agents"))).toBe(false);
});
