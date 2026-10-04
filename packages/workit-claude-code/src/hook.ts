// Claude Code hook entry. Every hook in hooks/hooks.json runs one process
// (bin/workit-hook.mjs): stdin (native payload) → core/hooks claude-code
// adapter → stdout.
// The plugin adds only what is Claude-specific and process-scoped:
//   - SessionStart exports WORKIT_HOST/WORKIT_SESSION_ID through
//     $CLAUDE_ENV_FILE, so `workit` calls on the Bash tool know their host;
//   - UserPromptSubmit re-injects task context only when it changed since the
//     last injection for the session (each hook is a fresh process, so the
//     cache lives in ${CLAUDE_PLUGIN_DATA}/ctx/<session>.json).
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook, type HostAdapter } from "@brainervirus/workit-core/hooks";

type Sink = { write(chunk: string): unknown };

/** Session-start addendum: how the shared contract's names map onto this plugin. */
export const CLAUDE_ADDENDUM =
  "Claude Code: the workit-<name> skills are this plugin's /workit:<name> skills " +
  "(workit-shape is /workit:shape). Run workit verbs with the `workit` CLI on the Bash " +
  "tool (`workit --help`); run `workit ci wait` in the background. Agents: `implementer` " +
  "builds one brief in an isolated worktree and never records a verdict; `verifier` and " +
  "`reviewer` are read-only non-authors that record `workit ledger verdict`.";

const adapter: HostAdapter = { ...claudeCodeAdapter, addendum: () => CLAUDE_ADDENDUM };
type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** A filename-safe key for a session id (ids are opaque host strings). */
const sessionKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 32);

const contextCache = (env: NodeJS.ProcessEnv, sessionId: string): string | null => {
  const data = text(env.CLAUDE_PLUGIN_DATA);
  return data ? path.join(data, "ctx", `${sessionKey(sessionId)}.json`) : null;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** SessionStart side effect: best effort, never changes the hook decision. */
const exportSessionEnv = (env: NodeJS.ProcessEnv, sessionId: string): void => {
  const file = text(env.CLAUDE_ENV_FILE);
  if (!file) return;
  try {
    appendFileSync(
      file,
      `export WORKIT_HOST=claude_code\nexport WORKIT_SESSION_ID=${shellQuote(sessionId)}\n`,
    );
  } catch {
    // An unwritable env file only loses the convenience export.
  }
};

const digestOf = (context: string) => createHash("sha256").update(context).digest("hex");

const recordTurnContext = (file: string, digest: string): void => {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ digest })}\n`);
  } catch {
    // Unwritable plugin data dir: context is simply sent every turn.
  }
};

/**
 * Per-turn dedup: returns true when `context` equals the last context
 * injected for this session (and records it otherwise). Any cache failure
 * answers false, so context is re-sent rather than lost.
 */
const unchangedTurnContext = (file: string | null, context: string): boolean => {
  if (!file) return false;
  const digest = digestOf(context);
  try {
    const previous = JSON.parse(readFileSync(file, "utf8")) as { digest?: unknown };
    if (previous.digest === digest) return true;
  } catch {
    // Missing or unreadable cache: treat as changed.
  }
  recordTurnContext(file, digest);
  return false;
};

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Drops per-session caches untouched for a week (sessions that ended). */
const pruneContextCaches = (dir: string, now: number): void => {
  try {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > CACHE_TTL_MS) rmSync(file, { force: true });
      } catch {
        // Raced with another session: nothing to prune.
      }
    }
  } catch {
    // No cache dir yet.
  }
};

/**
 * SessionStart already injected the task context (inside the contract), so
 * the session's cache is seeded with the per-turn context the next prompt
 * would carry: the first turn after a start, resume or compaction does not
 * resend it. A session without task context clears the cache instead.
 */
const seedTurnContext = (
  file: string | null,
  payload: Payload,
  env: NodeJS.ProcessEnv,
  now: number,
): void => {
  if (!file) return;
  pruneContextCaches(path.dirname(file), now);
  const turn = dispatchHook(adapter, { ...payload, hook_event_name: "UserPromptSubmit" }, env);
  const output = isRecord(turn.json.hookSpecificOutput) ? turn.json.hookSpecificOutput : null;
  const context = output ? text(output.additionalContext) : null;
  if (context && !turn.error) recordTurnContext(file, digestOf(context));
  else rmSync(file, { force: true });
};

/** Runs one Claude Code hook invocation and returns the process exit code. */
export async function runClaudeHook(
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: Sink,
  stderr: Sink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let input = "";
  for await (const chunk of stdin) input += String(chunk);
  let raw: unknown;
  try {
    raw = JSON.parse(input || "{}");
  } catch {
    raw = undefined;
  }
  const result = dispatchHook(adapter, raw, env);
  if (raw === undefined || result.error)
    stderr.write(
      `[workit] hook input rejected: ${raw === undefined ? "invalid JSON hook input" : result.error}\n`,
    );
  let json = result.json;
  const payload = isRecord(raw) ? raw : {};
  const sessionId = text(payload.session_id);
  if (sessionId && !result.error) {
    const cache = contextCache(env, sessionId);
    if (payload.hook_event_name === "SessionStart") {
      exportSessionEnv(env, sessionId);
      seedTurnContext(cache, payload, env, Date.now());
    } else if (payload.hook_event_name === "UserPromptSubmit") {
      const output = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : null;
      const context = output ? text(output.additionalContext) : null;
      if (context && unchangedTurnContext(cache, context)) json = {};
    }
  }
  stdout.write(`${JSON.stringify(json)}\n`);
  return result.exitCode;
}
