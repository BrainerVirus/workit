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
// within one workspace `models.roles` wins over it. Everything is read
// leniently: a malformed entry is skipped and reported (`roleModelIssues`),
// never an error. Claude Code has built-in defaults; other hosts inherit
// their own default model when nothing is configured.
import { hostFamily, modelSources } from "./workspaces";

export const MODEL_ROLES = [
  "decider",
  "implementer",
  "verifier",
  "reviewer",
  "explore",
  "babysit",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const MODEL_TIERS = ["mundane", "standard", "hard"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type RoleSelector = { role: ModelRole; tier?: ModelTier };
export type RoleModel = { model: string; effort: string | null; source: string };

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

/** The value for `host` in a per-host object (or a flat value for every host). */
const forHost = (value: unknown, host: string | null) => {
  if (isFlat(value)) return leaf(value);
  if (!isObject(value)) return null;
  const family = host ? hostFamily(host) : null;
  for (const key of [family, host, "default"])
    if (key && Object.hasOwn(value, key)) {
      const found = leaf(value[key]);
      if (found) return found;
    }
  return null;
};

const rolesOf = (models: unknown): Record<string, unknown> | null =>
  isObject(models) && isObject(models.roles) ? models.roles : null;

/**
 * The model and effort for a role on a host, or null (the host's own default
 * applies). Order: the selected workspace, each enclosing workspace, the
 * global default (each: `models.roles`, then `fanout.tierModels` for an
 * implementer tier), then Claude Code's built-in defaults.
 */
export const resolveRoleModel = (
  cwd: string,
  selector: RoleSelector,
  host: string | null,
  dir?: string,
): RoleModel | null => {
  const { role, tier } = selector;
  for (const source of modelSources(cwd, dir)) {
    const where = source.global ? "the global default" : `workspace ${source.name}`;
    const roles = rolesOf(source.models);
    const configured = roles && Object.hasOwn(roles, role) ? roles[role] : undefined;
    const fromRoles =
      role === "implementer"
        ? tier && isObject(configured) && Object.hasOwn(configured, tier)
          ? forHost(configured[tier], host)
          : null
        : forHost(configured, host);
    if (fromRoles) return { ...fromRoles, source: `models.roles in ${where}` };
    if (role === "implementer" && tier && isObject(source.tierModels)) {
      const fromTiers = Object.hasOwn(source.tierModels, tier)
        ? forHost(source.tierModels[tier], host)
        : null;
      if (fromTiers)
        return { model: fromTiers.model, effort: null, source: `fanout.tierModels in ${where}` };
    }
  }
  if (host && hostFamily(host) === "claude_code") {
    const builtIn = BUILT_IN_CLAUDE_CODE[tier ? `${role}.${tier}` : role];
    if (builtIn)
      return { model: builtIn.model, effort: builtIn.effort ?? null, source: "built-in" };
  }
  return null;
};

/** Every selector `models show` lists, in role order. */
export const ROLE_SELECTORS: RoleSelector[] = MODEL_ROLES.flatMap((role): RoleSelector[] =>
  role === "implementer" ? MODEL_TIERS.map((tier) => ({ role, tier })) : [{ role }],
);

const valueIssues = (where: string, value: unknown, out: string[]): void => {
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
    const base = `${source.global ? "global default" : `workspace ${source.name}`} models.roles`;
    if (
      !isObject(source.models) ||
      (source.models.roles !== undefined && !rolesOf(source.models))
    ) {
      issues.push(`${base} is not an object; ignored`);
      continue;
    }
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
