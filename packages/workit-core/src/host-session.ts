// The acting host session for a `workit` call made from an agent's shell.
// WORKIT_SESSION_ID, when set, wins (Claude Code exports it from SessionStart; a lead
// assigns one to a verifier). Otherwise the id each host itself puts in its
// shell tool's environment is used, so commits and verdicts made on those
// hosts carry the same session id their hooks see (M5):
//   - OpenCode V2: OPENCODE_SESSION_ID (the shell tool's session id);
//   - Pi: PI_SESSION_ID (the bash tool exposes the Pi session id);
//   - Codex CLI and Desktop: CODEX_THREAD_ID (the thread id hooks get as session_id).
// Cursor puts no conversation id in its shell; its hook names the id to use.

export type HostSession = { host: string | null; session: string | null };

const HOST_SESSION_VARS: ReadonlyArray<readonly [string, (env: NodeJS.ProcessEnv) => string]> = [
  ["OPENCODE_SESSION_ID", () => "opencode"],
  ["PI_SESSION_ID", () => "pi"],
  [
    "CODEX_THREAD_ID",
    (env) =>
      env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" ||
      env.CODEX_ELECTRON_RESOURCES_PATH
        ? "codex_desktop"
        : "codex_cli",
  ],
];

/** WORKIT_HOST/WORKIT_SESSION_ID, else the host's own shell session variable. */
export function hostSessionFromEnv(env: NodeJS.ProcessEnv): HostSession {
  const value = (key: string): string | null => env[key]?.trim() || null;
  // Set, even empty, it is the answer: `WORKIT_SESSION_ID=` opts out of the fallback.
  if (env.WORKIT_SESSION_ID !== undefined)
    return { host: value("WORKIT_HOST"), session: value("WORKIT_SESSION_ID") };
  for (const [key, host] of HOST_SESSION_VARS) {
    const session = value(key);
    if (session) return { host: value("WORKIT_HOST") ?? host(env), session };
  }
  return { host: value("WORKIT_HOST"), session: null };
}
