// Role models on a Claude Code subagent spawn (#420, #654): a spawn runs on
// its role's model (and effort) from the role config. A model the spawn names
// wins over a built-in default, and over a configured one only with
// `models.allowLeadOverride`. A spawn that lacks its role's values is denied
// once with the exact Agent args to pass, never rewritten: Claude Code's auto
// mode refuses a call a hook rewrote through `updatedInput` (retro 2026-11-07
// R1), and the spawn hook is not told the session's permission mode. A type
// with no role, or a value the Agent tool cannot take, runs as written.
// Before choosing, the hook reads this project's recent transcripts for a
// usage limit (model-limit.ts, #655): a role whose list names a model of
// another provider then runs on it, and the lead learns which worker to
// re-dispatch.
import {
  CLAUDE_EFFORTS,
  chooseSpawnModel,
  claudeAgentModel,
  roleForAgentType,
} from "../core/role-models";
import { scanClaudeTranscripts } from "./model-limit";
import type { HookDecision } from "./protocol";

const given = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** Keys a respawn lists first; `description` and `prompt` stay as written and are not repeated. */
const LEADING = ["subagent_type", "model", "effort", "run_in_background"];
const UNLISTED = new Set(["description", "prompt"]);

/** The Agent args to pass, as `key: value` pairs in a fixed order, `description` and `prompt` aside. */
const spawnArgsText = (input: Record<string, unknown>): string =>
  [...LEADING.filter((key) => Object.hasOwn(input, key)), ...Object.keys(input)]
    .filter(
      (key, at, keys) => !UNLISTED.has(key) && input[key] !== undefined && keys.indexOf(key) === at,
    )
    .map((key) => `${key}: ${JSON.stringify(input[key])}`)
    .join(", ");

/** What an earlier gate changed on the spawn: the keys it removed and why. */
export type SpawnChange = { dropped: string[]; reasons: string[] };

const NO_CHANGE: SpawnChange = { dropped: [], reasons: [] };

/**
 * One deny with the exact args of the spawn Workit would run, the same text
 * every time, so the lead retries once in any permission mode and the retry
 * passes as written.
 */
const respawn = (
  input: Record<string, unknown>,
  change: SpawnChange,
  limits: string,
): HookDecision => {
  const args = spawnArgsText(input);
  const without = change.dropped.length ? ` and no ${change.dropped.join(" or ")}` : "";
  return {
    kind: "deny",
    reason: [
      `workit spawn args: spawn again with exactly ${args} (description and prompt as written${without}).`,
      ...change.reasons,
      "Workit denies instead of rewriting the spawn: Claude Code's auto mode refuses a hook-rewritten spawn.",
      limits,
    ]
      .filter(Boolean)
      .join(" "),
    unblock: args,
  };
};

export const agentModelDecision = (
  cwd: string,
  tool: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  change: SpawnChange = NO_CHANGE,
): HookDecision => {
  const limits = scanClaudeTranscripts(cwd, env).join("\n");
  const changed = change.dropped.length > 0;
  const asWritten = (note: string | null): HookDecision => {
    if (changed) return respawn(tool, change, limits);
    const text = [note, limits].filter(Boolean).join("\n");
    return text ? { kind: "context", text } : { kind: "none" };
  };
  // The host fixes the model itself: nothing to fill, and `model` is not in its schema.
  if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) return asWritten(null);
  const selector = roleForAgentType(tool.subagent_type, tool.prompt);
  if (!selector) return asWritten(null);
  const choice = chooseSpawnModel(cwd, selector, "claude_code", tool, claudeAgentModel);
  const effort = choice.effort?.toLowerCase() ?? null;
  const input: Record<string, unknown> = { ...tool };
  if (choice.model) input.model = choice.model;
  if (effort && CLAUDE_EFFORTS.has(effort) && !given(tool.effort)) input.effort = effort;
  const needs = [
    input.model === tool.model ? null : `model ${String(input.model)}`,
    input.effort === tool.effort ? null : `effort ${String(input.effort)}`,
  ].filter(Boolean);
  if (!needs.length) return asWritten(choice.note);
  const replaced = given(tool.model) && input.model !== tool.model;
  return respawn(
    input,
    {
      dropped: change.dropped,
      reasons: [
        ...change.reasons,
        `It needs ${needs.join(" and ")}: ${choice.basis ?? "its role"}.`,
        replaced
          ? `That replaces model ${String(tool.model)}: a configured role model wins unless "allowLeadOverride": true is set under models in workspaces.json.`
          : "",
      ].filter(Boolean),
    },
    limits,
  );
};
