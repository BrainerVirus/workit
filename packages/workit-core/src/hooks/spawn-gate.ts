// The implementer spawn gate (#432), Claude Code's PreToolUse on the Agent
// tool. A `workit:implementer` spawn always carries a Workit brief and never
// host isolation: Claude Code's worktree isolation refuses every command that
// wraps git and cannot be turned off, so `isolation` is stripped (the brief's
// WORKTREE is the worker's worktree), and a prompt with no WORKTREE line (no
// brief, or a brief rendered before the worktree existed) is denied with the
// commands that make one. Other agent types pass untouched.
import { agentModelDecision } from "./agent-model";
import type { HostDescriptor } from "./descriptor";
import type { HookDecision } from "./protocol";
import { workitRole } from "./steering";

/** A brief's WORKTREE line naming a made worktree (`fanout brief` says "not made yet" otherwise). */
const MADE_WORKTREE = /^WORKTREE:[ \t]*(?!not made yet)\S(?![^\n]*not made yet)/mu;

const UNBLOCK = "workit fanout worktree create <slice>";

export const implementerSpawn = (
  descriptor: HostDescriptor,
  tool: Record<string, unknown>,
): HookDecision => {
  const type = typeof tool.subagent_type === "string" ? tool.subagent_type : "";
  if (workitRole(descriptor, type) !== "implementer") return { kind: "none" };
  if (typeof tool.prompt !== "string" || !MADE_WORKTREE.test(tool.prompt))
    return {
      kind: "deny",
      reason: `workit spawn gate: a ${type} spawn needs a Workit brief with a WORKTREE line, and this prompt has none. Run \`${UNBLOCK}\`, then spawn again with the text of \`workit fanout brief <slice>\` as the prompt.`,
      unblock: UNBLOCK,
    };
  if (tool.isolation === undefined) return { kind: "none" };
  const { isolation: _dropped, ...input } = tool;
  return {
    kind: "update-input",
    input,
    text: `Workit removed isolation from this ${type} spawn: it works in the brief's WORKTREE (Claude Code's isolation refuses wrapped git).`,
  };
};

/** The gate, then the role's model default (agent-model.ts) on what it lets run; a deny wins. */
export const spawnDecision = (
  descriptor: HostDescriptor,
  cwd: string,
  tool: Record<string, unknown>,
): HookDecision => {
  const gate = implementerSpawn(descriptor, tool);
  if (gate.kind === "deny") return gate;
  const model = agentModelDecision(cwd, gate.kind === "update-input" ? gate.input : tool);
  if (gate.kind !== "update-input") return model;
  return model.kind === "update-input"
    ? { ...model, text: [gate.text, model.text].filter(Boolean).join("\n") }
    : gate;
};
