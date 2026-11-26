// Agent stamps' file layout (agent-stamp.ts, #883) and the Codex launcher's
// cheap pre-checks and post-tool cleanup for them (#994), free of the runtime
// so the launcher's quiet path can load it: a stamp dir per calling session, a tag per tool
// call. The Claude Code launcher (bin/workit-hook.mjs) holds copies.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../core/workit-paths.mjs";

export const stampHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Where the stamps of one calling session (on Codex, one thread) are filed. */
export const stampDir = (env: NodeJS.ProcessEnv, session: string): string =>
  path.join(stateDir(env), "agent-stamps", stampHash(session));

/** The tool call a stamp belongs to, in its file name. */
export const callTag = (toolUseId: string): string => stampHash(toolUseId).slice(0, 8);

/** A command that backgrounds part of itself (`&`): its `workit` may still be running. */
export const backgrounds = (command: string): boolean => /(?:^|[^&<>])&(?![&>])/u.test(command);

/** Removes the stamps one finished tool call left under `session`. */
export const dropCallStamps = (
  env: NodeJS.ProcessEnv,
  session: string,
  toolUseId: string,
): void => {
  try {
    const dir = stampDir(env, session);
    const tag = `.${callTag(toolUseId)}-`;
    for (const name of fs.readdirSync(dir))
      if (name.includes(tag)) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // No stamp dir: nothing to drop.
  }
};

/** Text that may run `workit`: the runtime stamps the call with its calling thread. */
export const mayRunWorkit = (text: string): boolean =>
  /(?:^|[\s;&|(])(?:\S*[\\/])?workit(?:\s|$)/u.test(text);

/**
 * The Codex launcher's PostToolUse: a finished `workit` call's unclaimed
 * stamps go, filed under the calling thread (agent_id, else session_id); a
 * backgrounded `&` call may still claim its own, so it keeps them.
 */
export const dropPostToolStamps = (env: NodeJS.ProcessEnv, payload: string): void => {
  try {
    const value = JSON.parse(payload) as {
      hook_event_name?: unknown;
      session_id?: unknown;
      agent_id?: unknown;
      tool_use_id?: unknown;
      tool_input?: { command?: unknown };
    };
    const command = value.tool_input?.command;
    const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
    const thread =
      typeof value.agent_id === "string" && value.agent_id.trim()
        ? value.agent_id
        : value.session_id;
    if (
      value.hook_event_name === "PostToolUse" &&
      typeof thread === "string" &&
      thread &&
      typeof value.tool_use_id === "string" &&
      value.tool_use_id &&
      mayRunWorkit(text) &&
      !backgrounds(text)
    )
      dropCallStamps(env, thread, value.tool_use_id);
  } catch {
    // An unreadable payload drops nothing.
  }
};

const IDENTITY_ENV =
  /WORKIT_(?:AGENT_ID|HOST|SESSION_ID|SESSION_TOKEN)|\benv\b[^\n;&|]*\s(?:-[a-z]*i|--ignore-environment|-)(?:\s|$)/u;
const STATE_NAME =
  "(?:WORKIT_(?:STATE_DIR|CONFIG)\\w*|XDG_(?:STATE|CONFIG|DATA)_HOME|HOME|USERPROFILE|(?:LOCAL)?APPDATA|OPENCODE_SESSION_ID|PI_SESSION_ID|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)";
const STATE_ENV = new RegExp(
  `${STATE_NAME}\\s*\\+?=|(?:unset|-u|--unset)[\\s=]+${STATE_NAME}|env:|EnvironmentVariable`,
  "iu",
);

/**
 * Text that may set, unset or clear an identity, state or host variable
 * (`NAME=`, `env -u`, `env -i`): the runtime's identity guard reads it
 * (identity-env.ts, #883, #980). The Claude Code launcher's HOST_ENV and
 * ENV_BUILTIN matter only beside a `workit` call, which goes to the runtime anyway.
 */
export const mayChangeIdentity = (text: string): boolean => {
  const bare = text.replace(/['"\\]/gu, "");
  return IDENTITY_ENV.test(bare) || STATE_ENV.test(bare);
};
