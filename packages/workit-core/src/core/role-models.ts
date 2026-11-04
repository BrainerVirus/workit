// Role models (#395): the model and effort a role runs on, per host.
//
// `models.roles` in workspaces.json (top level = global default, per
// workspace = override, nested workspaces inherit like `fanout.tierModels`):
//
//   { "decider": { "claude_code": { "model": "fable", "effort": "high" } },
//     "implementer": { "hard": { "claude_code": "opus" }, "standard": … },
//     "verifier": { "claude_code": "sonnet", "default": "…" } }
//
// A role maps to a per-host object (keys: claude_code, opencode, codex,
// cursor, pi, default) whose values are a model name or `{ model, effort? }`.
// A bare model name or `{ model, effort? }` applies to every host. The
// implementer takes one such value per fanout tier. `fanout.tierModels` is
// read as the implementer tiers (a model name per tier and host, no effort);
// within one workspace `models.roles` wins over it. Any value may be an
// ordered list (`["opus", "openai/gpt-5"]`, or a list per host): the first
// model whose provider is not exhausted by a usage limit runs
// (core/model-fallback.ts, #655); `models.limitWindow` sets how long a limit
// with no reset time lasts (default 5h). Everything is read
// leniently: a malformed entry is skipped and reported (`roleModelIssues`),
// never an error. Claude Code has built-in defaults; other hosts inherit
// their own default model when nothing is configured.
//
// The `default` role is a spawn no Workit role claims (Claude Code's
// general-purpose, OpenCode's general). `models.lead` names the lead's own
// model, advisory on every host (none lets Workit pick the session model).
// A model the lead names on a spawn loses to a configured role model unless
// `models.allowLeadOverride` is true; a built-in default never overrides one.
import {
  exhaustionFor,
  parseWindow,
  providerOf,
  shortTime,
  type Exhaustion,
} from "./model-fallback";
import { hostFamily, modelSources } from "./workspaces";

export const MODEL_ROLES = [
  "decider",
  "implementer",
  "verifier",
  "reviewer",
  "explore",
  "babysit",
  "default",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const MODEL_TIERS = ["mundane", "standard", "hard"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type RoleSelector = { role: ModelRole; tier?: ModelTier };
export type RoleModel = {
  model: string;
  effort: string | null;
  source: string;
};
/** A role model chosen past exhausted providers: `skipped` names each model passed over. */
export type AvailableRoleModel = RoleModel & {
  skipped: Array<{
    model: string;
    provider: string;
    until: string;
    reason: string;
  }>;
  /** Every candidate is exhausted: the primary runs anyway. */
  allExhausted: boolean;
};

const HOST_KEYS = new Set([
  "claude_code",
  "opencode",
  "codex",
  "codex_cli",
  "codex_desktop",
  "cursor",
  "pi",
  "default",
]);

const BUILT_IN_CLAUDE_CODE: Record<string, { model: string; effort?: string }> = {
  decider: { model: "fable", effort: "high" },
  "implementer.hard": { model: "opus" },
  "implementer.standard": { model: "sonnet" },
  "implementer.mundane": { model: "haiku" },
  verifier: { model: "sonnet" },
  reviewer: { model: "opus" },
  explore: { model: "haiku" },
  babysit: { model: "haiku" },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** `"model"` or `{ model, effort? }` as a model and effort; null when it names no model. */
const leaf = (value: unknown): { model: string; effort: string | null } | null => {
  const text = name(value);
  if (text) return { model: text, effort: null };
  if (!isObject(value)) return null;
  const model = name(value.model);
  return model ? { model, effort: name(value.effort) } : null;
};

const isFlat = (value: unknown): boolean =>
  typeof value === "string" || (isObject(value) && Object.hasOwn(value, "model"));

type Leaf = { model: string; effort: string | null };

/** The ordered models for `host` in a value: a list, a per-host object or a flat value. */
const forHostList = (value: unknown, host: string | null): Leaf[] => {
  if (Array.isArray(value)) return value.flatMap((item) => forHostList(item, host));
  if (isFlat(value)) {
    const found = leaf(value);
    return found ? [found] : [];
  }
  if (!isObject(value)) return [];
  const family = host ? hostFamily(host) : null;
  for (const key of [family, host, "default"])
    if (key && Object.hasOwn(value, key)) {
      const found = Array.isArray(value[key])
        ? forHostList(value[key], host)
        : [leaf(value[key])].filter((one): one is Leaf => !!one);
      if (found.length) return found;
    }
  return [];
};

const rolesOf = (models: unknown): Record<string, unknown> | null =>
  isObject(models) && isObject(models.roles) ? models.roles : null;

/**
 * The model and effort for a role on a host now (the first of its list whose
 * provider is not exhausted), or null (the host's own default applies). Order: the selected workspace, each enclosing workspace, the
 * global default (each: `models.roles`, then `fanout.tierModels` for an
 * implementer tier), then Claude Code's built-in defaults.
 */
export const resolveRoleModel = (
  cwd: string,
  selector: RoleSelector,
  host: string | null,
  dir?: string,
): RoleModel | null => {
  const chosen = firstAvailable(resolveRoleModels(cwd, selector, host, dir), host);
  return chosen ? { model: chosen.model, effort: chosen.effort, source: chosen.source } : null;
};

/** Every model configured for a role on a host, in fallback order (see resolveRoleModel). */
export const resolveRoleModels = (
  cwd: string,
  selector: RoleSelector,
  host: string | null,
  dir?: string,
): RoleModel[] => {
  const { role, tier } = selector;
  for (const source of modelSources(cwd, dir)) {
    const where = source.global ? "the global default" : `workspace ${source.name}`;
    const roles = rolesOf(source.models);
    const configured = roles && Object.hasOwn(roles, role) ? roles[role] : undefined;
    const fromRoles =
      role === "implementer"
        ? tier && isObject(configured) && Object.hasOwn(configured, tier)
          ? forHostList(configured[tier], host)
          : []
        : forHostList(configured, host);
    if (fromRoles.length)
      return fromRoles.map((one) => ({
        ...one,
        source: `models.roles in ${where}`,
      }));
    if (role === "implementer" && tier && isObject(source.tierModels)) {
      const fromTiers = Object.hasOwn(source.tierModels, tier)
        ? forHostList(source.tierModels[tier], host)
        : [];
      if (fromTiers.length)
        return fromTiers.map((one) => ({
          model: one.model,
          effort: null,
          source: `fanout.tierModels in ${where}`,
        }));
    }
  }
  if (host && hostFamily(host) === "claude_code") {
    const builtIn = BUILT_IN_CLAUDE_CODE[tier ? `${role}.${tier}` : role];
    if (builtIn)
      return [
        {
          model: builtIn.model,
          effort: builtIn.effort ?? null,
          source: "built-in",
        },
      ];
  }
  return [];
};

/**
 * The first of `candidates` whose provider is not exhausted at `now`; the
 * primary when every one is (a limit already past its reset never counts).
 */
export const firstAvailable = (
  candidates: RoleModel[],
  host: string | null,
  now: Date = new Date(),
): AvailableRoleModel | null => {
  const [primary] = candidates;
  if (!primary) return null;
  const skipped: AvailableRoleModel["skipped"] = [];
  for (const candidate of candidates) {
    const blocked: (Exhaustion & { provider: string }) | null = exhaustionFor(
      candidate.model,
      host,
      now,
    );
    if (!blocked) return { ...candidate, skipped, allExhausted: false };
    skipped.push({ model: candidate.model, ...blocked });
  }
  return { ...primary, skipped, allExhausted: true };
};

/** The role's model on a host now: past every provider exhausted by a usage limit. */
export const resolveAvailableRoleModel = (
  cwd: string,
  selector: RoleSelector,
  host: string | null,
  now: Date = new Date(),
  dir?: string,
): AvailableRoleModel | null =>
  firstAvailable(resolveRoleModels(cwd, selector, host, dir), host, now);

/** Why a role runs on a fallback (or on an exhausted primary), for notes; null when it does not. */
export const fallbackText = (chosen: AvailableRoleModel): string | null => {
  if (!chosen.skipped.length) return null;
  const passed = chosen.skipped
    .map((one) => `${one.model} (${one.provider} exhausted until ${shortTime(one.until)})`)
    .join(", ");
  return chosen.allExhausted
    ? `every model configured for it is exhausted: ${passed}; it runs on ${chosen.model} anyway. Add a model of another provider to the list in workspaces.json, then run \`workit models show\`.`
    : `fell back past ${passed}.`;
};

/** `models.lead` for a host (nearest workspace, then the global default), or null. */
export const resolveLeadModel = (
  cwd: string,
  host: string | null,
  dir?: string,
): RoleModel | null => resolveLeadModels(cwd, host, dir)[0] ?? null;

/** Every `models.lead` model for a host, in fallback order. */
export const resolveLeadModels = (cwd: string, host: string | null, dir?: string): RoleModel[] => {
  for (const source of modelSources(cwd, dir)) {
    if (!isObject(source.models) || !Object.hasOwn(source.models, "lead")) continue;
    const found = forHostList(source.models.lead, host);
    if (found.length)
      return found.map((one) => ({
        ...one,
        source: `models.lead in ${source.global ? "the global default" : `workspace ${source.name}`}`,
      }));
  }
  return [];
};

const SWITCH_HOW: Record<string, string> = {
  claude_code: "/model",
  opencode: "/models",
  codex: "/model",
  cursor: "the model picker",
  pi: "/model",
};

/**
 * One line telling the lead to switch its own model (no host lets Workit
 * switch a running session's model): when `current` (the session's model, or
 * else the primary `models.lead`) runs on an exhausted provider. Names the
 * first available `models.lead` fallback; null when nothing is exhausted.
 */
export const leadSwitchNotice = (
  cwd: string,
  host: string,
  current: string | null,
  now: Date = new Date(),
  dir?: string,
): string | null => {
  const leads = resolveLeadModels(cwd, host, dir);
  const model = current ?? leads[0]?.model ?? null;
  if (!model) return null;
  const blocked = exhaustionFor(model, host, now);
  if (!blocked) return null;
  const next = leads.find((one) => !exhaustionFor(one.model, host, now));
  const how = SWITCH_HOW[hostFamily(host) ?? ""] ?? "the host's model switch";
  return next
    ? `Workit cannot switch this session's model: ${blocked.provider} is exhausted until ${shortTime(blocked.until)}. Switch the lead to ${next.model} with ${how}${hostFamily(host) === "claude_code" && providerOf(next.model, host) !== "anthropic" ? " (another host: Claude Code runs only Anthropic models)" : ""}.`
    : `Workit cannot switch this session's model: ${blocked.provider} is exhausted until ${shortTime(blocked.until)}, and models.lead names no model of another provider. Add one to models.lead in workspaces.json, then run \`workit models show\`.`;
};

/** `models.allowLeadOverride` (nearest source that sets it): true lets a spawn's own model win. */
export const leadOverrideAllowed = (cwd: string, dir?: string): boolean => {
  for (const source of modelSources(cwd, dir))
    if (isObject(source.models) && Object.hasOwn(source.models, "allowLeadOverride"))
      return source.models.allowLeadOverride === true;
  return false;
};

/** The hosts `models show` reports enforcement for, in the order it prints them. */
export const ENFORCEMENT_HOSTS = ["claude_code", "opencode", "codex", "cursor", "pi"] as const;
export type Enforcement = "enforced" | "advisory";

/**
 * Whether Workit applies a role's model on a host itself (`enforced`) or only
 * names it for the lead to pass (`advisory`). Claude Code (PreToolUse
 * updatedInput) and OpenCode (the plugin's subagent hook) set it on every
 * spawn; Codex writes it into its verifier, reviewer and implementer agent
 * files, Pi passes it to its reviewer, investigator and implementer workers
 * (the implementer on both only when the three tiers agree); Cursor has no
 * hook that can change a spawn. The lead's own model is advisory everywhere.
 */
export const roleEnforcement = (
  cwd: string,
  selector: RoleSelector | "lead",
  host: string,
  dir?: string,
): Enforcement => {
  if (selector === "lead") return "advisory";
  const family = hostFamily(host);
  if (family === "claude_code" || family === "opencode") return "enforced";
  const agents =
    family === "codex" ? ["verifier", "reviewer"] : family === "pi" ? ["reviewer", "explore"] : [];
  if (agents.includes(selector.role)) return "enforced";
  if (selector.role === "implementer" && (family === "codex" || family === "pi"))
    return uniformImplementerModel(cwd, host, dir) ? "enforced" : "advisory";
  return "advisory";
};

export type SpawnModelChoice = {
  /** The model the spawn should run on, or null to leave its own. */
  model: string | null;
  /** The effort to fill (only when the spawn names none), or null. */
  effort: string | null;
  /** Why Workit changed the spawn, for the lead; null when nothing changed. */
  note: string | null;
};

const roleLabel = (selector: RoleSelector): string =>
  selector.tier ? `${selector.role} ${selector.tier}` : selector.role;

/**
 * The model and effort a spawn for `selector` runs on: a spawn that names no
 * model gets the role's; one that names another model keeps it only when the
 * role model is a built-in default or `models.allowLeadOverride` is true.
 * `accept` maps a configured value to what the host's spawn takes (null: it
 * cannot take it, and the spawn runs as written with a note naming the fix).
 */
export const chooseSpawnModel = (
  cwd: string,
  selector: RoleSelector,
  host: string,
  given: { model?: unknown; effort?: unknown },
  accept: (model: string) => string | null,
  dir?: string,
): SpawnModelChoice => {
  const none: SpawnModelChoice = { model: null, effort: null, note: null };
  const all = resolveRoleModels(cwd, selector, host, dir);
  // A list for every host may name models this host cannot take: those are passed over.
  const takes = all.filter((one) => accept(one.model));
  const resolved = firstAvailable(takes.length ? takes : all, host);
  if (!resolved) return none;
  const givenModel = name(given.model);
  const label = roleLabel(selector);
  const configured = resolved.source !== "built-in";
  if (givenModel && (!configured || leadOverrideAllowed(cwd, dir))) return none;
  const model = accept(resolved.model);
  const effort = resolved.effort && !name(given.effort) ? resolved.effort : null;
  const fallback = fallbackText(resolved);
  const why = fallback ? ` Role ${label} ${fallback}` : "";
  if (!model)
    return {
      model: null,
      effort,
      note: `Workit could not apply ${resolved.model} (role ${label}, ${resolved.source}): this host's spawn does not take that model name, so the spawn runs on ${givenModel ?? "its default model"}.${why} Fix the value in workspaces.json, then run \`workit models show --role ${selector.role}\`.`,
    };
  if (givenModel && accept(givenModel) === model)
    return {
      ...none,
      effort,
      note: fallback ? `Workit kept ${model} on this spawn.${why}` : null,
    };
  // The exact spawn to write next time, so the lead's next call needs no rewrite.
  const next = `pass model: ${model}${resolved.effort ? `, effort: ${resolved.effort}` : ""}`;
  return {
    model,
    effort,
    note: givenModel
      ? `Workit replaced model ${givenModel} with ${model} on this spawn: role ${label} is set in ${resolved.source}.${why} Next time ${next} on the spawn. To let a spawn's own model win, set "allowLeadOverride": true under models in workspaces.json.`
      : `Workit set ${model}${effort ? ` (effort ${effort})` : ""} on this spawn: role ${label}, ${resolved.source}.${why}${configured ? "" : " Name a model to choose another."}`,
  };
};

/**
 * The implementer model when a host's agent serves every fanout tier (a Codex
 * agent file, a Pi worker): set only when all three tiers resolve to the same
 * model and effort, else null (the spawn or session decides per slice).
 */
export const uniformImplementerModel = (
  cwd: string,
  host: string | null,
  dir?: string,
): RoleModel | null => {
  const tiers = MODEL_TIERS.map((tier) =>
    resolveRoleModel(cwd, { role: "implementer", tier }, host, dir),
  );
  const [first] = tiers;
  return first && tiers.every((t) => t?.model === first.model && t.effort === first.effort)
    ? first
    : null;
};

/** Every selector `models show` lists, in role order. */
export const ROLE_SELECTORS: RoleSelector[] = MODEL_ROLES.flatMap((role): RoleSelector[] =>
  role === "implementer" ? MODEL_TIERS.map((tier) => ({ role, tier })) : [{ role }],
);

const valueIssues = (where: string, value: unknown, out: string[]): void => {
  if (Array.isArray(value)) {
    if (!value.length) out.push(`${where}: an empty list; ignored`);
    value.forEach((item, at) => valueIssues(`${where}[${at}]`, item, out));
    return;
  }
  if (isFlat(value)) {
    if (!leaf(value)) out.push(`${where}.model: not a model name; ignored`);
    if (isObject(value) && value.effort !== undefined && !name(value.effort))
      out.push(`${where}.effort: not an effort name; ignored`);
    return;
  }
  if (!isObject(value)) {
    out.push(`${where}: not a model name or a per-host object; ignored`);
    return;
  }
  for (const [host, entry] of Object.entries(value)) {
    if (!HOST_KEYS.has(host)) out.push(`${where}.${host}: unknown host; ignored`);
    else if (Array.isArray(entry)) valueIssues(`${where}.${host}`, entry, out);
    else {
      if (!leaf(entry)) out.push(`${where}.${host}.model: not a model name; ignored`);
      if (isObject(entry) && entry.effort !== undefined && !name(entry.effort))
        out.push(`${where}.${host}.effort: not an effort name; ignored`);
    }
  }
};

/**
 * What `models.roles` holds that Workit ignores (an unknown role, tier or
 * host, a value that is not a model name or effort), across the global
 * default and every workspace matching cwd. `workit doctor` and `workit grant
 * show` report them.
 */
export const roleModelIssues = (cwd: string, dir?: string): string[] => {
  const issues: string[] = [];
  for (const source of modelSources(cwd, dir)) {
    if (source.models === undefined) continue;
    const owner = `${source.global ? "global default" : `workspace ${source.name}`} models`;
    const base = `${owner}.roles`;
    if (
      !isObject(source.models) ||
      (source.models.roles !== undefined && !rolesOf(source.models))
    ) {
      issues.push(`${base} is not an object; ignored`);
      continue;
    }
    if (source.models.lead !== undefined) valueIssues(`${owner}.lead`, source.models.lead, issues);
    if (source.models.limitWindow !== undefined && !parseWindow(source.models.limitWindow))
      issues.push(`${owner}.limitWindow: not a duration such as "5h" or "1d 12h"; read as 5h`);
    if (
      source.models.allowLeadOverride !== undefined &&
      typeof source.models.allowLeadOverride !== "boolean"
    )
      issues.push(`${owner}.allowLeadOverride: not true or false; read as false`);
    for (const [role, value] of Object.entries(rolesOf(source.models) ?? {})) {
      const where = `${base}.${role}`;
      if (!(MODEL_ROLES as readonly string[]).includes(role))
        issues.push(`${base}.${role}: unknown role; ignored`);
      else if (role === "implementer") {
        if (!isObject(value)) issues.push(`${where}: not an object keyed by tier; ignored`);
        else
          for (const [tier, entry] of Object.entries(value))
            if (!(MODEL_TIERS as readonly string[]).includes(tier))
              issues.push(`${where}.${tier}: unknown tier; ignored`);
            else valueIssues(`${where}.${tier}`, entry, issues);
      } else valueIssues(where, value, issues);
    }
  }
  return issues;
};

/** A Workit agent by name on any host: `workit:<role>`, `workit-<role>` or the bare role. */
const AGENT_ROLE = /^(?:workit[:-])?(decider|implementer|verifier|reviewer|explore|babysit)$/iu;
/** A `ROLE: <role>` line in a spawn prompt, for a host agent Workit does not ship. */
const ROLE_LINE = /^[ \t]*ROLE:[ \t]*(decider|implementer|verifier|reviewer|explore|babysit)\b/imu;
const TIER_LINE = /^[ \t]*TIER:[ \t]*(mundane|standard|hard)\b/imu;
/** A Workit implementer brief: its TIER and WORKTREE lines. */
const isBrief = (text: string): boolean => TIER_LINE.test(text) && /^WORKTREE:/mu.test(text);
/** Spawn types with no role of their own: Claude Code's general-purpose (also its default), OpenCode's general. */
const GENERAL = new Set(["", "general-purpose", "general"]);

/**
 * The role a subagent spawn runs as, on any host: a Workit agent by name
 * (`workit:verifier`, `workit-verifier`, `verifier`, Claude Code's
 * `Explore`), else a `ROLE: <role>` line in the prompt, else an implementer
 * brief (TIER and WORKTREE lines) or `default` for a general spawn. A fork
 * (it inherits its parent's model) and any other type map to none. An
 * implementer's tier is its prompt's `TIER: <tier>` line, `standard` without one.
 */
export const roleForAgentType = (agentType: unknown, prompt?: unknown): RoleSelector | null => {
  const type = typeof agentType === "string" ? agentType.trim() : agentType == null ? "" : null;
  if (type === null || type === "fork") return null;
  const text = typeof prompt === "string" ? prompt : "";
  const general = GENERAL.has(type) ? (isBrief(text) ? "implementer" : "default") : null;
  const role = AGENT_ROLE.exec(type)?.[1] ?? ROLE_LINE.exec(text)?.[1] ?? general;
  if (!role) return null;
  const lower = role.toLowerCase() as ModelRole;
  if (lower !== "implementer") return { role: lower };
  const tier = TIER_LINE.exec(text)?.[1]?.toLowerCase() as ModelTier | undefined;
  return { role: lower, tier: tier ?? "standard" };
};
