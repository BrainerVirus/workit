// Set verdicts (#891 part 3): one review of a change made the same way in
// several repositories. A non-author verifier records an ordinary verdict on
// one branch with `--set <name>`; it is also appended to a per-user store,
// `<state dir>/verdicts/sets/ledger.jsonl`, hash-chained like a ledger and
// keyed by the branch's set hash. A PR in any repository on this machine whose
// own set hash is the same is covered by it at its merge gate.
//
// The set hash is the ledger's diffHash (the pinned `base...head` diff,
// whitespace kept, `index` lines and hunk line numbers dropped) over every
// file but lockfiles: a lockfile is regenerated per repository, so it never
// matches, and the lane already reads it as opaque. A PR that changed a
// lockfile is covered only with green CI on its head, the evidence a
// dependency bump's lockfile takes (core/policy/lane.ts). Every other byte of
// the diff, file names and context lines included, is in the hash.
//
// A set verdict covers a PR only when its row verifies in the store's chain,
// its session is a host-derived `<lead>:<agent>` id the gates trust (issued
// by a SubagentStart hook or vouched for by the host's shell; never an `--as`
// id, which any session can mint), that session
// authored neither the judged branch (recordVerdict refuses it) nor the PR's
// branch, it is a strong pass, it has not expired (SET_TTL_MS after it was
// recorded) and no newer trusted set verdict on the same hash failed.
import path from "node:path";
import { resolveStateDir } from "./logger";
import {
  STRONG_RESULTS,
  appendLine,
  authoredBy,
  binaryRangeDiff,
  hashOfDiff,
  MAX_LINE_BYTES,
  readLedgerAt,
  remoteIdentity,
  sealed,
  trustReasons,
  type LedgerResult,
  type ReadRow,
  type VerdictRow,
} from "../ledger";
import { LOCKFILES } from "./policy/lane";

/** How long a set verdict covers matching PRs after it was recorded. */
export const SET_TTL_MS = 7 * 86_400_000;

/** A set name: what `--set` takes. */
export const SET_NAME = /^[A-Za-z\d][\w.-]{0,63}$/u;

const SET_ROW = "verdict.set";

/** The per-user store every repository's gates read. */
export const setStorePath = (): string =>
  path.join(resolveStateDir(), "verdicts", "sets", "ledger.jsonl");

/** The set hash of a range and the lockfiles left out of it. */
export type SetKey = { hash: string; lockfiles: string[] };

const headerPath = (line: string): string => {
  const quoted = line.endsWith('"');
  const text = quoted ? line.slice(0, -1) : line;
  return text.slice(text.indexOf(" b/") + 3);
};

const basename = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/**
 * The set hash of `base...head` (see the header), or null when git cannot
 * read the diff or nothing but lockfiles changed. Without a lockfile it equals
 * the ledger's diffHash of the same range.
 */
export function setDiffKey(cwd: string, base: string, head: string): SetKey | null {
  const diff = binaryRangeDiff(cwd, base, head);
  if (!diff) return null;
  const kept: string[] = [];
  const lockfiles: string[] = [];
  let skip = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const file = headerPath(line);
      skip = LOCKFILES.has(basename(file));
      if (skip) lockfiles.push(file);
    }
    if (!skip) kept.push(line);
  }
  if (!kept.some((line) => line.startsWith("diff --git "))) return null;
  return { hash: hashOfDiff(kept.join("\n")), lockfiles };
}

/** A set verdict as the store keeps it. */
export type SetRow = Record<string, unknown> & {
  id: string;
  at: string;
  type: typeof SET_ROW;
  set: string;
  setHash: string;
  lockfiles: string[];
  result: string;
  kind: string;
  repo: string | null;
  branch: string | null;
  head: string | null;
  base: string | null;
  expires: string;
};

const fail = (code: "invalid_input" | "blocked", error: string, unblock: string) =>
  ({ ok: false, code, error, unblock }) as const;

/** A host-derived `<lead>:<agent>` session: what SubagentStart hooks and child shells give a verifier. */
export const derivedSession = (session: string | null | undefined): session is string =>
  typeof session === "string" && /^[^:]+:.+$/u.test(session);

export const setSessionError = (session: string | null | undefined): string =>
  `set_session: a set verdict needs a host-derived <lead>:<agent> session; ${session ?? "no session"} is not one`;
export const SET_SESSION_UNBLOCK =
  "spawn a verifier subagent: its SubagentStart context names the --session <lead>:<agent id> to record with (OpenCode and Pi children have it in their shell)";

/**
 * Share `verdict`, just recorded on its branch, as set `name`: append it to
 * the per-user store keyed by its set hash. Refused for a self verdict, a
 * session that is not host-derived, or a diff with nothing but lockfiles.
 */
export function recordSetVerdict(
  cwd: string,
  verdict: VerdictRow,
  name: string,
  now: Date = new Date(),
): LedgerResult<SetRow> {
  if (!SET_NAME.test(name))
    return fail(
      "invalid_input",
      `--set ${JSON.stringify(name)}: a set name is letters, digits, ".", "_" or "-" (at most 64)`,
      "pass --set <name>, such as --set deps-2026-11",
    );
  if (verdict.self)
    return fail(
      "blocked",
      "set_self: a self verdict is never shared as a set verdict",
      "have a non-author verifier record the verdict with --set",
    );
  if (verdict.sessionSource === "as" || !derivedSession(verdict.actor.session))
    return fail("blocked", setSessionError(verdict.actor.session), SET_SESSION_UNBLOCK);
  const key = verdict.base && verdict.head ? setDiffKey(cwd, verdict.base, verdict.head) : null;
  if (!key)
    return fail(
      "invalid_input",
      `set_empty: the diff of ${verdict.branch ?? "the branch"} against ${verdict.base ?? "its base"} has no change outside lockfiles to key a set verdict on`,
      "record the verdict without --set",
    );
  const at = now.toISOString();
  const row = {
    type: SET_ROW,
    set: name,
    setHash: key.hash,
    lockfiles: key.lockfiles.slice(0, 20),
    result: verdict.result,
    kind: verdict.kind,
    how: verdict.how.slice(0, 600),
    actor: verdict.actor,
    self: false,
    sessionSource: verdict.sessionSource,
    ...(verdict.sessionBound === true ? { sessionBound: true } : {}),
    repo: remoteIdentity(cwd),
    branch: verdict.branch,
    head: verdict.head,
    base: verdict.base,
    expires: new Date(now.getTime() + SET_TTL_MS).toISOString(),
  };
  let full: unknown = null;
  const written = appendLine(
    setStorePath(),
    (previous) => {
      const next = sealed(row, verdict.id, at, previous);
      if (Buffer.byteLength(next.line) > MAX_LINE_BYTES)
        return fail("invalid_input", "set verdict row too long", "shorten --how");
      full = next.full;
      return { ok: true, value: next.line };
    },
    {},
  );
  if (!written.ok) return written;
  return { ok: true, value: full as SetRow };
}

/** The set verdict that covers a PR head. */
export type SetCover = {
  set: string;
  verdictId: string;
  hash: string;
  /** The repository (forge host and path) and branch head it was recorded on. */
  repo: string | null;
  branch: string | null;
  head: string | null;
  expires: string;
  /** The PR's own lockfiles, outside the hash: green CI on its head stood for them. */
  lockfiles: string[];
};

/** A set reading: the cover and its store row, or why a matching set verdict does not cover. */
export type SetReading = { cover: SetCover | null; row: ReadRow | null; note: string | null };

const NONE: SetReading = { cover: null, row: null, note: null };

const label = (row: ReadRow): string =>
  `set verdict ${row.id} (${String(row.set)}, ${String(row.result)} by ${row.actor.session ?? "no session"})`;

/**
 * The set verdict covering `head` of `branch` against `base` (see the
 * header). `authors` are the PR branch's author sessions; `ci` is the head's
 * checks state, which a PR with lockfiles needs passing.
 */
export function findSetCover(
  cwd: string,
  input: {
    base: string | null;
    head: string | null;
    authors: ReadonlySet<string>;
    ci: string | null;
    now?: number;
  },
): SetReading {
  if (!input.base || !input.head) return NONE;
  const read = readLedgerAt(cwd, setStorePath(), { integrity: true });
  if (!read.ok || read.value.rows.length === 0) return NONE;
  const key = setDiffKey(cwd, input.base, input.head);
  if (!key) return NONE;
  const now = input.now ?? Date.now();
  const authors = new Set(input.authors);
  const matching = read.value.rows.filter(
    (row) => row.type === SET_ROW && row.setHash === key.hash,
  );
  if (!matching.length) return NONE;
  const trusted = matching.filter(
    (row) =>
      row.integrity === "verified" &&
      row.self !== true &&
      row.sessionSource !== "as" &&
      derivedSession(row.actor.session) &&
      trustReasons(cwd, row).length === 0 &&
      !authoredBy(authors, row.actor.session) &&
      Date.parse(row.at) <= now,
  );
  const live = trusted.filter((row) => Date.parse(String(row.expires)) > now);
  const newest = live.at(-1);
  if (!newest) {
    const expired = trusted.at(-1);
    return {
      cover: null,
      row: null,
      note: expired
        ? `${label(expired)} matches this diff but expired at ${String(expired.expires)}`
        : `a set verdict matches this diff, but none from a trusted non-author session (${matching.map((row) => row.id).join(", ")})`,
    };
  }
  if (!STRONG_RESULTS.has(String(newest.result)))
    return { cover: null, row: null, note: `${label(newest)} on this diff does not pass` };
  if (key.lockfiles.length && input.ci !== "passing")
    return {
      cover: null,
      row: null,
      note: `${label(newest)} matches this diff, but ${key.lockfiles.join(", ")} is outside the set hash and needs green CI on the head (CI is ${input.ci ?? "unread"})`,
    };
  return {
    cover: {
      set: String(newest.set),
      verdictId: newest.id,
      hash: key.hash,
      repo: typeof newest.repo === "string" ? newest.repo : null,
      branch: newest.branch,
      head: newest.head,
      expires: String(newest.expires),
      lockfiles: key.lockfiles,
    },
    row: newest,
    note: null,
  };
}

/** One line for status output. */
export const setCoverLabel = (cover: SetCover): string =>
  `set verdict ${cover.verdictId} (${cover.set}) from ${cover.repo ?? "a repository without a remote"} ${cover.branch ?? ""} @ ${(cover.head ?? "").slice(0, 12)}, diff ${cover.hash.slice(7, 19)}, until ${cover.expires}${cover.lockfiles.length ? `; ${cover.lockfiles.join(", ")} by green CI` : ""}`;
