// Usage limits seen by a host hook (#655). A tool or assistant error that
// names a provider usage limit (Claude Code's `You've hit your weekly limit ·
// resets 7pm (America/Santiago)`, its 5-hour and per-model limits, OpenAI's
// usage limit, a 429 quota or a long retry-after) marks the provider
// exhausted until the parsed reset, else until `models.limitWindow` (default
// 5h) has passed. A short 429 rate limit is not a usage limit.
//
// Claude Code: the Agent hook (agent-model.ts) reads the tails of this
// project's recent transcripts, where a dead worker's last assistant entry is
// the limit text. OpenCode: the plugin's subagent execute.after hands the
// result or error text here.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimRedispatch,
  firstSighting,
  limitWindowMs,
  markExhausted,
  promptKey,
  providerOf,
  shortTime,
} from "../core/model-fallback";

export type UsageLimit = {
  /** The provider the text names, else null (the caller knows the model). */
  provider: string | null;
  /** A per-model limit (Claude's Opus or Sonnet limit), else null. */
  family: string | null;
  /** The reset the text names, else null. */
  resetAt: Date | null;
};

const LIMIT_PATTERNS = [
  /\busage limit\b/iu,
  /\bhit your\b[^.\n]{0,40}\blimit\b/iu,
  /\b(?:weekly|daily|monthly|5-hour|five-hour|session|opus|sonnet|fable|haiku) limit (?:reached|exceeded|hit)\b/iu,
  /\bexceeded your (?:current )?quota\b|\binsufficient_quota\b|\bquota (?:exceeded|exhausted)\b/iu,
];
/** A 429 or rate_limit counts only with a quota word or a long wait. */
const RATE_LIMIT = /\b429\b|\brate[_ ]limit/iu;
const LONG_WAIT_MS = 15 * 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AT_TIME = new RegExp(
  String.raw`\b(?:resets?|reset at|try again at|available again at|retry at)\s+(?:at\s+|on\s+)?` +
    String.raw`(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?` +
    String.raw`(?:(${MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?` +
    String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:/[A-Za-z_+-]+)*)\))?`,
  "iu",
);
const IN_DURATION =
  /\b(?:try again|resets?|retry|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/iu;
const RETRY_AFTER = /\bretry[- ]after\b["':\s]+(\d+)/iu;
const EPOCH = /\|(\d{10})\b/u;
const UNIT_MS: Array<[RegExp, number]> = [
  [/^d/u, 86_400_000],
  [/^h/u, 3_600_000],
  [/^m/u, 60_000],
  [/^s/u, 1000],
];

const durationMs = (text: string): number => {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/giu))
    total += Number(amount) * (UNIT_MS.find(([re]) => re.test(unit.toLowerCase()))?.[1] ?? 0);
  return total;
};

/** Milliseconds a zone is ahead of UTC at `at`. */
const zoneOffset = (zone: string, at: Date): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return local - (at.getTime() - at.getUTCMilliseconds());
};

const validZone = (zone: string | undefined): string => {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) return fallback;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
};

/** The next `hour:minute` in `zone` after `now` (on `month`/`day` when given). */
const nextWallTime = (
  now: Date,
  zone: string,
  hour: number,
  minute: number,
  date: { month: number; day: number } | null,
): Date => {
  const local = new Date(now.getTime() + zoneOffset(zone, now));
  const year = local.getUTCFullYear();
  let wall = date
    ? Date.UTC(year, date.month, date.day, hour, minute)
    : Date.UTC(year, local.getUTCMonth(), local.getUTCDate(), hour, minute);
  if (wall <= local.getTime())
    wall = date ? Date.UTC(year + 1, date.month, date.day, hour, minute) : wall + 86_400_000;
  const guess = wall - zoneOffset(zone, new Date(wall));
  return new Date(wall - zoneOffset(zone, new Date(guess)));
};

const resetFrom = (text: string, now: Date): Date | null => {
  const epoch = EPOCH.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const at = AT_TIME.exec(text);
  if (at && (at[5] || at[4] || at[6])) {
    const [, month, day, hourText, minuteText, meridiem, zone] = at;
    let hour = Number(hourText);
    if (hour > 23 || (meridiem && hour > 12)) return null;
    if (meridiem?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (meridiem?.toLowerCase() === "am" && hour === 12) hour = 0;
    const date = month
      ? {
          month: MONTHS.indexOf(month.toLowerCase().slice(0, 3)),
          day: Number(day),
        }
      : null;
    return nextWallTime(now, validZone(zone), hour, Number(minuteText ?? 0), date);
  }
  const span = IN_DURATION.exec(text);
  if (span) {
    const ms = durationMs(span[1]);
    if (ms > 0) return new Date(now.getTime() + ms);
  }
  const retry = RETRY_AFTER.exec(text);
  if (retry) return new Date(now.getTime() + Number(retry[1]) * 1000);
  return null;
};

const providerIn = (text: string): string | null => {
  if (/\b(?:claude|anthropic)\b/iu.test(text)) return "anthropic";
  if (/\b(?:openai|chatgpt|codex)\b|\bgpt-/iu.test(text)) return "openai";
  return null;
};

/**
 * The usage limit `text` reports, or null: a short rate limit, an unrelated
 * error or ordinary prose is none.
 */
export const parseUsageLimit = (text: string, now: Date = new Date()): UsageLimit | null => {
  if (!text || text.length > 20_000) return null;
  const resetAt = resetFrom(text, now);
  const limit = LIMIT_PATTERNS.some((pattern) => pattern.test(text));
  const longRateLimit =
    RATE_LIMIT.test(text) && resetAt !== null && resetAt.getTime() - now.getTime() >= LONG_WAIT_MS;
  if (!limit && !longRateLimit) return null;
  const family = /\b(opus|sonnet|fable|haiku) limit\b/iu.exec(text)?.[1]?.toLowerCase() ?? null;
  return { provider: providerIn(text), family, resetAt };
};

export type LimitSeen = {
  provider: string;
  key: string;
  until: string;
  reason: string;
};

/**
 * Mark the provider of a usage limit in `text` exhausted. `model` is the model
 * that ran (its provider wins over one the text names); `host` resolves a bare
 * model name. Null when `text` is no usage limit or names no provider.
 */
export const recordUsageLimit = (
  text: string,
  context: { cwd: string; host: string; model?: string | null; now?: Date },
): LimitSeen | null => {
  const now = context.now ?? new Date();
  const limit = parseUsageLimit(text, now);
  if (!limit) return null;
  const provider =
    (context.model ? providerOf(context.model, context.host) : null) ??
    limit.provider ??
    providerOf("", context.host);
  if (!provider) return null;
  const family = limit.family ?? null;
  const key = family && provider === "anthropic" ? `${provider}/${family}` : provider;
  const until =
    limit.resetAt && limit.resetAt.getTime() > now.getTime()
      ? limit.resetAt
      : new Date(now.getTime() + limitWindowMs(context.cwd));
  const reason = text.trim().split("\n")[0] ?? "";
  const entry = markExhausted(key, until, reason, now);
  return { provider, key, until: entry.until, reason };
};

/**
 * The note for the lead when a worker died on a usage limit: re-dispatch it
 * once with the same prompt (its role now runs on the next model), or, when
 * that prompt was already re-dispatched, not again.
 */
export const redispatchNote = (
  seen: LimitSeen,
  worker: { label: string; prompt: string | null },
  now: Date = new Date(),
): string => {
  const opening = `Workit: ${worker.label} died on a usage limit (${seen.reason || seen.provider}); ${seen.key} is marked exhausted until ${shortTime(seen.until)}.`;
  if (worker.prompt && !claimRedispatch(promptKey(worker.prompt), now))
    return `${opening} It was already re-dispatched once after a limit: do not re-dispatch it again; check \`workit models show\` and wait for the reset or add a model of another provider to its role.`;
  return `${opening} Re-dispatch it once with the same prompt: its role now runs on the next model in its list (\`workit models show\` names it).`;
};

const TAIL_BYTES = 16_384;

const tail = (file: string, size: number): string => {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
};

const start = (file: string): string => {
  const buffer = Buffer.alloc(TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, TAIL_BYTES, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

type Entry = Record<string, unknown>;
const parse = (line: string): Entry | null => {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Entry) : null;
  } catch {
    return null;
  }
};

const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: unknown; text?: unknown; content?: unknown }) =>
      typeof part?.text === "string"
        ? part.text
        : typeof part?.content === "string"
          ? part.content
          : "",
    )
    .join("\n");
};

/**
 * The last assistant entry of a transcript tail when it is an API error
 * (Claude Code writes one as a synthetic assistant message), else null: a
 * worker's own report that mentions a limit is not one.
 */
const lastApiError = (text: string): string | null => {
  const lines = text.split("\n").filter(Boolean).toReversed();
  for (const line of lines) {
    const entry = parse(line);
    if (entry?.type !== "assistant") continue;
    const model = (entry.message as { model?: unknown } | undefined)?.model;
    const apiError = entry.isApiErrorMessage === true || !!entry.error || model === "<synthetic>";
    return apiError ? textOf(entry.message) : null;
  }
  return null;
};

/** The first user prompt of a subagent transcript (its spawn prompt), or null. */
const firstPrompt = (file: string): string | null => {
  for (const line of start(file).split("\n")) {
    const entry = parse(line);
    if (entry?.type === "user") return textOf(entry.message) || null;
  }
  return null;
};

/** Claude Code's project directory name for a cwd. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/gu, "-");

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

const SCAN_MS = 30 * 60_000;

/**
 * Claude Code (#655): read this project's transcripts written in the last 30
 * minutes; each whose last assistant entry is a usage limit marks Anthropic
 * (or the model family) exhausted, once per transcript state. Returns a note
 * per worker that died on it and a switch notice when the lead itself did.
 */
export const scanClaudeTranscripts = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): string[] => {
  const projects = path.join(
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"),
    "projects",
  );
  const project = path.join(projects, claudeProjectSlug(cwd));
  const notes: string[] = [];
  const files = listDir(project).flatMap((entry) =>
    entry.endsWith(".jsonl")
      ? [{ file: entry, worker: false }]
      : listDir(path.join(entry, "subagents"))
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => ({ file, worker: true })),
  );
  for (const { file, worker } of files)
    try {
      const stat = statSync(file);
      if (now.getTime() - stat.mtimeMs > SCAN_MS) continue;
      const last = lastApiError(tail(file, stat.size));
      if (!last || !parseUsageLimit(last, now)) continue;
      if (!firstSighting(`${file}:${stat.size}`, now)) continue;
      const seen = recordUsageLimit(last, { cwd, host: "claude_code", now });
      if (!seen) continue;
      notes.push(
        worker
          ? redispatchNote(
              seen,
              {
                label: `worker ${path.basename(file, ".jsonl")}`,
                prompt: firstPrompt(file),
              },
              now,
            )
          : `Workit: this session hit a usage limit (${seen.reason}); ${seen.key} is marked exhausted until ${shortTime(seen.until)}. Claude Code runs only Anthropic models: Workit cannot switch this session, so continue on another host or after the reset.`,
      );
    } catch {
      // An unreadable transcript is skipped.
    }
  return notes;
};
