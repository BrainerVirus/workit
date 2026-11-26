// A subagent's own id on its `workit` calls (#883). Claude Code and Codex put
// no subagent id in a subagent's shell: it inherits the lead's session, so its
// check rows read as the lead's. A hook cannot add one either: Claude Code
// matches allow rules against a rewritten command (a `WORKIT_AGENT_ID=<a>`
// prefix loses every `Bash(workit <verb> *)` rule) and auto mode refuses a
// call whose input a hook changed. So the pre-tool hook, which sees the
// calling agent, leaves a stamp per plain `workit …` call it lets through:
// `<state>/agent-stamps/<session hash>/<argv hash>.<agent id or empty>.<nonce>`,
// written for the lead's calls too. The CLI claims the stamp its own session
// and argv name and acts with that WORKIT_AGENT_ID. No stamp, a stale one or
// two callers with one argv (ambiguous) leave the id unset: a run then reads
// as the lead's, never as another agent's. Every failure is silent.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./core/workit-paths.mjs";
import { hostSessionFromEnv } from "./host-session";
import { unwrapped } from "./hooks/delivery-verbs";
import { segmentsOf, type ShellDialect } from "./hooks/shell-words";

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
 * CLI: the agent id the stamp for this session and `argv` names, consuming
 * it; null when WORKIT_AGENT_ID is already set, for a lead's call, or when no
 * single fresh stamp answers.
 */
export const claimAgentStamp = (env: NodeJS.ProcessEnv, argv: readonly string[]): string | null => {
  const { session } = hostSessionFromEnv(env);
  if (env.WORKIT_AGENT_ID?.trim() || !session) return null;
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
    return oldest.name.split(".")[1] || null;
  } catch {
    return null;
  }
};
