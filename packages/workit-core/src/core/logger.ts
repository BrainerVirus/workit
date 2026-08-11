import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Secret-safe structured logger (DG-01-DG-03, DG-05, DG-10). Host-neutral:
// node: builtins only. Never logs prompts, messages, content, raw tool
// arguments/results, credentials, tokens, authorization headers, issue data,
// URL queries, home prefixes, or unbounded stacks. Every record is bounded,
// redacted, rate-limited JSONL under a daily filename.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  level: LogLevel;
  time: string;
  message: string;
  context: Record<string, JsonValue>;
};

export type LogSink = (event: LogEvent) => void;

export type LoggerOptions = {
  stateDir?: string;
  now?: () => Date;
  appLog?: LogSink;
  stderr?: LogSink;
  maxRate?: number;
  rateWindowMs?: number;
  maxFieldLength?: number;
  maxStackLines?: number;
};

export type Logger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  guard: <T>(name: string, fn: () => T) => T | undefined;
};

export const REDACTED = "[REDACTED]";

const DEFAULT_MAX_RATE = 20;
const DEFAULT_RATE_WINDOW_MS = 1000;
const DEFAULT_MAX_FIELD_LENGTH = 200;
const DEFAULT_MAX_STACK_LINES = 30;

const DAY_FILE = /^workit-\d{4}-\d{2}-\d{2}\.jsonl$/;
const RETAINED_DAYS = 7;

// Home prefixes, URL queries, and inline secret values are redacted inside any
// string. Key names drive the rest: a field whose name contains a secret or
// content word is fully replaced, a stack/trace field is line-bounded.
const SECRET_VALUE = /\b(?:Bearer|Basic|Digest|Token)\s+\S+/g;
const KEY_EQ_VALUE =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api[_-]?key|authorization|credential|bearer)[A-Za-z0-9_-]*)([:=]\s*).+/g;
const URL_QUERY = /(https?:\/\/[^?#\s]+)\?[^#\s]*/g;

const splitKey = (key: string): string[] =>
  key.split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])/).map((word) => word.toLowerCase());

const SENSITIVE_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "api",
  "apikey",
  "key",
  "bearer",
  "prompt",
  "message",
  "messages",
  "content",
  "body",
  "args",
  "argument",
  "result",
  "results",
  "output",
  "issue",
  "description",
  "summary",
  "payload",
  "script",
  "command",
  "text",
  "query",
]);

const STACK_WORDS = new Set(["stack", "stacktrace", "trace"]);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const resolveStateDir = (): string => {
  const override = process.env.WORKFLOW_TOOLKIT_STATE;
  if (override) return override;
  const home = os.homedir();
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "workit");
  switch (os.platform()) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "workit");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "workit");
    default:
      return path.join(process.env.HOME ?? home, ".local", "state", "workit");
  }
};

type RedactOptions = {
  maxFieldLength: number;
  maxStackLines: number;
};

const homePattern = new RegExp(`${escapeRegExp(os.homedir())}(?=/|$)|\\$HOME(?=/|$)`, "g");

const applyPatterns = (value: string): string => {
  let out = value;
  out = out.replace(SECRET_VALUE, REDACTED);
  out = out.replace(KEY_EQ_VALUE, "$1$2[REDACTED]");
  out = out.replace(URL_QUERY, "$1?[REDACTED]");
  out = out.replace(homePattern, "~");
  return out;
};

const redactString = (value: string, options: RedactOptions): string => {
  const out = applyPatterns(value);
  if (out.length > options.maxFieldLength) {
    return `${out.slice(0, options.maxFieldLength)}…`;
  }
  return out;
};

const boundStack = (value: unknown, options: RedactOptions): JsonValue => {
  if (typeof value !== "string") return redact(value, options);
  const lines = value.split("\n");
  const kept = lines.slice(0, options.maxStackLines).map(applyPatterns);
  const dropped = lines.length - kept.length;
  const body = dropped > 0 ? [...kept, `    ... ${dropped} more`] : kept;
  return body.join("\n");
};

export const redact = (value: unknown, options: RedactOptions = DEFAULT_OPTIONS): JsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value, options);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redact(entry, options));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const words = splitKey(key);
      if (words.some((word) => STACK_WORDS.has(word))) out[key] = boundStack(entry, options);
      else if (words.some((word) => SENSITIVE_WORDS.has(word))) out[key] = REDACTED;
      else out[key] = redact(entry, options);
    }
    return out;
  }
  return null;
};

const DEFAULT_OPTIONS: RedactOptions = {
  maxFieldLength: DEFAULT_MAX_FIELD_LENGTH,
  maxStackLines: DEFAULT_MAX_STACK_LINES,
};

const dailyFileName = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `workit-${y}-${m}-${d}.jsonl`;
};

const pruneOldFiles = (dir: string): void => {
  try {
    const files = readdirSync(dir)
      .filter((name) => DAY_FILE.test(name))
      .sort()
      .reverse();
    for (const file of files.slice(RETAINED_DAYS)) {
      try {
        unlinkSync(path.join(dir, file));
      } catch {
        // a concurrent prune may already have removed it
      }
    }
  } catch {
    // logging must never break the host
  }
};

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const stateDir = options.stateDir ?? resolveStateDir();
  const logDir = path.join(stateDir, "logs");
  const now = options.now ?? (() => new Date());
  const maxRate = options.maxRate ?? DEFAULT_MAX_RATE;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const redactOptions: RedactOptions = {
    maxFieldLength: options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH,
    maxStackLines: options.maxStackLines ?? DEFAULT_MAX_STACK_LINES,
  };

  let windowStart = 0;
  const windowCounts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const date = now();
    const elapsed = date.getTime() - windowStart;
    if (elapsed >= rateWindowMs || windowStart === 0) {
      windowStart = date.getTime();
      windowCounts.debug = 0;
      windowCounts.info = 0;
      windowCounts.warn = 0;
      windowCounts.error = 0;
    }
    windowCounts[level] += 1;
    if (windowCounts[level] > maxRate) return;

    // ponytail: per-level budget so an info flood can't starve warn/error
    // canaries; shared-token budget would need cross-level prioritization.
    let event: LogEvent | null = null;
    try {
      event = {
        level,
        time: date.toISOString(),
        message: redactString(message, redactOptions),
        context: redact(context ?? {}, redactOptions) as Record<string, JsonValue>,
      };
      const line = `${JSON.stringify(event)}\n`;
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      appendFileSync(path.join(logDir, dailyFileName(date)), line, { mode: 0o600 });
      pruneOldFiles(logDir);
    } catch {
      // Serialization (e.g. a circular context) must never throw into the
      // caller: record a bounded failure event instead.
      try {
        event = {
          level,
          time: date.toISOString(),
          message: redactString(message, redactOptions),
          context: { redaction_failed: true },
        };
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        appendFileSync(path.join(logDir, dailyFileName(date)), `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      } catch {
        // logging must never break the host
      }
    }

    for (const sink of [options.appLog, options.stderr]) {
      if (!sink) continue;
      if (!event) continue;
      try {
        sink(event);
      } catch {
        // a broken sink must not break the caller
      }
    }
  };

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    guard: <T>(name: string, fn: () => T): T | undefined => {
      try {
        return fn();
      } catch (err) {
        emit("warn", "detector_failed", {
          detector: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },
  };
};
