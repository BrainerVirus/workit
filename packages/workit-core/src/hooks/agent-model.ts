// Role models on a Claude Code subagent spawn (#420): a spawn that names no
// `model` gets its role's model (and effort) from the role config, through
// PreToolUse `updatedInput` on the Agent tool. An explicit `model` always
// wins and a spawn is never denied over its model: a type with no role, or a
// role with nothing usable configured, runs as the caller wrote it.
import { resolveRoleModel, roleForAgentType } from "../core/role-models";
import type { HookDecision } from "./protocol";

/** The Agent tool's `model` and `effort` enums (claude 2.1.309); anything else fails its schema. */
const MODELS = new Set(["sonnet", "opus", "haiku", "fable"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const given = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

export const agentModelDecision = (
  cwd: string,
  tool: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): HookDecision => {
  // The host fixes the model itself: nothing to fill, and `model` is not in its schema.
  if (given(tool.model) || env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) return { kind: "none" };
  const selector = roleForAgentType(tool.subagent_type, tool.prompt);
  if (!selector) return { kind: "none" };
  const resolved = resolveRoleModel(cwd, selector, "claude_code");
  if (!resolved) return { kind: "none" };
  const model = resolved.model.toLowerCase();
  const effort = resolved.effort?.toLowerCase() ?? null;
  const input: Record<string, unknown> = { ...tool };
  if (MODELS.has(model)) input.model = model;
  if (effort && EFFORTS.has(effort) && !given(tool.effort)) input.effort = effort;
  if (input.model === undefined && input.effort === tool.effort) return { kind: "none" };
  const label = selector.tier ? `${selector.role} ${selector.tier}` : selector.role;
  return {
    kind: "update-input",
    input,
    text: `Workit set ${String(input.model ?? "no model")}${
      input.effort !== tool.effort ? ` (effort ${String(input.effort)})` : ""
    } on this ${String(tool.subagent_type)} spawn: role ${label}, ${resolved.source}. Name a model to choose another.`,
  };
};
