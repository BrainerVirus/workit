// Model fallback on a usage limit (#655): a subscription that hits its usage
// limit (Anthropic 5-hour or weekly, OpenAI usage limit, a 429 quota) is
// marked exhausted until its reset, per user, in `model-limits.json` under the
// state dir. A role whose `models.roles` value is an ordered list then runs on
// the first model whose provider is not exhausted (core/role-models.ts), and
// on its primary again once the reset passes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./logger";
import { hostFamily, modelSources } from "./workspaces";

export const LIMITS_FILE = "model-limits.json";
export const DEFAULT_LIMIT_WINDOW_MS = 5 * 3_600_000;
/** Entries older than this are dropped on the next write. */
const KEEP_MS = 9 * 86_400_000;

export type Exhaustion = { until: string; since: string; reason: string };
type Store = {
  exhausted: Record<string, Exhaustion>;
  /** Limit evidence already counted (a transcript tail, an OpenCode call). */
  seen: Record<string, string>;
  /** Worker prompts already re-dispatched once after a limit. */
  redispatched: Record<string, string>;
};

const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

/** The Claude family a model name belongs to (`opus` for `claude-opus-5`), or null. */
const modelFamily = (model: string): string | null =>
  FAMILIES.find((family) => model.toLowerCase().includes(family)) ?? null;

/**
 * The subscription a model runs on: the `provider/` prefix when it has one
 * (OpenCode's `providerID/modelID`, a gateway's `anthropic/claude-…`), else
 * `anthropic` for a Claude name, `openai` for a GPT, o-series or Codex name,
 * else the host's own provider (Claude Code: anthropic, Codex: openai), else null.
 */
export const providerOf = (model: string, host?: string | null): string | null => {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (/^(?:claude|sonnet|opus|haiku|fable)\b|(?:^|[.-])claude-/u.test(trimmed)) return "anthropic";
  if (/^(?:gpt|o\d|codex|chatgpt)\b/u.test(trimmed)) return "openai";
  const family = host ? hostFamily(host) : null;
  if (family === "claude_code") return "anthropic";
  if (family === "codex") return "openai";
  return null;
};

const empty = (): Store => ({ exhausted: {}, seen: {}, redispatched: {} });

const storePath = (stateDir?: string) => path.join(stateDir ?? resolveStateDir(), LIMITS_FILE);

const readStore = (stateDir?: string): Store => {
  try {
    const parsed = JSON.parse(readFileSync(storePath(stateDir), "utf8")) as Partial<Store>;
    const store = empty();
    for (const key of ["exhausted", "seen", "redispatched"] as const)
      if (parsed[key] && typeof parsed[key] === "object") Object.assign(store[key], parsed[key]);
    return store;
  } catch {
    return empty();
  }
};

/** Best effort: a read-only state dir never fails a hook. */
const writeStore = (store: Store, now: Date, stateDir?: string): void => {
  const cutoff = now.getTime() - KEEP_MS;
  for (const key of ["seen", "redispatched"] as const)
    for (const [id, at] of Object.entries(store[key]))
      if (!(Date.parse(at) > cutoff)) delete store[key][id];
  for (const [id, entry] of Object.entries(store.exhausted))
    if (!(Date.parse(entry.until) > cutoff)) delete store.exhausted[id];
  try {
    const file = storePath(stateDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(temp, file);
  } catch {
    // The limit is noticed again next time.
  }
};

/**
 * Mark `key` (a provider, or `provider/family` for a per-model limit such as
 * Claude's Opus limit) exhausted until `until`; a later reset already on
 * record is kept.
 */
export const markExhausted = (
  key: string,
  until: Date,
  reason: string,
  now: Date = new Date(),
  stateDir?: string,
): Exhaustion => {
  const store = readStore(stateDir);
  const previous = store.exhausted[key];
  const entry =
    previous && Date.parse(previous.until) >= until.getTime()
      ? previous
      : {
          until: until.toISOString(),
          since: now.toISOString(),
          reason: reason.slice(0, 200),
        };
  store.exhausted[key] = entry;
  writeStore(store, now, stateDir);
  return entry;
};

/** Providers (or `provider/family` keys) exhausted at `now`, soonest reset first. */
export const exhaustedProviders = (
  now: Date = new Date(),
  stateDir?: string,
): Array<Exhaustion & { provider: string }> =>
  Object.entries(readStore(stateDir).exhausted)
    .filter(([, entry]) => Date.parse(entry.until) > now.getTime())
    .map(([provider, entry]) => ({ provider, ...entry }))
    .toSorted((a, b) => Date.parse(a.until) - Date.parse(b.until));

/** The exhaustion that blocks `model` on `host` at `now`, or null when it may run. */
export const exhaustionFor = (
  model: string,
  host: string | null,
  now: Date = new Date(),
  stateDir?: string,
): (Exhaustion & { provider: string }) | null => {
  const provider = providerOf(model, host);
  if (!provider) return null;
  const family = modelFamily(model);
  const keys = new Set([provider, ...(family ? [`${provider}/${family}`] : [])]);
  return exhaustedProviders(now, stateDir).find((entry) => keys.has(entry.provider)) ?? null;
};

/** Record a piece of limit evidence once; false when it was already counted. */
export const firstSighting = (id: string, now: Date = new Date(), stateDir?: string): boolean => {
  const store = readStore(stateDir);
  if (store.seen[id]) return false;
  store.seen[id] = now.toISOString();
  writeStore(store, now, stateDir);
  return true;
};

/** A stable key for a worker's prompt. */
export const promptKey = (prompt: string): string =>
  createHash("sha256").update(prompt.trim()).digest("hex").slice(0, 16);

/**
 * Whether a worker whose prompt is `key` may be re-dispatched after dying on a
 * limit: true the first time (and recorded), false once it was re-dispatched.
 */
export const claimRedispatch = (
  key: string,
  now: Date = new Date(),
  stateDir?: string,
): boolean => {
  const store = readStore(stateDir);
  if (store.redispatched[key]) return false;
  store.redispatched[key] = now.toISOString();
  writeStore(store, now, stateDir);
  return true;
};

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

/** `5h`, `90m`, `2d`, `1d 12h` or a number of hours as milliseconds; null when unreadable. */
export const parseWindow = (value: unknown): number | null => {
  if (typeof value === "number") return value > 0 ? value * 3_600_000 : null;
  if (typeof value !== "string" || !value.trim()) return null;
  let total = 0;
  const rest = value
    .trim()
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*([dhms])/gu, (_all, amount: string, unit: string) => {
      total += Number(amount) * UNITS[unit];
      return "";
    });
  return rest.trim() === "" && total > 0 ? total : null;
};

/**
 * How long a provider stays exhausted when its limit text names no reset:
 * `models.limitWindow` (nearest workspace, then the global default), else 5h.
 */
export const limitWindowMs = (cwd: string, dir?: string): number => {
  for (const source of modelSources(cwd, dir)) {
    const models = source.models as Record<string, unknown> | undefined;
    if (models && typeof models === "object" && Object.hasOwn(models, "limitWindow")) {
      const parsed = parseWindow(models.limitWindow);
      if (parsed) return parsed;
    }
  }
  return DEFAULT_LIMIT_WINDOW_MS;
};

/** `2026-11-03 19:00` in the local zone, for notes and `models show`. */
export const shortTime = (iso: string): string => {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
