// The acting host session for a `workit` call made from an agent's shell.
// WORKIT_SESSION_ID, when set, wins (Claude Code exports it from SessionStart; a lead
// assigns one to a verifier), unless WORKIT_HOST shows it came from another host. Otherwise the id each host itself puts in its
// shell tool's environment is used, so commits and verdicts made on those
// hosts carry the same session id their hooks see (M5):
//   - OpenCode V2: OPENCODE_SESSION_ID (the shell tool's session id);
//   - Pi: PI_SESSION_ID (the bash tool exposes the Pi session id);
//   - Codex CLI and Desktop: CODEX_THREAD_ID (the thread id hooks get as session_id).
// Cursor puts no conversation id in its shell; its hook names the id to use.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProtectedTarget } from "./core/branch";
import { resolveStateDir } from "./core/logger";
import { currentBranch } from "./git/rev";
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
 * records issued ids per lead in the user's state dir with a token only the
 * subagent is told (`/3`; `/2` files carry no token, `/1` hooks of 8.10-8.12
 * wrote them per repository); `workit doctor` looks for it in the installed
 * Claude Code and Codex hooks to catch a plugin older than the CLI.
 */
export const ISSUED_SESSIONS_MARKER = "workit-issued-sessions/3";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

// Issued ids live in the per-user state dir, keyed by lead session: a lead
// started in one repository delegates review of others, and the verifier
// records its verdict from whichever repository it reviews (#294).
const userIssuedRoot = (): string => path.join(resolveStateDir(), "issued");
/**
 * Token hashes, one file per issued id under `<state>/issued-tokens/<lead
 * hash>/`: a tree hooks older than tokens never write, so an old cached
 * plugin hook that rewrites a record in `issued/` cannot strip its token.
 * Once a lead has one, every id under it needs a token (sticky binding).
 */
const userTokenRoot = (): string => path.join(resolveStateDir(), "issued-tokens");

/**
 * Hooks of 8.10-8.12 wrote issued ids into `<store>/hooks/issued` of the
 * lead's repository. Move them into the per-user registry file by file
 * (copy, then unlink: an id an old hook writes meanwhile stays for the next
 * read) and drop the emptied directories. Each lead migrates on its own, so
 * one bad entry never strands the rest. Fails open.
 */
function migrateRepoIssued(cwd: string | undefined): void {
  if (cwd === undefined) return;
  let old: string;
  try {
    const location = resolveStore(cwd);
    if (location instanceof Error) return;
    old = path.join(location.dir, "hooks", "issued");
    if (!fs.existsSync(old)) return;
  } catch {
    return;
  }
  for (const lead of safeList(old)) {
    try {
      const from = path.join(old, lead);
      if (!fs.statSync(from).isDirectory()) continue;
      const to = path.join(userIssuedRoot(), lead);
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const id of fs.readdirSync(from)) {
        // Never over an existing per-user record: a legacy in-repo copy must
        // not replace a token-bound one (EEXIST just drops the legacy copy).
        try {
          fs.copyFileSync(path.join(from, id), path.join(to, id), fs.constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        fs.rmSync(path.join(from, id), { force: true });
      }
      removeIfEmpty(from);
    } catch {
      // Fail open: this lead's ids stay for the next read.
    }
  }
  removeIfEmpty(old);
}

const safeList = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const removeIfEmpty = (dir: string): void => {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty (a concurrent old hook wrote) or already gone.
  }
};

/** This lead's hooks never recorded an issued id (an older plugin hook, most likely). */
const noIssuedRecord = (cwd: string | undefined, lead: string): boolean => {
  if (cwd === undefined) return false;
  try {
    migrateRepoIssued(cwd);
    return !fs.existsSync(path.join(userIssuedRoot(), hash(lead)));
  } catch {
    return false;
  }
};

/** Per host: how to update the plugin whose SubagentStart hook issues ids. */
const PLUGIN_UPDATE: Readonly<Record<string, string>> = {
  claude_code: "claude plugin marketplace update workit && claude plugin update workit@workit",
  codex: "codex plugin remove workit@workit && codex plugin add workit@workit",
};

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Remember that a SubagentStart hook issued `issued` to a subagent of `lead`,
 * and return the token that binds the id to that subagent: the hook hands it
 * only to the subagent, and only its sha256 is stored, so a lead or sibling
 * that reads the id in the ledger cannot act as it (audit mv83zyg6 P1).
 * Each id is issued once: a SubagentStart fired again for an id already
 * issued (a lead replaying the hook) gets no new token (review mv8daa5d P1).
 * Null when nothing was issued: already issued, or the write failed (fails open).
 */
export function recordIssuedSession(cwd: string, lead: string, issued: string): string | null {
  // Hex, never base64url: a token that starts with "-" (1 in 64) breaks the
  // `--token <token>` the hook prints, because the CLI parses it as a flag.
  const token = randomBytes(18).toString("hex");
  try {
    migrateRepoIssued(cwd);
    const own = hash(issued);
    const tokens = path.join(userTokenRoot(), hash(lead));
    fs.mkdirSync(tokens, { recursive: true, mode: 0o700 });
    // `wx`: the first SubagentStart for an id wins; any later one fails here.
    fs.writeFileSync(path.join(tokens, own), `${tokenHash(token)}\n`, { mode: 0o600, flag: "wx" });
    const dir = path.join(userIssuedRoot(), hash(lead));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, own), `${ISSUED_SESSIONS_MARKER}\n`, { mode: 0o600 });
    pruneIssued(dir, own, tokens);
    return token;
  } catch {
    // Already issued (EEXIST), or a failed write: no token is handed out.
    return null;
  }
}

/**
 * The branch a judge spawned from `cwd` most likely verifies: the checkout's
 * branch, or null on a detached HEAD or a protected branch (a lead on `main`
 * fanning out names the candidate in its brief, never its own branch).
 */
export function judgeBranch(cwd: string): string | null {
  const branch = currentBranch(cwd);
  return branch && !isProtectedTarget(cwd, branch) ? branch : null;
}

/**
 * The exact verdict command a verifier or reviewer runs, filled in (#271
 * S2a). `--token=` keeps a token from ever parsing as a flag. Hosts whose
 * child shell carries its own session (OpenCode, Pi) pass no session.
 * `--kind` is always named: left out, the CLI records `review`.
 */
export function verdictCommand(options: {
  branch: string | null;
  judge: "verifier" | "reviewer" | null;
  session?: string | null;
  token?: string | null;
}): string {
  const kind =
    options.judge === "verifier"
      ? "<live|unit>"
      : options.judge === "reviewer"
        ? "review"
        : "<live|unit|review>";
  return [
    "workit ledger verdict <verified|failed|blocked>",
    `--kind ${kind}`,
    `--branch ${options.branch ?? "<branch>"}`,
    options.session ? `--session ${options.session}` : null,
    options.token ? `--token=${options.token}` : null,
    '--how "<what you ran and saw>"',
  ]
    .filter(Boolean)
    .join(" ");
}

/** Keep the newest ISSUED_PER_LEAD ids of one lead (and their token hashes); `own` is never pruned. */
function pruneIssued(dir: string, own: string, tokens: string): void {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length <= ISSUED_PER_LEAD) return;
    // Oldest first; the id just issued is never the one pruned.
    const byAge = entries
      .filter((name) => name !== own)
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .toSorted((a, b) => a.at - b.at);
    for (const { name } of byAge.slice(0, entries.length - ISSUED_PER_LEAD)) {
      fs.rmSync(path.join(dir, name), { force: true });
      fs.rmSync(path.join(tokens, name), { force: true });
    }
  } catch {
    // Fail open: an unrecorded id is refused later, never a broken hook.
  }
}

/** The issued-id file's text, or null when no hook issued `claimed`. */
const issuedRecord = (cwd: string | undefined, claimed: string): string | null => {
  const cut = claimed.lastIndexOf(":");
  if (cut <= 0) return null;
  migrateRepoIssued(cwd);
  try {
    return fs.readFileSync(
      path.join(userIssuedRoot(), hash(claimed.slice(0, cut)), hash(claimed)),
      "utf8",
    );
  } catch {
    return null;
  }
};

const TOKEN_HASH = /^([0-9a-f]{64})$/mu;

/** The stored token hash for `claimed`, and whether its lead has any token at all. */
const issuedToken = (claimed: string): { stored: string | null; leadBound: boolean } => {
  const cut = claimed.lastIndexOf(":");
  if (cut <= 0) return { stored: null, leadBound: false };
  const dir = path.join(userTokenRoot(), hash(claimed.slice(0, cut)));
  try {
    const text = fs.readFileSync(path.join(dir, hash(claimed)), "utf8");
    return { stored: TOKEN_HASH.exec(text)?.[1] ?? null, leadBound: true };
  } catch {
    return { stored: null, leadBound: safeList(dir).length > 0 };
  }
};

/**
 * How a SubagentStart hook issued `claimed` (`<lead>:<agent id>`): `token`
 * (it must be presented, `--token`), `legacy` (a hook older than tokens
 * recorded it) or null (never issued). Binding is sticky: once its lead has
 * any token-bound id, a token-less record (an old cached hook rewriting one,
 * or issuing a new one) reads `token` with no token that can match.
 */
export type IssuedBinding = "token" | "legacy";
export function issuedBinding(cwd: string | undefined, claimed: string): IssuedBinding | null {
  const record = issuedRecord(cwd, claimed);
  const { stored, leadBound } = issuedToken(claimed);
  if (stored) return "token";
  if (record === null) return null;
  return leadBound ? "token" : "legacy";
}

/** Whether `token` is the one the hook gave the subagent it issued `claimed` to. */
export function issuedTokenMatches(
  cwd: string | undefined,
  claimed: string,
  token: string | null | undefined,
): boolean {
  migrateRepoIssued(cwd);
  const { stored } = issuedToken(claimed);
  if (!stored || !token) return false;
  const given = Buffer.from(tokenHash(token.trim()));
  const want = Buffer.from(stored);
  return given.length === want.length && timingSafeEqual(given, want);
}

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
 *   - the shell's own session; a declared `<lead>:<x>` (any WORKIT_HOST but
 *     cli) only when a SubagentStart hook issued it;
 *   - on a host that sets the id, `<lead>:<this session>`: a child naming its
 *     own host session;
 *   - `<this session>:<agent id>` only when this lead's SubagentStart hook
 *     issued it (Claude Code, Codex).
 * An issued id the hook bound to a token is accepted only with that token
 * (`options.token`): a lead or sibling that read the id cannot reuse it.
 * `options.flag`: named by `--session`. On a host that is only for an issued
 * id; a shell's own or derived session comes from its environment, so a
 * `--session` the gate would not accept is refused here, not later.
 * Anything else is a forged id: a verdict recorded under it would make author
 * is not verifier a naming convention.
 */
const isOwnShellClaim = (real: RealSession, claimed: string): boolean =>
  (claimed === real.session && !(real.kind === "declared" && claimed.includes(":"))) ||
  (real.kind === "derived" && claimed.endsWith(`:${real.session}`));

/**
 * `claimed` is the shell's own derived session (OPENCODE_SESSION_ID,
 * PI_SESSION_ID, CODEX_THREAD_ID), alone or as `<lead>:<it>`: a `--session`
 * naming it adds nothing, so the CLI acts as the shell's session instead.
 */
export const namesOwnDerivedSession = (env: NodeJS.ProcessEnv, claimed: string): boolean => {
  const real = realHostSession(env);
  return real.kind === "derived" && isOwnShellClaim(real, claimed);
};

export function sessionClaimRefusal(
  env: NodeJS.ProcessEnv,
  claimed: string,
  cwd?: string,
  options: { token?: string | null; flag?: boolean } = {},
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
  const ownShell = isOwnShellClaim(real, claimed);
  if (ownShell) {
    // A derived session (the host's own shell variable) cannot be replaced by
    // a flag, so naming it is a no-op, not an error: a printed line that
    // carries it still records. Declared sessions keep refusing the flag.
    if (!options.flag || real.kind === "derived") return null;
    return {
      error: `session_flag: --session ${claimed} names this shell's own ${real.host} session; on a host only an issued subagent id is passed as --session`,
      unblock: "drop --session: the shell's own session is already the acting one",
    };
  }
  const issuedClaim = claimed === real.session || claimed.startsWith(`${real.session}:`);
  if (issuedClaim) {
    const binding = issuedBinding(cwd, claimed);
    if (binding === "legacy") return null;
    if (binding === "token")
      return issuedTokenMatches(cwd, claimed, options.token)
        ? null
        : {
            error: `unbound_session: ${claimed} was issued to a subagent, and this call did not present the token its SubagentStart hook gave it`,
            unblock: `only that subagent acts as ${claimed}: it passes --token exactly as its SubagentStart context names it (or WORKIT_SESSION_TOKEN); anyone else spawns their own verifier`,
          };
  }
  const error = `forged_session: ${claimed} is neither this shell's session (${real.session}) nor an id its host issued to a child of it`;
  // A well-formed subagent id, but no hook here ever recorded one: the hook
  // most likely predates this CLI (CLI and plugin update separately).
  if (issuedClaim && noIssuedRecord(cwd, leadOf(claimed)) && host !== null && PLUGIN_UPDATE[host])
    return {
      error: `${error}; no SubagentStart hook has recorded an issued id for this lead`,
      unblock: `the workit plugin hook is probably older than this CLI and does not record the ids it issues: update the plugin (${PLUGIN_UPDATE[host]}), then relaunch the verifier so its SubagentStart runs the new hook (workit doctor checks this as hook_issued_sessions)`,
    };
  const ownChildShell = host !== null && OWN_CHILD_SHELL.has(host);
  return {
    error,
    unblock: ownChildShell
      ? `record the verdict from the verifier's own ${host === "pi" ? "Pi worker" : "OpenCode child session"} shell, where WORKIT_SESSION_ID is already set; never set WORKIT_SESSION_ID or --session by hand`
      : "never name a session yourself: spawn a verifier or reviewer subagent and pass exactly the --session and --token its SubagentStart context names, or pass --as verifier",
  };
}

/** Hosts that always put their own session variable in the agent's shell. */
const HOST_SET_VARIABLE: Readonly<Record<string, string>> = {
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};
