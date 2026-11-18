// Role models on a Claude Code subagent spawn (#420, #654, D1): a Workit
// agent's own file carries its model and effort, and a model the spawn names
// wins. A spawn whose role is configured to another model or effort than its
// agent file (or a general spawn's role) is filled through PreToolUse
// `updatedInput` with a note; under auto mode, which refuses a hook-rewritten
// call, it runs as written and the lead gets one line naming what ran and
// what is configured. Only `models.enforce: "strict"` holds a spawn to its
// configured model (a named one too, unless `models.allowLeadOverride`):
// under auto mode it is denied once with the exact Agent args. A type with no
// role, or a value the Agent tool cannot take, runs as written. Before
// choosing, the hook reads this project's recent transcripts for a usage
// limit (model-limit.ts, #655): a role whose list names a model of another
// provider then runs on it, and the lead learns which worker to re-dispatch.
import {
  CLAUDE_AGENT_FILES,
  CLAUDE_EFFORTS,
  chooseSpawnModel,
  claudeAgentModel,
  enforceMode,
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
      `workit spawn args: ${reasons.join(" ")}`,
      `Retry as: Agent ${args} (description and prompt as written${without}).`,
      "Why: auto mode refuses a hook-rewritten spawn.",
      limits,
    ]
      .filter(Boolean)
      .join("\n"),
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
 * A spawn missing its role's model or effort (one its agent file does not
 * carry): outside auto mode an `updatedInput` fill with a note naming them;
 * under auto mode, which refuses an `updatedInput` rewrite (retro 2026-11-07
 * R1), one context line, or under `models.enforce: "strict"` a deny naming the
 * exact args.
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
  const file = String(tool.subagent_type).startsWith("workit:")
    ? CLAUDE_AGENT_FILES[selector.role]
    : undefined;
  const effort = choice.effort?.toLowerCase() ?? null;
  const input: Record<string, unknown> = { ...tool };
  if (choice.model && (given(tool.model) || choice.model !== file?.model))
    input.model = choice.model;
  if (effort && CLAUDE_EFFORTS.has(effort) && !given(tool.effort) && effort !== file?.effort)
    input.effort = effort;
  const needs = [
    input.model === tool.model ? null : `model ${String(input.model)}`,
    input.effort === tool.effort ? null : `effort ${String(input.effort)}`,
  ].filter(Boolean);
  if (!needs.length) return asWritten(choice.model ? null : choice.note);
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
  if (enforceMode(cwd) === "advise") {
    if (changed) return respawn(tool, change.reasons, change.dropped, limits);
    const ran = file ? `${file.model}${file.effort ? `/${file.effort}` : ""}` : "its default model";
    const pass = spawnArgsText({ model: input.model, effort: input.effort });
    return asWritten(
      `Workit: this ${String(tool.subagent_type || "general-purpose")} spawn runs on ${ran}; ${choice.basis} sets ${needs.join(" and ")}. To use it, pass ${pass} on the spawn.`,
    );
  }
  const replaced = given(tool.model) && input.model !== tool.model;
  return respawn(
    input,
    [
      ...change.reasons,
      `It needs ${needs.join(" and ")} (${choice.basis}, models.enforce strict)${replaced ? `, not ${String(tool.model)}` : ""}.`,
    ],
    change.dropped,
    limits,
  );
};
