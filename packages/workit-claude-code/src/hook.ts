// Claude Code hook entry. Every hook in hooks/hooks.json runs one process
// (bin/workit-hook.mjs): stdin (native payload) → core/hooks claude-code
// adapter → stdout.
// The plugin adds only what is Claude-specific and process-scoped:
// SessionStart exports WORKIT_HOST/WORKIT_SESSION_ID through $CLAUDE_ENV_FILE,
// so `workit` calls on the Bash tool know their host. The core resends
// per-turn task context only when it changed (descriptor turnResend on-change).
import { appendFileSync } from "node:fs";
import { claudeCodeAdapter, dispatchHook, type HostAdapter } from "@brainervirus/workit-core/hooks";

type Sink = { write(chunk: string): unknown };

/** Session-start addendum: how the shared contract's names map onto this plugin. */
export const CLAUDE_ADDENDUM =
  "Claude Code: the workit-<name> skills are this plugin's /workit:<name> skills " +
  "(workit-shape is /workit:shape). Run workit verbs with the `workit` CLI on the Bash " +
  "tool (`workit --help`); run `workit ci wait` in the background. Agents: `implementer` " +
  "builds one brief in an isolated worktree and never records a verdict; `verifier` and " +
  "`reviewer` are read-only non-authors that record `workit ledger verdict` with the " +
  "`--session` the SubagentStart hook names for them (subagents share this session's WORKIT_SESSION_ID).";

const adapter: HostAdapter = { ...claudeCodeAdapter, addendum: () => CLAUDE_ADDENDUM };
type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

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
  const payload = isRecord(raw) ? raw : {};
  const sessionId = text(payload.session_id);
  if (sessionId && !result.error && payload.hook_event_name === "SessionStart")
    exportSessionEnv(env, sessionId);
  stdout.write(`${JSON.stringify(result.json)}\n`);
  return result.exitCode;
}
