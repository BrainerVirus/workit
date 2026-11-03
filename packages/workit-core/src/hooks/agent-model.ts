// Role models on a Claude Code subagent spawn (#420, #654): the spawn gets
// its role's model (and effort) from the role config through PreToolUse
// `updatedInput` on the Agent tool. A model the spawn names wins over a
// built-in default, and over a configured one only with
// `models.allowLeadOverride`. A spawn is never denied over its model: a type
// with no role, or a value the Agent tool cannot take, runs as written.
// Before choosing, the hook reads this project's recent transcripts for a
// usage limit (model-limit.ts, #655): a role whose list names a model of
// another provider then runs on it, and the lead learns which worker to
// re-dispatch.
import { chooseSpawnModel, roleForAgentType } from "../core/role-models";
import { scanClaudeTranscripts } from "./model-limit";
import type { HookDecision } from "./protocol";

/** The Agent tool's `model` and `effort` enums (claude 2.1.309); anything else fails its schema. */
const ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** A full Claude model id (`claude-sonnet-5-5`, `anthropic/claude-opus-5`, `us.anthropic.claude-haiku-…`). */
const FULL_ID = /^(?:[\w.-]+[./])?claude-(?:\d[\d.-]*-)?(sonnet|opus|haiku|fable)(?:[-.@[]|$)/u;

/**
 * What the Agent tool's `model` takes for a configured value: an alias as is,
 * a full Claude id as its family alias (the tool takes only aliases), anything
 * else null.
 */
export const claudeAgentModel = (value: string): string | null => {
  const lower = value.trim().toLowerCase();
  if (ALIASES.has(lower)) return lower;
  return FULL_ID.exec(lower)?.[1] ?? null;
};

const given = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

export const agentModelDecision = (
  cwd: string,
  tool: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): HookDecision => {
  const limits = scanClaudeTranscripts(cwd, env).join("\n");
  const withLimits = (decision: HookDecision): HookDecision => {
    if (!limits) return decision;
    if (decision.kind === "update-input")
      return {
        ...decision,
        text: [decision.text, limits].filter(Boolean).join("\n"),
      };
    return decision.kind === "context"
      ? { kind: "context", text: `${decision.text}\n${limits}` }
      : { kind: "context", text: limits };
  };
  // The host fixes the model itself: nothing to fill, and `model` is not in its schema.
  if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) return withLimits({ kind: "none" });
  const selector = roleForAgentType(tool.subagent_type, tool.prompt);
  if (!selector) return withLimits({ kind: "none" });
  const choice = chooseSpawnModel(cwd, selector, "claude_code", tool, claudeAgentModel);
  const effort = choice.effort?.toLowerCase() ?? null;
  const input: Record<string, unknown> = { ...tool };
  if (choice.model) input.model = choice.model;
  if (effort && EFFORTS.has(effort) && !given(tool.effort)) input.effort = effort;
  if (input.model === tool.model && input.effort === tool.effort)
    return withLimits(choice.note ? { kind: "context", text: choice.note } : { kind: "none" });
  const text =
    choice.note ??
    `Workit set effort ${String(input.effort)} on this spawn: its role's configured effort.`;
  return withLimits({ kind: "update-input", input, text });
};
