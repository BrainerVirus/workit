// A subagent's own id on its `workit` calls (#883). Claude Code and Codex put
// no subagent id in a subagent's shell: it inherits the lead's session, so its
// check rows read as the lead's. A hook cannot add one either: Claude Code
// matches allow rules against a rewritten command (a `WORKIT_AGENT_ID=<a>`
// prefix loses every `Bash(workit <verb> *)` rule) and auto mode refuses a
// call whose input a hook changed. So the pre-tool hook, which sees the
// calling agent, leaves a stamp per plain `workit …` call it lets through:
// `<state>/agent-stamps/<session hash>/<argv hash>.<agent id or empty>.<nonce>`,
// written for the lead's calls too. The CLI claims the stamp its own session
// and argv name and acts with that WORKIT_AGENT_ID; its check row records
// `agentFrom: "stamp"` (#972). No stamp, a stale one or two callers with one
// argv (ambiguous) leave the id unset and the row `agentFrom: "none"`: on a
// stamping host (host-session.ts STAMPING_HOSTS) a verdict is held only to stamped rows, so
// such a run is nobody's, never another agent's. Every failure is silent.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./core/workit-paths.mjs";
import { hostSessionFromEnv, realHostSession } from "./host-session";
import { unwrapped } from "./hooks/delivery-verbs";
import { segmentsOf, type ShellDialect } from "./hooks/shell-words";

/**
 * Where a check row's agent id came from (#972): a claimed stamp, the caller's
 * WORKIT_AGENT_ID (no host), or nowhere (a host and no stamp to claim).
 */
export type AgentFrom = "stamp" | "env" | "none";

/** How long a stamp waits for its call to start (a permission prompt included). */
const STAMP_TTL_MS = 120_000;
/** A host agent id Workit stamps: shell- and file-name-safe. */
const AGENT_ID = /^[\w-]{1,64}$/u;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
const stampDir = (env: NodeJS.ProcessEnv, session: string): string =>
  path.join(stateDir(env), "agent-stamps", hash(session));

/** The argv of each plain `workit …` call in `command`; a call with a word the shell expands is skipped. */
export const workitCalls = (command: string, dialect: ShellDialect = "posix"): string[][] => {
  const calls: string[][] = [];
  try {
    for (const { words, expands = [] } of segmentsOf(command, dialect)) {
      const call = unwrapped(words);
      const at = words.length - call.length;
      if (/^(?:.*[\\/])?workit$/u.test(call[0] ?? "") && !expands.some((index) => index >= at))
        calls.push(call.slice(1));
    }
  } catch {
    // An unanalyzable command stamps nothing.
  }
  return calls;
};

/** Pre-tool: stamp each `workit` call in `command` with the calling agent (null: the lead). */
export const noteAgentStamps = (
  env: NodeJS.ProcessEnv,
  session: string | null,
  agentId: string | null,
  command: string,
  options: { dialect?: ShellDialect; toolUseId?: string | null } = {},
): void => {
  if (!session || !command.includes("workit") || (agentId !== null && !AGENT_ID.test(agentId)))
    return;
  const calls = workitCalls(command, options.dialect);
  if (!calls.length) return;
  const call = options.toolUseId ? callTag(options.toolUseId) : randomBytes(4).toString("hex");
  try {
    const dir = stampDir(env, session);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const name of fs.readdirSync(dir))
      if (now - fs.statSync(path.join(dir, name)).mtimeMs > STAMP_TTL_MS)
        fs.rmSync(path.join(dir, name), { force: true });
    calls.forEach((argv, index) =>
      fs.writeFileSync(
        path.join(dir, `${hash(argv.join("\0"))}.${agentId ?? ""}.${call}-${index}`),
        "",
      ),
    );
  } catch {
    // Hooks fail open: the call runs unstamped.
  }
};

/** The tool call a stamp belongs to, in its file name (the Claude Code launcher holds a copy). */
const callTag = (toolUseId: string): string => hash(toolUseId).slice(0, 8);

/**
 * Post-tool: the stamps a finished call left unclaimed (a `workit` in a branch
 * that did not run) go, so they cannot make a later call of that argv
 * ambiguous. A call that may still be running (a background `&`) keeps them.
 */
export const dropAgentStamps = (
  env: NodeJS.ProcessEnv,
  session: string | null,
  toolUseId: string | null,
  command: string,
): void => {
  if (
    !session ||
    !toolUseId ||
    !command.includes("workit") ||
    /(?:^|[^&<>])&(?![&>])/u.test(command)
  )
    return;
  try {
    const dir = stampDir(env, session);
    const tag = `.${callTag(toolUseId)}-`;
    for (const name of fs.readdirSync(dir))
      if (name.includes(tag)) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // No stamp dir: nothing to drop.
  }
};

/**
 * Variables a host itself puts in its shell, so clearing WORKIT_HOST alone
 * does not read as no host (clearing them all, `env -i`, the hook denies).
 */
const HOST_SET = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
];

/**
 * Whether this shell runs under an agent host. There only a claimed stamp
 * names the agent (Claude Code, Codex; OpenCode and Pi children carry their
 * own `<lead>:<child>` session instead): a WORKIT_AGENT_ID the caller exported
 * is not the host's word, as an unissued `<lead>:<x>` session is not.
 */
export const agentIdFromHostOnly = (env: NodeJS.ProcessEnv): boolean =>
  realHostSession(env).kind !== "none" || HOST_SET.some((name) => env[name]?.trim());

/**
 * CLI: the stamp for this session and `argv`, consuming it: `agentId` names
 * the subagent, or is null for the lead's own call. Null when no single fresh
 * stamp answers (none, stale or ambiguous).
 */
export const claimAgentStamp = (
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): { agentId: string | null } | null => {
  const { session } = hostSessionFromEnv(env);
  if (!session) return null;
  try {
    const dir = stampDir(env, session);
    const prefix = `${hash(argv.join("\0"))}.`;
    const now = Date.now();
    const fresh = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((stamp) => now - stamp.at <= STAMP_TTL_MS)
      .toSorted((a, b) => a.at - b.at);
    const agents = new Set(fresh.map((stamp) => stamp.name.split(".")[1]));
    const [oldest] = fresh;
    if (agents.size !== 1 || !oldest) return null;
    // Another call claiming it first throws here: that call was the stamped one.
    fs.unlinkSync(path.join(dir, oldest.name));
    return { agentId: oldest.name.split(".")[1] || null };
  } catch {
    return null;
  }
};
