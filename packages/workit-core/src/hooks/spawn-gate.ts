// The spawn gate (#432, #654), Claude Code's PreToolUse on the Agent tool.
// No spawn runs under host isolation: Claude Code's worktree isolation refuses
// every command that wraps git and cannot be turned off, so `isolation` is
// stripped from every agent type (an implementer works in its brief's
// WORKTREE); under auto mode, which refuses a rewritten spawn, the spawn is
// denied with the same args without it (agent-model.ts). A `workit:implementer` spawn also carries a Workit brief: a
// prompt with no WORKTREE line (no brief, or a brief rendered before the
// worktree existed) is denied with the commands that make one. A pointer
// prompt (its WORKER, TIER, TIMEBOX and WORKTREE lines plus "render
// `workit fanout brief <slice>`") passes: it spares the lead's context, and
// the launcher fast path (workit-hook.mjs) keeps this same WORKTREE test.
import { agentModelDecision, type SpawnChange } from "./agent-model";
import type { HostDescriptor } from "./descriptor";
import type { HookDecision } from "./protocol";
import { workitRole } from "./steering";

/** A brief's WORKTREE line naming a made worktree (`fanout brief` says "not made yet" otherwise). */
const MADE_WORKTREE = /^WORKTREE:[ \t]*(?!not made yet)\S(?![^\n]*not made yet)/mu;

const UNBLOCK = "workit fanout worktree create <slice>";
const BRIEF = "workit fanout brief <slice>";

/** The gate on a Claude Code spawn: a deny, or the input it lets run and what it changed. */
type Gate =
  | { kind: "deny"; decision: HookDecision }
  | { kind: "run"; input: Record<string, unknown>; change: SpawnChange };

const gate = (descriptor: HostDescriptor, tool: Record<string, unknown>): Gate => {
  const type = typeof tool.subagent_type === "string" ? tool.subagent_type : "";
  const implementer = workitRole(descriptor, type) === "implementer";
  if (implementer && (typeof tool.prompt !== "string" || !MADE_WORKTREE.test(tool.prompt)))
    return {
      kind: "deny",
      decision: {
        kind: "deny",
        reason: `workit spawn gate: a ${type} spawn needs a Workit brief with a WORKTREE line, and this prompt has none. Even for one slice: run \`${UNBLOCK}\`, then \`${BRIEF}\`, and spawn again with its text as the prompt and the Agent args its SPAWN line names (a slice no plan registers needs \`workit fanout plan <plan.json>\` first).`,
        unblock: UNBLOCK,
      },
    };
  if (tool.isolation === undefined)
    return { kind: "run", input: tool, change: { dropped: [], reasons: [], notes: [] } };
  const { isolation: _dropped, ...input } = tool;
  const why = `${
    implementer
      ? "it works in the brief's WORKTREE"
      : "it runs in your checkout; for its own worktree run `workit fanout worktree create <slice>` and name it in the prompt"
  } (Claude Code's isolation refuses wrapped git).`;
  return {
    kind: "run",
    input,
    change: {
      dropped: ["isolation"],
      reasons: [`Isolation goes: ${why}`],
      notes: [`Workit removed isolation from this ${type || "general-purpose"} spawn: ${why}`],
    },
  };
};

/**
 * The gate, then the role's model (agent-model.ts) on what it lets run: one
 * `updatedInput` for both, or under auto mode one deny naming the exact args.
 */
export const spawnDecision = (
  descriptor: HostDescriptor,
  cwd: string,
  tool: Record<string, unknown>,
  permissionMode: string | null = null,
): HookDecision => {
  const checked = gate(descriptor, tool);
  if (checked.kind === "deny") return checked.decision;
  return agentModelDecision(cwd, checked.input, { change: checked.change, permissionMode });
};
