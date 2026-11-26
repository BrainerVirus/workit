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
// The store's chain is keyless, so a set row is only a pointer: it names the
// recording checkout's own ledger and the chain hash of its verdict row
// there. A set verdict covers a PR only when that ledger holds that verdict,
// chained and not voided, with the same result and session; the session is a
// host-issued `<lead>:<agent>` id (a real host, never `cli` or `--as`, and a
// `--session` one only with its token) the gates trust; it authored neither
// the judged branch nor the PR's branch; the judged range's set hash is the
// row's; it is a strong pass; it has not expired (SET_TTL_MS after the
// ledger verdict was recorded); and no newer such set verdict on it failed.
// `<state>/verdicts/` and every ledger are guarded paths (hooks/write-gate.ts).
import path from "node:path";
import { resolveStateDir } from "./logger";
import {
  STRONG_RESULTS,
  appendLine,
  authorSessions,
  authoredBy,
  ledgerPath,
  binaryRangeDiff,
  hashOfDiff,
  MAX_LINE_BYTES,
  readLedgerAt,
  remoteIdentity,
  sealed,
  trustReasons,
  verdictVoids,
  type LedgerActor,
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
const SET_VOID = "verdict.set.voided";

/** The per-user store every repository's gates read. */
export const setStorePath = (): string =>
  path.join(resolveStateDir(), "verdicts", "sets", "ledger.jsonl");

/** The set hash of a range and the lockfiles left out of it. */
export type SetKey = { hash: string; lockfiles: string[] };

/** The `b/` path of a `diff --git` header (a quoted one keeps its escapes). */
const headerPath = (line: string): string => line.slice(line.indexOf(" b/") + 3).replace(/"$/u, "");

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
      skip = LOCKFILES.has(file.slice(file.lastIndexOf("/") + 1));
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
  typeof session === "string" && /^[^:]+:./u.test(session);

export const setSessionError = (session: string | null | undefined): string =>
  `set_session: a set verdict needs a host-issued <lead>:<agent> session (from a real host, never --as, and on Claude Code or Cursor with its --token); ${session ?? "no session"} is not one`;
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
  if (!hostIssued(verdict as unknown as ReadRow))
    return fail("blocked", setSessionError(verdict.actor.session), SET_SESSION_UNBLOCK);
  const key = verdict.base && verdict.head ? setDiffKey(cwd, verdict.base, verdict.head) : null;
  if (!key)
    return fail(
      "invalid_input",
      `set_empty: the diff of ${verdict.branch ?? "the branch"} against ${verdict.base ?? "its base"} has no change outside lockfiles to key a set verdict on`,
      "record the verdict without --set",
    );
  const ledger = ledgerPath(cwd);
  if (!ledger.ok) return ledger;
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
    expires: new Date(Date.parse(verdict.at) + SET_TTL_MS).toISOString(),
    // The backing verdict (see backed): the recording checkout's ledger and the row's chain hash.
    ledger: ledger.value,
    verdictHash: (verdict as VerdictRow & { rowHash?: string }).rowHash ?? null,
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

/**
 * Retire set verdict `target` (`workit ledger void` of the verdict it shares):
 * append a void row to the store, so it covers no PR any more. False when the
 * store holds no set row with that id (nothing to retire).
 */
export function recordSetVoid(
  cwd: string,
  input: { target: string; reason: string; actor: LedgerActor },
  now: Date = new Date(),
): LedgerResult<boolean> {
  const read = readLedgerAt(cwd, setStorePath(), {});
  if (!read.ok) return read;
  if (!read.value.rows.some((row) => row.type === SET_ROW && row.id === input.target))
    return { ok: true, value: false };
  const written = appendLine(
    setStorePath(),
    (previous) => ({
      ok: true,
      value: sealed(
        {
          type: SET_VOID,
          target: input.target,
          reason: input.reason.slice(0, 600),
          actor: input.actor,
        },
        `${input.target}-void-${now.getTime().toString(36)}`,
        now.toISOString(),
        previous,
      ).line,
    }),
    {},
  );
  return written.ok ? { ok: true, value: true } : written;
}

/**
 * Whether a `pr.gate` row (#891) still stands: the verdict it cited is not
 * voided in `rows` (this checkout's ledger) and, for a set cover, it has not
 * expired (its `expires`, else SET_TTL_MS after the row) and the store holds
 * no void of it. The Stop hook reads this instead of the set readers.
 */
export function gateStands(
  cwd: string,
  gate: ReadRow,
  rows: readonly ReadRow[],
  now: number = Date.now(),
): boolean {
  const id = typeof gate.verdictId === "string" ? gate.verdictId : null;
  if (id !== null && verdictVoids(rows).has(id)) return false;
  if (gate.via !== "set") return true;
  const until =
    typeof gate.expires === "string" ? Date.parse(gate.expires) : Date.parse(gate.at) + SET_TTL_MS;
  if (!(until > now)) return false;
  if (id === null) return true;
  const read = readLedgerAt(cwd, setStorePath(), { integrity: true });
  return (
    read.ok &&
    !read.value.rows.some(
      (row) => row.type === SET_VOID && row.target === id && row.integrity === "verified",
    )
  );
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

type CoverInput = {
  base: string | null;
  head: string | null;
  authors: Iterable<string>;
  /** The head's checks state; unread (undefined) never covers a PR with a lockfile outside the hash. */
  ci?: string | null;
  now?: number;
};

/**
 * The set rows on the head's set hash, the trusted non-author ones among
 * them (voided ones dropped), and the newest of those still live; null when
 * the store or the diff cannot be read or nothing matches. The Stop hook
 * reads this alone (it carries no note text).
 */
function setRows(cwd: string, input: CoverInput) {
  if (!input.base || !input.head) return null;
  const read = readLedgerAt(cwd, setStorePath(), { integrity: true });
  if (!read.ok || read.value.rows.length === 0) return null;
  const key = setDiffKey(cwd, input.base, input.head);
  if (!key) return null;
  const rows = read.value.rows.filter((row) => row.integrity === "verified");
  const voided = new Set(rows.filter((row) => row.type === SET_VOID).map((row) => row.target));
  const matching = rows.filter((row) => row.type === SET_ROW && row.setHash === key.hash);
  const now = input.now ?? Date.now();
  const authors = new Set(input.authors);
  const ledgers = new Map<string, readonly ReadRow[] | null>();
  const trusted = matching.filter(
    (row) =>
      !voided.has(row.id) &&
      !authoredBy(authors, String(row.actor.session)) &&
      backed(row, ledgers) !== null,
  );
  const live = (row: ReadRow) => Date.parse(expiry(row, ledgers)) > now;
  const newest = trusted.findLast(live);
  return matching.length ? { key, matching, trusted, newest, ledgers } : null;
}

/** When a backed set row stops covering: SET_TTL_MS after its ledger verdict was recorded. */
const expiry = (row: ReadRow, ledgers: Map<string, readonly ReadRow[] | null>): string => {
  const verdict = backed(row, ledgers);
  return verdict ? new Date(Date.parse(verdict.at) + SET_TTL_MS).toISOString() : "";
};

/**
 * The verdict row a set row stands for, read from the recording checkout's
 * own ledger, or null (see the header): the store's chain is keyless, so a
 * set row counts only when that ledger holds the same verdict, chained and
 * not voided, by the same trusted, host-issued non-author session, on a
 * diff whose set hash is the row's.
 */
function backed(row: ReadRow, ledgers: Map<string, readonly ReadRow[] | null>): ReadRow | null {
  const file = typeof row.ledger === "string" ? row.ledger : "";
  if (!path.isAbsolute(file) || path.basename(file) !== "ledger.jsonl") return null;
  // <git common dir>/workit/ledger/ledger.jsonl: git runs in the common dir.
  const repo = path.dirname(path.dirname(path.dirname(file)));
  let rows = ledgers.get(file);
  if (rows === undefined) {
    const read = readLedgerAt(repo, file, { integrity: true });
    rows = read.ok ? read.value.rows : null;
    ledgers.set(file, rows);
  }
  const verdict = rows?.find((candidate) => candidate.id === row.id);
  if (!rows || !verdict || verdict.type !== "verdict" || verdict.integrity !== "verified")
    return null;
  const session = verdict.actor.session;
  const same =
    verdict.rowHash === row.verdictHash &&
    verdict.result === row.result &&
    session === row.actor.session &&
    verdict.self !== true &&
    hostIssued(verdict) &&
    trustReasons(repo, verdict).length === 0 &&
    !verdictVoids(rows, { chained: true }).has(verdict.id);
  if (!same || !verdict.branch || !verdict.base || !verdict.head) return null;
  const authors = authorSessions(repo, rows, verdict.branch, verdict);
  if (authoredBy(authors, String(session))) return null;
  return setDiffKey(repo, verdict.base, verdict.head)?.hash === row.setHash ? verdict : null;
}

/**
 * A verdict session a host issued or set: a host-derived id from a real host
 * (never `cli`, where any id is a declaration), never `--as`, and a
 * `--session` one only with the token its SubagentStart hook bound it to.
 */
const hostIssued = (row: ReadRow): boolean =>
  derivedSession(row.actor.session) &&
  Boolean(row.actor.host) &&
  row.actor.host !== "cli" &&
  row.sessionSource !== "as" &&
  (row.sessionSource !== "flag" || row.sessionBound === true);

/** Whether the newest live row covers: a strong pass, and green CI when a lockfile is outside the hash. */
const covering = (
  found: NonNullable<ReturnType<typeof setRows>>,
  ci?: string | null,
): ReadRow | null =>
  found.newest &&
  STRONG_RESULTS.has(String(found.newest.result)) &&
  (!found.key.lockfiles.length || ci === "passing")
    ? found.newest
    : null;

/**
 * The set verdict covering `head` of `branch` against `base` (see the
 * header), or why a matching one does not. `authors` are the PR branch's
 * author sessions; `ci` is the head's checks state, which a PR with
 * lockfiles needs passing.
 */
export function findSetCover(cwd: string, input: CoverInput): SetReading {
  const found = setRows(cwd, input);
  if (!found) return NONE;
  const newest = found.newest;
  const row = covering(found, input.ci);
  if (row)
    return {
      cover: {
        set: String(row.set),
        verdictId: row.id,
        hash: found.key.hash,
        repo: typeof row.repo === "string" ? row.repo : null,
        branch: row.branch,
        head: row.head,
        expires: expiry(row, found.ledgers),
        lockfiles: found.key.lockfiles,
      },
      row,
      note: null,
    };
  const last = found.trusted.at(-1);
  const lastExpiry = last ? expiry(last, found.ledgers) : "";
  const note = newest
    ? STRONG_RESULTS.has(String(newest.result))
      ? `${label(newest)} matches this diff, but ${found.key.lockfiles.join(", ")} is outside the set hash and needs green CI on the head (CI is ${input.ci ?? "unread"})`
      : `${label(newest)} on this diff does not pass`
    : last
      ? `${label(last)} matches this diff but expired at ${lastExpiry}`
      : `a set verdict matches this diff, but none from a trusted non-author session that was not voided (${found.matching.map((candidate) => candidate.id).join(", ")})`;
  return { cover: null, row: null, note };
}

/** One line for status output. */
export const setCoverLabel = (cover: SetCover): string =>
  `set verdict ${cover.verdictId} (${cover.set}) from ${cover.repo ?? "a repository without a remote"} ${cover.branch ?? ""} @ ${(cover.head ?? "").slice(0, 12)}, diff ${cover.hash.slice(7, 19)}, until ${cover.expires}${cover.lockfiles.length ? `; ${cover.lockfiles.join(", ")} by green CI` : ""}`;
