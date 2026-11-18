// Workit's role agents on OpenCode (D1): the plugin registers
// `workit-implementer`, `workit-verifier`, `workit-reviewer`,
// `workit-decider` and `workit-babysitter` through `ctx.agent.transform`.
// `AgentEditor.update` creates a missing id (OpenCode 2.3.0 adds its own
// config agents that way). Each agent's system prompt is the canonical Claude
// Code agent body, and its model is `models.roles` for the project root,
// resolved again on every catalog build (no value: it inherits the parent's).
// The judges and the decider get edit denied. A model a `subagent` call names
// still wins over the agent's (spawn-model.ts leaves it alone).
import { unwatchFile, watchFile } from "node:fs";
import {
  resolveAvailableRoleModel,
  uniformImplementerModel,
  type ModelRole,
  type RoleModel,
} from "@workit-dev/core/src/core/role-models";
import { workspacesPath } from "@workit-dev/core/src/core/workspaces";
import babysitter from "../../../workit-claude-code/agents/babysitter.md" with { type: "text" };
import decider from "../../../workit-claude-code/agents/decider.md" with { type: "text" };
import implementer from "../../../workit-claude-code/agents/implementer.md" with { type: "text" };
import reviewer from "../../../workit-claude-code/agents/reviewer.md" with { type: "text" };
import verifier from "../../../workit-claude-code/agents/verifier.md" with { type: "text" };

type Role = { id: string; role: ModelRole; markdown: string; readOnly: boolean };

export const OPENCODE_AGENTS: readonly Role[] = [
  { id: "workit-implementer", role: "implementer", markdown: implementer, readOnly: false },
  { id: "workit-verifier", role: "verifier", markdown: verifier, readOnly: true },
  { id: "workit-reviewer", role: "reviewer", markdown: reviewer, readOnly: true },
  { id: "workit-decider", role: "decider", markdown: decider, readOnly: true },
  { id: "workit-babysitter", role: "babysit", markdown: babysitter, readOnly: false },
];

/** `provider/model[#variant]` as OpenCode's agent model, or null for any other value. */
export const opencodeAgentModel = (
  value: string,
): { providerID: string; id: string; variant?: string } | null => {
  const match = /^([^\s/#]+)\/([^\s#]+)(?:#(\S+))?$/u.exec(value.trim());
  if (!match) return null;
  const [, providerID, id, variant] = match;
  return variant ? { providerID, id, variant } : { providerID, id };
};

/** The canonical agent's description and body, in OpenCode terms. */
export const opencodeAgentText = (markdown: string): { description: string; system: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(markdown);
  const description = /^description:\s*(.+)$/mu.exec(match?.[1] ?? "")?.[1].trim() ?? "";
  const system = (match?.[2] ?? markdown)
    .trim()
    // OpenCode never isolates a subagent in a host worktree.
    .replace(/\n\nIn a Claude Code host-isolated worktree[\s\S]*?(?=\n\n)/u, "")
    .replace(/\(`\/workit:([a-z-]+)`\)/gu, "(call the skill tool with `workit-$1`)")
    .replace(/`\/workit:([a-z-]+)`/gu, "`workit-$1`")
    // A child session's shell already carries its own WORKIT_SESSION_ID.
    .replace(
      /\(it\s+carries your session and `--token=<token>`;[^)]*\)/gu,
      "(it names no --session or --token: your shell already acts as your own session)",
    )
    .replaceAll(" --session <id> --token=<token>", "");
  return { description, system };
};

const roleModel = (root: string, role: ModelRole): RoleModel | null =>
  role === "implementer"
    ? uniformImplementerModel(root, "opencode")
    : resolveAvailableRoleModel(root, { role }, "opencode");

type Permission = { action: string; resource: string; effect: "allow" | "deny" | "ask" };
type EditableAgent = {
  description?: string;
  system?: string;
  mode: string;
  model?: { providerID: string; id: string; variant?: string };
  permissions: Permission[];
};
export type AgentEditorLike = {
  update: (id: string, edit: (agent: EditableAgent) => void) => void;
};

/** Register (or refresh) every Workit role agent on the editor, for `root`. */
export const registerRoleAgents = (root: string, editor: AgentEditorLike): void => {
  for (const agent of OPENCODE_AGENTS) {
    const { description, system } = opencodeAgentText(agent.markdown);
    const configured = roleModel(root, agent.role);
    const model = configured ? opencodeAgentModel(configured.model) : null;
    editor.update(agent.id, (info) => {
      info.description = description;
      info.system = system;
      info.mode = "subagent";
      if (model) info.model = model;
      // The last matching rule wins, so the deny goes after any inherited allow.
      if (agent.readOnly) info.permissions.push({ action: "edit", resource: "*", effect: "deny" });
    });
  }
};

type AgentDomainLike = {
  transform: (callback: (editor: AgentEditorLike) => void) => Promise<unknown>;
  reload?: () => Promise<void>;
};

/**
 * The role agents on OpenCode's catalog, rebuilt when workspaces.json changes
 * so a new role model applies without a restart. Returns the teardown.
 */
export const installRoleAgents = async (
  root: string,
  agents: AgentDomainLike | undefined,
): Promise<() => void> => {
  if (!agents?.transform) return () => {};
  await agents.transform((editor) => registerRoleAgents(root, editor));
  const file = workspacesPath();
  const reload = () => void agents.reload?.().catch(() => {});
  watchFile(file, { interval: 2000, persistent: false }, reload);
  return () => unwatchFile(file, reload);
};
