// D1 on OpenCode: the plugin registers Workit's role agents through
// ctx.agent.transform, each with the canonical agent body as its system
// prompt and its model from models.roles for the project root; judges and the
// decider get edit denied, and a subagent call that names a model keeps it.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_AGENTS,
  installRoleAgents,
  opencodeAgentModel,
  opencodeAgentText,
  registerRoleAgents,
} from "@/packages/workit-opencode/src/v2/agents";
import { applySpawnModel, type SpawnNotes } from "@/packages/workit-opencode/src/v2/spawn-model";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
let root: string;
beforeAll(() => {
  configHome = useConfigHome("wk-oc-role-agents-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-oc-role-agents-cwd-")));
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const config = (models: unknown): void =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ models }));

type Agent = {
  description?: string;
  system?: string;
  mode: string;
  model?: { providerID: string; id: string; variant?: string };
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
};

/** An AgentEditor like OpenCode 2.3.0's: `update` on a missing id creates it from defaults. */
const editor = () => {
  const agents = new Map<string, Agent>();
  return {
    agents,
    update: (id: string, edit: (agent: Agent) => void) => {
      const agent = agents.get(id) ?? {
        mode: "primary",
        permissions: [{ action: "edit", resource: "*", effect: "allow" as const }],
      };
      edit(agent);
      agents.set(id, agent);
    },
  };
};

test("G models.roles.verifier.opencode = opencode/deepseek-v4.1-flash, W the plugin registers its agents, T workit-verifier is a subagent on that model and the others inherit", () => {
  config({ roles: { verifier: { opencode: "opencode/deepseek-v4.1-flash" } } });
  const built = editor();
  registerRoleAgents(root, built);
  expect([...built.agents.keys()].toSorted()).toEqual([
    "workit-babysitter",
    "workit-decider",
    "workit-implementer",
    "workit-reviewer",
    "workit-verifier",
  ]);
  const verifier = built.agents.get("workit-verifier")!;
  expect(verifier.mode).toBe("subagent");
  expect(verifier.model).toEqual({ providerID: "opencode", id: "deepseek-v4.1-flash" });
  expect(built.agents.get("workit-reviewer")!.model).toBeUndefined();
  expect(built.agents.get("workit-implementer")!.model).toBeUndefined();
});

test("G the canonical agents, W they register, T each carries its description and body in OpenCode terms; judges and the decider deny edits after any inherited allow", () => {
  const built = editor();
  registerRoleAgents(root, built);
  for (const { id, readOnly } of OPENCODE_AGENTS) {
    const agent = built.agents.get(id)!;
    expect(agent.description, id).toBeTruthy();
    expect(agent.system, id).not.toContain("/workit:");
    expect(agent.system, id).not.toContain("host-isolated worktree");
    expect(agent.system, id).not.toContain("--token=<token>");
    expect(agent.permissions.at(-1), id).toEqual(
      readOnly
        ? { action: "edit", resource: "*", effect: "deny" }
        : { action: "edit", resource: "*", effect: "allow" },
    );
  }
  expect(built.agents.get("workit-reviewer")!.system).toContain(
    "(call the skill tool with `workit-review`)",
  );
  expect(built.agents.get("workit-verifier")!.system).toContain("(`workit-verify-app` generates");
  expect(opencodeAgentText("---\nname: x\ndescription: A role.\n---\n\nBody.\n")).toEqual({
    description: "A role.",
    system: "Body.",
  });
});

test("G a model value, W it is read as an OpenCode agent model, T provider/model[#variant] parses and anything else is skipped", () => {
  expect(opencodeAgentModel("anthropic/claude-sonnet-5-5#high")).toEqual({
    providerID: "anthropic",
    id: "claude-sonnet-5-5",
    variant: "high",
  });
  expect(opencodeAgentModel("sonnet")).toBeNull();
});

test("G a registered verifier on a configured model, W a subagent call names another model, T the named model is kept and nothing is noted", () => {
  config({ roles: { verifier: { opencode: "opencode/deepseek-v4.1-flash" } } });
  const notes: SpawnNotes = new Map();
  const input: Record<string, unknown> = {
    agent: "workit-verifier",
    prompt: "Check.",
    model: "anthropic/claude-sonnet-5-5",
  };
  applySpawnModel(root, { sessionID: "ses_lead", input }, notes);
  expect(input.model).toBe("anthropic/claude-sonnet-5-5");
  const bare: Record<string, unknown> = { agent: "workit-verifier", prompt: "Check." };
  applySpawnModel(root, { sessionID: "ses_lead", input: bare }, notes);
  expect(bare.model).toBeUndefined();
  expect(notes.size).toBe(0);
});

test("G a host without the agent domain, W the role agents install, T nothing is registered and the teardown is a no-op", async () => {
  const stop = await installRoleAgents(root, undefined);
  expect(() => stop()).not.toThrow();
  let transforms = 0;
  const stopped = await installRoleAgents(root, {
    transform: async (callback) => {
      transforms++;
      callback(editor());
    },
  });
  expect(transforms).toBe(1);
  stopped();
});
