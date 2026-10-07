// The acting host session for a `workit` call made from an agent's shell.
// WORKIT_SESSION_ID, when set, wins (Claude Code exports it from SessionStart; a lead
// assigns one to a verifier), unless WORKIT_HOST shows it came from another host. Otherwise the id each host itself puts in its
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

const family = (host: string | null): string | null =>
  host?.replace(/_(?:cli|desktop)$/, "") ?? null;

/**
 * WORKIT_HOST/WORKIT_SESSION_ID, else the host's own shell session variable.
 * A WORKIT_SESSION_ID whose WORKIT_HOST names another host was inherited from
 * an outer session (Codex started from Claude Code's Bash): the inner host's
 * own id wins, so the CLI acts as the session that host's hooks see.
 */
export function hostSessionFromEnv(env: NodeJS.ProcessEnv): HostSession {
  const value = (key: string): string | null => env[key]?.trim() || null;
  let inner: HostSession | null = null;
  for (const [key, host] of HOST_SESSION_VARS) {
    const session = value(key);
    if (session) {
      inner = { host: host(env), session };
      break;
    }
  }
  const declared = value("WORKIT_HOST");
  // Set, even empty, it is the answer: `WORKIT_SESSION_ID=` opts out of the fallback.
  if (env.WORKIT_SESSION_ID !== undefined) {
    const inherited =
      inner !== null && declared !== null && family(declared) !== family(inner.host);
    if (!inherited) return { host: declared, session: value("WORKIT_SESSION_ID") };
  }
  return inner ? { host: inner.host, session: inner.session } : { host: declared, session: null };
}
