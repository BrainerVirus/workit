// The acting host session for a `workit` call made from an agent's shell.
// WORKIT_SESSION_ID, when set, wins (Claude Code exports it from SessionStart; a lead
// assigns one to a verifier), unless WORKIT_HOST shows it came from another host. Otherwise the id each host itself puts in its
// shell tool's environment is used, so commits and verdicts made on those
// hosts carry the same session id their hooks see (M5):
//   - OpenCode V2: OPENCODE_SESSION_ID (the shell tool's session id);
//   - Pi: PI_SESSION_ID (the bash tool exposes the Pi session id);
//   - Codex CLI and Desktop: CODEX_THREAD_ID (the thread id hooks get as session_id).
// Cursor puts no conversation id in its shell; its hook names the id to use.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./core/logger";
import { resolveStore } from "./store/paths";

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
 * Where this shell's session comes from:
 *   - `derived`: the host's own shell variable (OPENCODE_SESSION_ID,
 *     PI_SESSION_ID, CODEX_THREAD_ID), which a caller cannot replace by
 *     exporting WORKIT_SESSION_ID;
 *   - `declared`: a host that puts no id in the shell but names itself
 *     (WORKIT_HOST, e.g. Claude Code's SessionStart export) declares it in
 *     WORKIT_SESSION_ID;
 *   - `none`: no host at all (CI, a plain terminal, Cursor's prefixed
 *     commands): whatever session the caller names is only declared.
 */
export type RealSession = HostSession & { kind: "derived" | "declared" | "none" };

export function realHostSession(env: NodeJS.ProcessEnv): RealSession {
  for (const [key, host] of HOST_SESSION_VARS) {
    const session = env[key]?.trim();
    if (session) return { host: host(env), session, kind: "derived" };
  }
  const declared = hostSessionFromEnv(env);
  const hosted = declared.host !== null && declared.host !== "cli";
  return { ...declared, kind: hosted ? "declared" : "none" };
}

// Ids a SubagentStart hook gave a lead's subagents (`<lead>:<agent id>`): one
// empty file per id under `<state>/issued/<lead hash>/`, so concurrent
// hooks never lose each other's write, bounded per lead.
const ISSUED_PER_LEAD = 64;

/**
 * Written into each issued-id file. A hook bundle that contains this string
 * records issued ids; `workit doctor` looks for it in the installed Claude
 * Code and Codex hooks to catch a plugin older than the CLI.
 */
export const ISSUED_SESSIONS_MARKER = "workit-issued-sessions/1";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

// Issued ids live in the per-user state dir, keyed by lead session: a lead
// started in one repository delegates review of others, and the verifier
// records its verdict from whichever repository it reviews (#294).
const userIssuedRoot = (): string => path.join(resolveStateDir(), "issued");

/**
 * Hooks of 8.10-8.12 wrote issued ids into `<store>/hooks/issued` of the
 * lead's repository. Move any such ids into the per-user registry and remove
 * the old directory, once per repository. Fails open.
 */
function migrateRepoIssued(cwd: string | undefined): void {
  if (cwd === undefined) return;
  try {
    const location = resolveStore(cwd);
    if (location instanceof Error) return;
    const old = path.join(location.dir, "hooks", "issued");
    if (!fs.existsSync(old)) return;
    for (const lead of fs.readdirSync(old)) {
      const from = path.join(old, lead);
      const to = path.join(userIssuedRoot(), lead);
      fs.mkdirSync(to, { recursive: true });
      for (const id of fs.readdirSync(from))
        fs.copyFileSync(path.join(from, id), path.join(to, id));
    }
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // Fail open: an id left behind is refused later, never a broken hook.
  }
}

/** No hook has ever recorded an issued id (an older plugin hook, most likely). */
const noIssuedRecord = (cwd: string | undefined): boolean => {
  if (cwd === undefined) return false;
  try {
    migrateRepoIssued(cwd);
    return !fs.existsSync(userIssuedRoot());
  } catch {
    return false;
  }
};

/** Per host: how to update the plugin whose SubagentStart hook issues ids. */
const PLUGIN_UPDATE: Readonly<Record<string, string>> = {
  claude_code: "claude plugin marketplace update workit && claude plugin update workit@workit",
  codex: "codex plugin remove workit@workit && codex plugin add workit@workit",
};

/** Remember that a SubagentStart hook issued `issued` to a subagent of `lead`. Fails open. */
export function recordIssuedSession(cwd: string, lead: string, issued: string): void {
  try {
    migrateRepoIssued(cwd);
    const dir = path.join(userIssuedRoot(), hash(lead));
    fs.mkdirSync(dir, { recursive: true });
    const own = hash(issued);
    fs.writeFileSync(path.join(dir, own), ISSUED_SESSIONS_MARKER);
    const entries = fs.readdirSync(dir);
    if (entries.length <= ISSUED_PER_LEAD) return;
    // Oldest first; the id just issued is never the one pruned.
    const byAge = entries
      .filter((name) => name !== own)
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .toSorted((a, b) => a.at - b.at);
    for (const { name } of byAge.slice(0, entries.length - ISSUED_PER_LEAD))
      fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // Fail open: an unrecorded id is refused later, never a broken hook.
  }
}

const wasIssued = (cwd: string | undefined, lead: string, claimed: string): boolean => {
  migrateRepoIssued(cwd);
  try {
    return fs.existsSync(path.join(userIssuedRoot(), hash(lead), hash(claimed)));
  } catch {
    return false;
  }
};

const leadOf = (session: string): string => session.slice(0, session.lastIndexOf(":"));

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
 * Whether `claimed` may act as this shell's session (`cwd` locates the
 * workspace's record of hook-issued ids):
 *   - no host session (CI, a plain terminal): any id; `--session X` and
 *     WORKIT_SESSION_ID=X are the same declaration;
 *   - the shell's own session (a declared `<lead>:<x>` on Claude Code only
 *     when its SubagentStart hook issued it);
 *   - on a host that sets the id, `<lead>:<this session>`: a child naming its
 *     own host session;
 *   - `<this session>:<agent id>` only when this lead's SubagentStart hook
 *     issued it (Claude Code, Codex).
 * Anything else is a forged id: a verdict recorded under it would make author
 * is not verifier a naming convention.
 */
export function sessionClaimRefusal(
  env: NodeJS.ProcessEnv,
  claimed: string,
  cwd?: string,
): SessionClaimRefusal | null {
  const real = realHostSession(env);
  const host = family(real.host);
  // A host that always sets its own variable, named without it: the variable
  // was removed (`env -u OPENCODE_SESSION_ID`), so nothing vouches for the id.
  if (real.kind !== "derived" && host !== null && HOST_SET_VARIABLE[host])
    return {
      error: `forged_session: WORKIT_HOST names ${real.host}, but its own ${HOST_SET_VARIABLE[host]} is not in this shell, so ${claimed} cannot be checked`,
      unblock: `record the verdict from the ${real.host} session's own shell, where ${HOST_SET_VARIABLE[host]} is set`,
    };
  if (real.kind === "none" || !real.session) return null;
  let issuedClaim = false;
  if (claimed === real.session) {
    const declaredChild =
      real.kind === "declared" && host === "claude_code" && claimed.includes(":");
    if (!declaredChild || wasIssued(cwd, leadOf(claimed), claimed)) return null;
    issuedClaim = true;
  } else if (real.kind === "derived" && claimed.endsWith(`:${real.session}`)) return null;
  else if (claimed.startsWith(`${real.session}:`)) {
    if (wasIssued(cwd, real.session, claimed)) return null;
    issuedClaim = true;
  }
  const error = `forged_session: ${claimed} is neither this shell's session (${real.session}) nor an id its host issued to a child of it`;
  // A well-formed subagent id, but no hook here ever recorded one: the hook
  // most likely predates this CLI (CLI and plugin update separately).
  if (issuedClaim && noIssuedRecord(cwd) && host !== null && PLUGIN_UPDATE[host])
    return {
      error: `${error}; no SubagentStart hook on this machine has recorded an issued id`,
      unblock: `the workit plugin hook is probably older than this CLI and does not record the ids it issues: update the plugin (${PLUGIN_UPDATE[host]}), then relaunch the verifier so its SubagentStart runs the new hook (workit doctor checks this as hook_issued_sessions)`,
    };
  const ownChildShell = host !== null && OWN_CHILD_SHELL.has(host);
  return {
    error,
    unblock: ownChildShell
      ? `record the verdict from the verifier's own ${host === "pi" ? "Pi worker" : "OpenCode child session"} shell, where WORKIT_SESSION_ID is already set; never set WORKIT_SESSION_ID or --session by hand`
      : "never name a session yourself: spawn a verifier or reviewer subagent and pass exactly the --session its SubagentStart context names, or pass --as verifier",
  };
}

/** Hosts that always put their own session variable in the agent's shell. */
const HOST_SET_VARIABLE: Readonly<Record<string, string>> = {
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};
