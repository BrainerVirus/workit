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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook, type HostAdapter } from "@brainervirus/workit-core/hooks";

type Sink = { write(chunk: string): unknown };

/** Session-start addendum: how the shared contract's names map onto this plugin. */
export const CLAUDE_ADDENDUM =
  "Claude Code: the workit-<name> skills are this plugin's /workit:<name> skills " +
  "(workit-steer is /workit:steer). Run Workit operations with the `workit` CLI on the " +
  "Bash tool (`workit --help`). The plugin's verifier and reviewer agents are read-only; " +
  "its implementer agent works in an isolated worktree.";

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

/**
 * Per-turn dedup: returns true when `context` equals the last context
 * injected for this session (and records it otherwise). Any cache failure
 * answers false, so context is re-sent rather than lost.
 */
const unchangedTurnContext = (file: string | null, context: string): boolean => {
  if (!file) return false;
  const digest = createHash("sha256").update(context).digest("hex");
  try {
    const previous = JSON.parse(readFileSync(file, "utf8")) as { digest?: unknown };
    if (previous.digest === digest) return true;
  } catch {
    // Missing or unreadable cache: treat as changed.
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ digest })}\n`);
  } catch {
    // Unwritable plugin data dir: context is simply sent every turn.
  }
  return false;
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
      // A fresh or compacted conversation no longer holds the old context.
      if (cache) rmSync(cache, { force: true });
    } else if (payload.hook_event_name === "UserPromptSubmit") {
      const output = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : null;
      const context = output ? text(output.additionalContext) : null;
      if (context && unchangedTurnContext(cache, context)) json = {};
    }
  }
  stdout.write(`${JSON.stringify(json)}\n`);
  return result.exitCode;
}
