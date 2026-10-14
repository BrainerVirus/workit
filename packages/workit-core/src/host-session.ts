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

/**
 * The session the host itself vouches for in this shell: its own shell
 * variable (OPENCODE_SESSION_ID, PI_SESSION_ID, CODEX_THREAD_ID), which a
 * caller cannot replace by exporting WORKIT_SESSION_ID. Hosts that put no id
 * in the shell (Claude Code, Cursor, a plain terminal) fall back to the
 * WORKIT_SESSION_ID their hooks export: there the id is declared, not derived.
 */
export function realHostSession(env: NodeJS.ProcessEnv): HostSession & { derived: boolean } {
  for (const [key, host] of HOST_SESSION_VARS) {
    const session = env[key]?.trim();
    if (session) return { host: host(env), session, derived: true };
  }
  const declared = hostSessionFromEnv(env);
  return { ...declared, derived: false };
}

/**
 * Hosts whose child sessions run their own shell with their own host session
 * id: a child proves itself from its own shell, so a lead never mints a child id.
 */
const OWN_CHILD_SHELL = new Set(["opencode", "pi"]);

const SESSION_UNSAFE = /[^A-Za-z0-9_.:@/+-]/g;

/**
 * The host-derived identity of a child session: `<lead>:<child>`, the shape
 * Claude Code's SubagentStart hook gives a subagent. The child's own id is
 * kept whole (it is what the host vouches for); the lead part is trimmed to
 * fit the ledger's 128-character session grammar.
 */
export function childSessionId(lead: string, child: string): string {
  const leaf = child.replace(SESSION_UNSAFE, "-").slice(-120);
  const prefix = lead.replace(SESSION_UNSAFE, "-").slice(0, 127 - leaf.length);
  return prefix ? `${prefix}:${leaf}` : leaf;
}

export type SessionClaimRefusal = { error: string; unblock: string };

/**
 * Whether `claimed` may act as this shell's session: the host session itself,
 * a host-derived child id ending in it (`<lead>:<this session>`), or, on hosts
 * whose subagents share the lead's shell (Claude Code, Codex, Cursor), a child
 * id the lead's hook derived from it (`<this session>:<agent id>`). Anything
 * else is a forged id: a verdict recorded under it would make author is not
 * verifier a naming convention.
 */
export function sessionClaimRefusal(
  env: NodeJS.ProcessEnv,
  claimed: string,
): SessionClaimRefusal | null {
  const real = realHostSession(env);
  if (!real.session)
    return {
      error: `session ${claimed} cannot be checked: this shell has no host session (no OPENCODE_SESSION_ID, PI_SESSION_ID, CODEX_THREAD_ID or WORKIT_SESSION_ID)`,
      unblock:
        "run the verdict from the host session's own shell; on a host that puts no session id in its shell, export WORKIT_SESSION_ID=<the id its hook gave this session>",
    };
  if (claimed === real.session || claimed.endsWith(`:${real.session}`)) return null;
  const host = family(real.host);
  const ownChildShell = host !== null && OWN_CHILD_SHELL.has(host);
  if (claimed.startsWith(`${real.session}:`) && !ownChildShell) return null;
  const source = real.derived ? `the host's own session` : "WORKIT_SESSION_ID";
  return {
    error: `forged_session: ${claimed} is not this shell's session (${source} is ${real.session}) nor a host-derived child of it`,
    unblock: ownChildShell
      ? `record the verdict from the verifier's own ${host === "pi" ? "Pi worker" : "OpenCode child session"} shell: its WORKIT_SESSION_ID is already its host-derived id (<lead>:<child>); never set WORKIT_SESSION_ID or --session by hand`
      : `drop the hand-minted id: a verifier subagent passes the id its SubagentStart hook gave it (--session ${real.session}:<agent id>), or use --as verifier for a fresh derived id`,
  };
}
