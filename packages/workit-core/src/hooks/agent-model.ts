// Role models on a Claude Code subagent spawn (#420, #654): a spawn runs on
// its role's model (and effort) from the role config. A model the spawn names
// wins over a built-in default, and over a configured one only with
// `models.allowLeadOverride`. A spawn that lacks its role's values is filled
// through PreToolUse `updatedInput` with a note naming them for next time,
// except under auto mode, which refuses a hook-rewritten call (retro
// 2026-11-07 R1): there it is denied once with the exact Agent args to pass.
// A type with no role, or a value the Agent tool cannot take, runs as written.
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

/**
 * What an earlier gate changed on the spawn: the keys it removed, why (for a
 * deny) and the note for a rewrite.
 */
export type SpawnChange = { dropped: string[]; reasons: string[]; notes: string[] };

const NO_CHANGE: SpawnChange = { dropped: [], reasons: [], notes: [] };

/**
 * One deny with the exact args of the spawn Workit would run, the same text
 * every time, so the lead retries once and the retry passes as written.
 */
const respawn = (
  input: Record<string, unknown>,
  reasons: string[],
  dropped: string[],
  limits: string,
): HookDecision => {
  const args = spawnArgsText(input);
  const without = dropped.length ? ` and no ${dropped.join(" or ")}` : "";
  return {
    kind: "deny",
    reason: [
      `workit spawn args: spawn again with exactly ${args} (description and prompt as written${without}).`,
      ...reasons,
      "Workit denies instead of rewriting the spawn: Claude Code's auto mode refuses a hook-rewritten spawn.",
      limits,
    ]
      .filter(Boolean)
      .join(" "),
    unblock: args,
  };
};

/** The exact values the lead's next spawn should pass (W2.21), so it runs as written. */
const withNextSpawn = (text: string, input: Record<string, unknown>): string => {
  if (text.includes("Next time pass")) return text;
  const values = [
    given(input.model) ? `model: ${String(input.model)}` : null,
    given(input.effort) ? `effort: ${String(input.effort)}` : null,
  ].filter(Boolean);
  return values.length
    ? `${text} Next time pass ${values.join(", ")} on the spawn, so it runs as written.`
    : text;
};

export type SpawnOptions = {
  env?: NodeJS.ProcessEnv;
  /** What the spawn gate already changed (isolation). */
  change?: SpawnChange;
  /** The session's permission mode (Claude Code `permission_mode`). */
  permissionMode?: string | null;
};

/**
 * A spawn missing its role's model or effort: under auto mode a deny naming
 * the exact args (retro 2026-11-07 R1: auto mode refuses an `updatedInput`
 * rewrite), in any other mode an `updatedInput` fill with a note naming them.
 */
export const agentModelDecision = (
  cwd: string,
  tool: Record<string, unknown>,
  options: SpawnOptions = {},
): HookDecision => {
  const env = options.env ?? process.env;
  const change = options.change ?? NO_CHANGE;
  const auto = options.permissionMode === "auto";
  const limits = scanClaudeTranscripts(cwd, env).join("\n");
  const changed = change.dropped.length > 0;
  const asWritten = (note: string | null): HookDecision => {
    if (changed && auto) return respawn(tool, change.reasons, change.dropped, limits);
    const text = [...change.notes, note, limits].filter(Boolean).join("\n");
    if (changed) return { kind: "update-input", input: tool, text };
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
  if (!auto) {
    const note =
      choice.note ??
      `Workit set effort ${String(input.effort)} on this spawn: its role's configured effort.`;
    return {
      kind: "update-input",
      input,
      text: [...change.notes, withNextSpawn(note, input), limits].filter(Boolean).join("\n"),
    };
  }
  const replaced = given(tool.model) && input.model !== tool.model;
  return respawn(
    input,
    [
      ...change.reasons,
      `It needs ${needs.join(" and ")}: ${choice.basis ?? "its role"}.`,
      replaced
        ? `That replaces model ${String(tool.model)}: a configured role model wins unless "allowLeadOverride": true is set under models in workspaces.json.`
        : "",
    ].filter(Boolean),
    change.dropped,
    limits,
  );
};
