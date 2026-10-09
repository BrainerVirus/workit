// The run ledger (design §2.1 S13, §2.2; D13, D14, D17, D18): an append-only,
// repo-wide JSONL file of decisions, rulings, verdicts and handoff notes.
//
// - Location (D13): `$(git rev-parse --git-common-dir)/workit/ledger/ledger.jsonl`
//   in a git repo, so every worktree shares one ledger and it survives worktree
//   removal and `git clean`. `<cwd>/.workit/ledger/` is used only when git
//   says the directory is not a repository; any other git failure is
//   `unavailable`, never a silent split into a second ledger.
// - Concurrency: one row is one `write(2)` of at most MAX_LINE_BYTES on an
//   O_APPEND descriptor. POSIX promises atomicity only for pipes (PIPE_BUF),
//   not regular files; what we rely on is that local filesystems (ext4, xfs,
//   btrfs, apfs, NTFS via FILE_APPEND_DATA) position every O_APPEND write at
//   the end under the inode lock, so small single writes never interleave. That
//   does not hold on network filesystems (NFS, SMB, FUSE), so when statfs
//   reports one the append runs under an advisory lock directory instead. A
//   short write is reported as `unavailable`, and a torn tail left by a crashed
//   writer is fenced off with a newline so it never swallows the next row.
// - Reader tolerance (D17): unknown keys are kept and ignored, unparsable
//   lines and rows without the required keys are skipped and counted, and the
//   file is never rewritten. `seq` is the row's position among valid rows (a
//   lock-free appender cannot allocate one); a row supersedes an older one by
//   its `id`, and only a row of the same type, session and branch (and verdict
//   kind) may.
// - Trust (D18): the threat model is honest mistakes and accidental
//   self-certification, not adversarial agents. `ledger verdict` rows are
//   `observer:"agent_asserted"`; `observer:"workit_cli"` is reserved for rows
//   written by observing verbs through `appendObserved`. `actor.attested` is
//   never trusted. A verdict is `current` when it still applies to the code and
//   `accepted` only when it is current, passing, independent (not self, a
//   known session, not an author) and no current independent verdict fails.
//   Merge gates read only `accepted`.
// - Verdict keying (§2.2): a verdict stores the HEAD SHA it judged plus
//   `base`, the stable patch-id of `base...head` and an exact diff hash. It is
//   `fresh` (same head; verdicts on a dirty worktree are refused, so the head
//   is the judged tree), `carried` (new head, same patch-id AND same exact
//   diff: a rebase that only moved the base) or `stale`.
// - Integrity (D18): every row the CLI appends carries `prevHash` (sha256 of
//   the previous line) and `rowHash` (sha256 over `prevHash` and the row), a
//   running chain. A row without it after the chain began, or whose hashes do
//   not match, is reported as unverified (`workit ledger verify-integrity`, a
//   warning in `ledger check`). Nothing is refused: this catches a hand edit
//   made by mistake, it is not a defense against a forger.
// - Branch renames: rows keyed to a branch's earlier names (from its reflog)
//   count for it, up to the rename.
//
// Plain TS over the git binary, plus the configured trunk (vcsConfig) for the
// default base; no task store.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { vcsConfig } from "./core/vcs-config";
import { GIT_TIMEOUTS, currentBranch, headSha, patchId, worktreeTree } from "./git/rev";
import { hostSessionFromEnv } from "./host-session";
import { resolveStore } from "./store/paths";

export const LEDGER_VERSION = 1;
/** The largest row (including its newline) that one append may carry. */
export const MAX_LINE_BYTES = 4096;

export const VERDICT_RESULTS = [
  "verified",
  "tests-verified",
  "type-check-only",
  "blocked",
  "failed",
] as const;
export type VerdictResult = (typeof VERDICT_RESULTS)[number];
const PASSING: ReadonlySet<string> = new Set(["verified", "tests-verified", "type-check-only"]);
const FAILING: ReadonlySet<string> = new Set(["failed", "blocked"]);
/** Results that prove a behavior change; `type-check-only` never does (S17). */
export const STRONG_RESULTS: ReadonlySet<string> = new Set(["verified", "tests-verified"]);

/**
 * How the branch's current code was reviewed: `verified` only with an
 * accepted independent verdict; `self-reviewed` when the only current strong
 * verdict is the author's own (`--self`), never shown as verified.
 */
export type ReviewLabel = "verified" | "self-reviewed" | "unreviewed";
export const VERDICT_KINDS = ["unit", "live", "perf", "review"] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];
export const VERDICT_SURFACES = ["ui", "cli", "api"] as const;
export type VerdictSurface = (typeof VERDICT_SURFACES)[number];
export type Observer = "agent_asserted" | "workit_cli";

/** Row types written by the CLI's own PR verbs (S10/S11); the only PR→branch source. */
export const PR_ROW_TYPES: ReadonlySet<string> = new Set(["pr.created", "pr.status", "pr.merged"]);

/** Who wrote a row. Unverified: the environment says so (D18). */
export type LedgerActor = { host: string; session: string | null; agentId: string | null };

/** The code state a row was recorded against (§2.2). */
export type CodeKey = {
  branch: string | null;
  head: string | null;
  /** The base ref the patch-id was computed against (e.g. `origin/main`). */
  base: string | null;
  baseSha: string | null;
  patchId: string | null;
  /** sha256 of the exact `base...head` diff (whitespace-sensitive), minus line positions. */
  diffHash: string | null;
  /** Worktree tree key, only when recorded on the checked-out branch. */
  tree: string | null;
  dirty: boolean | null;
};

type RowCommon = CodeKey & {
  v: number;
  id: string;
  at: string;
  type: string;
  actor: LedgerActor;
  pr?: number;
  /** The `id` of an older row of the same type, session and branch (and kind) that this one replaces. */
  supersedes?: string;
};

export type DecisionRow = RowCommon & {
  type: "decision";
  what: string;
  why: string;
  refs: string[];
};
export type RulingRow = RowCommon & {
  type: "ruling";
  what: string;
  why: string;
  costIfWrong: string;
  refs: string[];
};
export type SelfReason = "flag" | "no_session";
/**
 * Where a verdict's session came from: the environment (the host's hook),
 * `--session` (named by the caller, shown in `ledger check` so a human can
 * spot a claimed verifier id) or `--as` (minted from the environment's).
 */
export type SessionSource = "env" | "flag" | "as";
export type VerdictRow = RowCommon & {
  type: "verdict";
  kind: VerdictKind;
  result: VerdictResult;
  how: string;
  surface: VerdictSurface | null;
  observer: Observer;
  /** Not an independent verdict: `--self`, or no session to tell it from the author. */
  self: boolean;
  selfReason: SelfReason | null;
  sessionSource: SessionSource;
  evidenceRefs: string[];
};
export type HandoffRow = RowCommon & { type: "handoff"; note: string | null; next: string };
/** A lead's standing order for every worker of a fanout ("no new dependencies"). */
export type StandingRow = RowCommon & { type: "standing"; fanout: string; what: string };
/** Ends one standing order (`target`), or every one recorded before it (null). */
export type StandingClearedRow = RowCommon & {
  type: "standing.cleared";
  fanout: string;
  target: string | null;
};

export type LedgerRow =
  | DecisionRow
  | RulingRow
  | VerdictRow
  | HandoffRow
  | StandingRow
  | StandingClearedRow;
/**
 * A row's place in the hash chain: `verified` (the CLI wrote it and it is
 * unchanged), `unverified` (see UnverifiedReason) or `legacy` (written before
 * the ledger had a chain).
 */
export type RowIntegrity = "verified" | "unverified" | "legacy";
/** unsigned: no chain fields (hand-appended) · hash_mismatch: edited · broken_link: a row before it was edited or removed. */
export type UnverifiedReason = "unsigned" | "hash_mismatch" | "broken_link";
/** A row as read back: any known or future type, plus its position. */
export type ReadRow = RowCommon &
  Record<string, unknown> & {
    seq: number;
    superseded: boolean;
    /** The row names a `supersedes` target the reader refused (D18 supersede rules). */
    supersedeIgnored: boolean;
    /** Set only when read with `{ integrity: true }`. */
    integrity?: RowIntegrity;
  };

export type LedgerError = {
  ok: false;
  code: "invalid_input" | "blocked" | "busy" | "unavailable" | "not_found";
  error: string;
  unblock?: string;
};
export type LedgerResult<T> = { ok: true; value: T } | LedgerError;

const err = (code: LedgerError["code"], error: string, unblock?: string): LedgerError => ({
  ok: false,
  code,
  error,
  ...(unblock ? { unblock } : {}),
});

// ---------------------------------------------------------------------------
// git plumbing (bounded, never prompts, C locale so messages are matchable)

type GitRun = { ok: boolean; stdout: string; stderr: string };

const gitRun = (cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUTS.local): GitRun => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      LANGUAGE: "C",
    },
  });
  return {
    ok: run.status === 0,
    stdout: run.stdout ?? "",
    stderr: run.error ? String(run.error.message) : (run.stderr ?? ""),
  };
};

const git = (cwd: string, args: string[]): string | null => {
  const run = gitRun(cwd, args);
  const value = run.ok ? run.stdout.trim() : "";
  return value ? value : null;
};

const safeRef = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/** The commit a ref resolves to, or null. */
export function resolveCommit(cwd: string, ref: string): string | null {
  if (!safeRef(ref)) return null;
  return git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
}

/** A local branch's tip, falling back to its remote-tracking ref on origin. */
export function branchHead(cwd: string, branch: string): string | null {
  if (!safeRef(branch)) return null;
  return (
    resolveCommit(cwd, `refs/heads/${branch}`) ??
    resolveCommit(cwd, `refs/remotes/origin/${branch}`)
  );
}

/**
 * The PR target of the release track the checkout is on, when the workspace
 * configures tracks (as `fanout plan` and `stack plan` pick their trunk); a
 * plain workspace default does not override origin's default branch.
 */
const trackTrunk = (cwd: string): string | null => {
  try {
    const resolved = vcsConfig("resolve", cwd);
    if (resolved.ok === false || !resolved.releaseTrack || resolved.releaseTrack.blocking)
      return null;
    const target = String(resolved.defaultTargetBranch ?? "").trim();
    return target && safeRef(target) ? target : null;
  } catch {
    return null;
  }
};

/**
 * The default base for patch-ids and author trailers: the release track's PR
 * target (origin's copy, else the local one) when tracks are configured, else
 * origin's HEAD branch, else the first of origin/main, origin/master, main,
 * master, origin/develop, develop that exists.
 */
export function defaultBase(cwd: string): string | null {
  const trunk = trackTrunk(cwd);
  if (trunk)
    for (const candidate of [`origin/${trunk}`, trunk])
      if (resolveCommit(cwd, candidate)) return candidate;
  const originHead = git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead && resolveCommit(cwd, originHead)) return originHead;
  for (const candidate of [
    "origin/main",
    "origin/master",
    "main",
    "master",
    "origin/develop",
    "develop",
  ])
    if (resolveCommit(cwd, candidate)) return candidate;
  return null;
}

/**
 * sha256 of the exact `base...head` diff with the pinned options rev.ts uses
 * for patch-ids, plus `--binary`. Unlike `git patch-id --stable` it keeps
 * whitespace, so a re-indent (meaningful in Python, YAML, Makefiles) changes
 * it. Hunk headers lose their line numbers and `index` lines are dropped, so a
 * base change elsewhere in the same file does not. Deterministic across git
 * versions (no `patch-id --verbatim` dependency).
 */
export function diffHash(cwd: string, base: string, head: string): string | null {
  if (!safeRef(base) || !safeRef(head)) return null;
  const diff = gitRun(
    cwd,
    [
      "diff",
      "-U3",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--full-index",
      "--binary",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${base}...${head}`,
      "--",
    ],
    GIT_TIMEOUTS.worktree,
  );
  if (!diff.ok || !diff.stdout) return null;
  const hash = createHash("sha256");
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("index ")) continue;
    hash.update(line.startsWith("@@ ") ? "@@" : line);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// store root (D13)

export type StoreRoot = { root: string; shared: boolean };

/**
 * Where workit state lives for `cwd`: `<git common dir>/workit` (shared by all
 * worktrees of the repo), or `<cwd>/.workit` only when git reports that `cwd`
 * is not inside a repository (or git is not installed). A broken repository
 * or a refused (dubious-ownership) repository is `unavailable`. The task
 * store resolves the same way (store/paths.ts).
 */
export function storeRoot(cwd: string): LedgerResult<StoreRoot> {
  const location = resolveStore(path.resolve(cwd));
  if (location instanceof Error)
    return err(
      "unavailable",
      location.message.replace(/; fix the repository.*$/u, ""),
      "fix the repository (git status should work here) or run from a non-git directory",
    );
  return { ok: true, value: { root: location.dir, shared: location.shared } };
}

export function ledgerPath(cwd: string): LedgerResult<string> {
  const root = storeRoot(cwd);
  return root.ok ? { ok: true, value: path.join(root.value.root, "ledger", "ledger.jsonl") } : root;
}

// ---------------------------------------------------------------------------
// append

/** The acting identity from the environment (host-session.ts: WORKIT_SESSION_ID, else the host's own shell session id). */
export function actorFromEnv(env: NodeJS.ProcessEnv): LedgerActor {
  const value = (key: string): string | null => {
    const raw = env[key]?.trim();
    return raw ? raw : null;
  };
  const acting = hostSessionFromEnv(env);
  return {
    host: acting.host ?? "cli",
    session: acting.session,
    agentId: value("WORKIT_AGENT_ID"),
  };
}

const newId = (): string => `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

// statfs magic numbers of network/userspace filesystems (linux/magic.h).
const NETWORK_FS_TYPES: ReadonlySet<number> = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xfe534d42, // SMB2
  0xff534d42, // CIFS
  0x65735546, // FUSE (sshfs, rclone, …)
  0x5346414f, // AFS
  0x00c36400, // Ceph
  0x01021997, // 9P
  0x47504653, // GPFS
  0x0bd00bd0, // Lustre
]);

/** True when `type` (statfs f_type on Linux) names a network or FUSE filesystem. */
export const isNetworkFsType = (type: number): boolean => NETWORK_FS_TYPES.has(type >>> 0);

const onNetworkFs = (dir: string): boolean => {
  if (process.platform !== "linux") return false;
  try {
    return isNetworkFsType(fs.statfsSync(dir).type);
  } catch {
    return false;
  }
};

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const LOCK_OWNER = "owner";

const lockToken = (lock: string): string | null => {
  try {
    return fs.readFileSync(path.join(lock, LOCK_OWNER), "utf8");
  } catch {
    return null;
  }
};

/** Last sign of life: the owner file's mtime, else the directory's. */
const lockAgeMs = (lock: string): number | null => {
  for (const target of [path.join(lock, LOCK_OWNER), lock]) {
    try {
      return Date.now() - fs.statSync(target).mtimeMs;
    } catch {
      // try the next
    }
  }
  return null;
};

/**
 * Advisory lock directory for network filesystems (`mkdir` and `rename` are
 * atomic on NFS too). The holder writes a random ownership token into it and
 * releases only a lock that still carries its own token. A lock idle for
 * LOCK_STALE_MS is taken over by `reap`, which renames it aside, checks that
 * the renamed lock still holds the token the taker judged stale, and puts it
 * back otherwise. So of two takers racing for one stale lock, at most one
 * removes it, and neither removes a lock the other has since acquired.
 */
export const ledgerLock = {
  /** mkdir + token; null when the lock is held. */
  acquire(lock: string): string | null {
    try {
      fs.mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
    fs.writeFileSync(path.join(lock, LOCK_OWNER), token);
    return token;
  },
  /** Remove the lock only if it still carries `token`. */
  release(lock: string, token: string): boolean {
    if (lockToken(lock) !== token) return false;
    const tomb = `${lock}.release-${randomBytes(6).toString("hex")}`;
    try {
      fs.renameSync(lock, tomb);
    } catch {
      return false;
    }
    if (lockToken(tomb) !== token) {
      // Lost a race with a reaper and a new holder: give the lock back.
      try {
        fs.renameSync(tomb, lock);
      } catch {
        // A third holder exists; the renamed lock is not ours to keep.
      }
      return false;
    }
    fs.rmSync(tomb, { recursive: true, force: true });
    return true;
  },
  /** The lock's current token (null when absent or not yet written). */
  token: lockToken,
  /** Take over a lock judged stale while it carried `observed`. */
  reap(lock: string, observed: string | null): boolean {
    const tomb = `${lock}.reap-${randomBytes(6).toString("hex")}`;
    try {
      fs.renameSync(lock, tomb);
    } catch {
      return false; // another taker got there first, or the holder released
    }
    if (lockToken(tomb) === observed) {
      fs.rmSync(tomb, { recursive: true, force: true });
      return true;
    }
    try {
      fs.renameSync(tomb, lock);
    } catch {
      // Someone acquired a fresh lock meanwhile; leave theirs alone.
      fs.rmSync(tomb, { recursive: true, force: true });
    }
    return false;
  },
};

/** Run `fn` holding the ledger's advisory lock; null when it stays held for `waitMs`. */
export function withLedgerLock<T>(
  file: string,
  fn: () => T,
  waitMs: number = LOCK_WAIT_MS,
): T | null {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let token: string | null = null;
  for (;;) {
    token = ledgerLock.acquire(lock);
    if (token) break;
    const observed = lockToken(lock);
    const age = lockAgeMs(lock);
    if (age !== null && age > LOCK_STALE_MS && ledgerLock.reap(lock, observed)) continue;
    if (Date.now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    return fn();
  } finally {
    ledgerLock.release(lock, token);
  }
}

type AppendOptions = { now?: Date; forceLock?: boolean };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The chain hash of a row: over the previous line's hash and the row without `rowHash`. */
const chainHash = (prevHash: string | null, body: string): string =>
  sha256(`${prevHash ?? ""}\n${body}`);
/** Enough tail to hold the previous row (rows are at most MAX_LINE_BYTES). */
const TAIL_BYTES = 64 * 1024;

/**
 * The last complete (newline-terminated) non-empty line before `size`, read
 * from the tail. An unterminated tail is a torn row or another appender's
 * write still in flight, so it is not chained onto. A line longer than the
 * window (a hand-written one) is read whole by widening the window, so the
 * link stays exact.
 */
const lastLine = (fd: number, size: number): string | null => {
  for (let span = Math.min(size, TAIL_BYTES); span > 0; span = Math.min(size, span * 2)) {
    const buffer = Buffer.alloc(span);
    fs.readSync(fd, buffer, 0, span, size - span);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) {
      if (span === size) return null;
      continue;
    }
    // Skip blank lines (a fence) back to the last non-empty complete line.
    let stop = end;
    let text = "";
    while (stop >= 0) {
      const start = buffer.lastIndexOf(0x0a, stop - 1);
      text = buffer.toString("utf8", start + 1, stop).trim();
      if (text) {
        // Its start must be inside the window (or be the file's start).
        if (start >= 0 || span === size) return text;
        break;
      }
      if (start < 0) {
        if (span === size) return null;
        break;
      }
      stop = start;
    }
    if (span === size) return text || null;
  }
  return null;
};

/** The line to write, given the file's current last line (null: empty file). */
type LineBuilder = (previous: string | null) => LedgerResult<string>;

function appendLine(file: string, build: LineBuilder, options: AppendOptions): LedgerResult<void> {
  const write = (): LedgerResult<void> => {
    // a+ = O_APPEND|O_RDWR: every write lands at the end, and we can still
    // peek at the tail to chain onto the last row and fence off a torn one.
    const fd = fs.openSync(file, "a+");
    try {
      const size = fs.fstatSync(fd).size;
      let fence = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) fence = "\n";
      }
      const line = build(lastLine(fd, size));
      if (!line.ok) return line;
      const bytes = Buffer.from(fence + line.value);
      const written = fs.writeSync(fd, bytes);
      if (written !== bytes.length)
        return err(
          "unavailable",
          `short write to ${file}: ${written} of ${bytes.length} bytes; the row is torn and will be skipped`,
        );
      return { ok: true, value: undefined };
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!options.forceLock && !onNetworkFs(path.dirname(file))) return write();
    const locked = withLedgerLock(file, write);
    return (
      locked ??
      err(
        "busy",
        `ledger lock ${file}.lock is held`,
        "retry; remove the .lock directory if no workit process is running",
      )
    );
  } catch (error) {
    return err("unavailable", `cannot append to ${file}: ${(error as Error).message}`);
  }
}

export type NewRow<T extends LedgerRow> = Omit<T, "v" | "id" | "at">;

/**
 * Serialize a row chained onto `previous` (the file's last complete line).
 * Concurrent lock-free appenders may chain onto the same or an older line;
 * the reader accepts a link to any earlier line.
 */
const sealed = (row: object, id: string, at: string, previous: string | null) => {
  const { prevHash: _prev, rowHash: _row, ...fields } = row as Record<string, unknown>;
  const prevHash = previous === null ? null : sha256(previous);
  const body = { v: LEDGER_VERSION, id, at, ...fields, prevHash };
  const full = { ...body, rowHash: chainHash(prevHash, JSON.stringify(body)) };
  return { full, line: `${JSON.stringify(full)}\n` };
};

function appendRaw<T>(cwd: string, row: object, options: AppendOptions): LedgerResult<T> {
  const file = ledgerPath(cwd);
  if (!file.ok) return file;
  const id = newId();
  const at = (options.now ?? new Date()).toISOString();
  let full: unknown = null;
  const written = appendLine(
    file.value,
    (previous) => {
      const next = sealed(row, id, at, previous);
      const bytes = Buffer.byteLength(next.line);
      if (bytes > MAX_LINE_BYTES)
        return err(
          "invalid_input",
          `ledger row is ${bytes} bytes; the limit is ${MAX_LINE_BYTES}. Shorten the text and pass details by --ref <path|url>`,
        );
      full = next.full;
      return { ok: true, value: next.line };
    },
    options,
  );
  return written.ok ? { ok: true, value: full as T } : written;
}

/** Append one agent-level row (decision, ruling, verdict, handoff). */
export function appendRow<T extends LedgerRow>(
  cwd: string,
  row: NewRow<T>,
  options: AppendOptions = {},
): LedgerResult<T> {
  if ((row as { observer?: unknown }).observer === "workit_cli")
    return err("invalid_input", 'observer "workit_cli" is reserved for appendObserved');
  return appendRaw<T>(cwd, row, options);
}

/** The bytes `appendObserved` would write for `row` (its chain fields included). */
export function observedRowBytes(row: Record<string, unknown>): number {
  const sample = sealed({ ...row, observer: "workit_cli" }, newId(), new Date().toISOString(), "");
  return Buffer.byteLength(sample.line);
}

/**
 * Internal API for observing verbs only (S9b `check`, S10 `ci`, S11 `pr`/`git
 * commit`): append a row the CLI itself observed, stamped
 * `observer:"workit_cli"`. Never reachable from `workit ledger`.
 */
export function appendObserved(
  cwd: string,
  row: Record<string, unknown> & { type: string; actor: LedgerActor },
  options: AppendOptions = {},
): LedgerResult<Record<string, unknown>> {
  return appendRaw(cwd, { ...row, observer: "workit_cli" }, options);
}

/**
 * A row a host hook observed (a raw shell `git commit`), stamped
 * `observer:"host_hook"`: weaker than the CLI's own observation, but enough
 * to name the session that authored a commit (D18 honest-agent model).
 */
export function appendHookObserved(
  cwd: string,
  row: Record<string, unknown> & { type: string; actor: LedgerActor },
): LedgerResult<Record<string, unknown>> {
  return appendRaw(cwd, { ...row, observer: "host_hook" }, {});
}

// ---------------------------------------------------------------------------
// read (D17: tolerant)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const normalizeActor = (value: unknown): LedgerActor => {
  const actor = isRecord(value) ? value : {};
  return {
    host: str(actor.host) ?? "unknown",
    session: str(actor.session),
    agentId: str(actor.agentId),
  };
};

type SupersedeRow = Pick<ReadRow, "type" | "actor"> & {
  self?: unknown;
  branch?: unknown;
  kind?: unknown;
  at?: unknown;
};

/**
 * May `by` supersede `target`? Same type, same known session, same branch
 * (`onBranch`: the target belongs to `by`'s branch, which follows renames),
 * for a verdict the same kind, later in the file, and a self verdict never
 * replaces an independent one.
 */
export function supersedeAllowed(
  by: SupersedeRow,
  target: SupersedeRow,
  onBranch: (target: SupersedeRow) => boolean = (row) =>
    (by.branch ?? null) === (row.branch ?? null),
): string | null {
  if (by.type !== target.type) return `a ${by.type} row cannot supersede a ${target.type} row`;
  if (!by.actor.session || by.actor.session !== target.actor.session)
    return "only the session that wrote a row can supersede it";
  if (!onBranch(target))
    return `the row is on another branch (${String(target.branch ?? "none")}); a row supersedes only one on its own branch`;
  if (by.type === "verdict" && (by.kind ?? "review") !== (target.kind ?? "review"))
    return `a ${String(by.kind ?? "review")} verdict cannot supersede a ${String(target.kind ?? "review")} verdict; record it with --kind ${String(target.kind ?? "review")}`;
  if (by.type === "verdict" && by.self === true && target.self !== true)
    return "a self verdict cannot replace an independent verdict";
  return null;
}

export type UnverifiedRow = {
  seq: number;
  id: string;
  type: string;
  branch: string | null;
  reason: UnverifiedReason;
};
/** The hash chain over the file: rows the CLI wrote, rows from before the chain, and the rest. */
export type LedgerIntegrity = { chained: number; legacy: number; unverified: UnverifiedRow[] };
export type LedgerRead = {
  path: string;
  rows: ReadRow[];
  skipped: number;
  /** Only when read with `{ integrity: true }` (hashing every line has a cost). */
  integrity: LedgerIntegrity | null;
};

/**
 * Every valid row in append order. A missing file is empty. `integrity`
 * verifies the hash chain too (`ledger check`, `verify-integrity`); other
 * readers, such as the write gate, skip that cost.
 */
export function readLedger(
  cwd: string,
  options: { integrity?: boolean } = {},
): LedgerResult<LedgerRead> {
  const file = ledgerPath(cwd);
  if (!file.ok) return file;
  let text = "";
  try {
    text = fs.readFileSync(file.value, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        ok: true,
        value: {
          path: file.value,
          rows: [],
          skipped: 0,
          integrity: options.integrity ? { chained: 0, legacy: 0, unverified: [] } : null,
        },
      };
    return err("unavailable", `cannot read ${file.value}: ${(error as Error).message}`);
  }
  const rows: ReadRow[] = [];
  let skipped = 0;
  const integrity: LedgerIntegrity = { chained: 0, legacy: 0, unverified: [] };
  // Hashes of every earlier line; null stands for the start of the file.
  // Lock-free appenders racing on one file chain onto whatever line they saw
  // last, which can be dozens of lines back, so any earlier line is a valid
  // link. An edited row fails its own hash and breaks every link to it.
  const earlier = new Set<string | null>([null]);
  let chainStarted = false;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Checked after this line is added: a row cannot name its own line.
    const linked = (prevHash: string | null): boolean => earlier.has(prevHash);
    if (options.integrity) earlier.add(sha256(trimmed));
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(parsed) || !str(parsed.id) || !str(parsed.type) || !str(parsed.at)) {
      skipped += 1;
      continue;
    }
    let rowIntegrity: RowIntegrity | undefined = options.integrity ? "verified" : undefined;
    let reason: UnverifiedReason | null = null;
    if (!options.integrity) {
      // not verified on this read
    } else if (typeof parsed.rowHash === "string") {
      chainStarted = true;
      const { rowHash, ...body } = parsed;
      const prevHash = str(parsed.prevHash);
      if (chainHash(prevHash, JSON.stringify(body)) !== rowHash) reason = "hash_mismatch";
      else if (!linked(prevHash)) reason = "broken_link";
    } else if (chainStarted) reason = "unsigned";
    else rowIntegrity = "legacy";
    if (reason) rowIntegrity = "unverified";
    const pr = typeof parsed.pr === "number" && Number.isInteger(parsed.pr) ? parsed.pr : undefined;
    const row: ReadRow = {
      ...parsed,
      v: typeof parsed.v === "number" ? parsed.v : LEDGER_VERSION,
      id: parsed.id as string,
      at: parsed.at as string,
      type: parsed.type as string,
      actor: normalizeActor(parsed.actor),
      branch: str(parsed.branch),
      head: str(parsed.head),
      base: str(parsed.base),
      baseSha: str(parsed.baseSha),
      patchId: str(parsed.patchId),
      diffHash: str(parsed.diffHash),
      tree: str(parsed.tree),
      dirty: typeof parsed.dirty === "boolean" ? parsed.dirty : null,
      ...(pr === undefined ? {} : { pr }),
      ...(str(parsed.supersedes) ? { supersedes: parsed.supersedes as string } : {}),
      seq: rows.length + 1,
      superseded: false,
      supersedeIgnored: false,
      ...(rowIntegrity ? { integrity: rowIntegrity } : {}),
    };
    rows.push(row);
    if (!options.integrity) continue;
    if (rowIntegrity === "verified") integrity.chained += 1;
    else if (rowIntegrity === "legacy") integrity.legacy += 1;
    else if (reason)
      integrity.unverified.push({
        seq: row.seq,
        id: row.id,
        type: row.type,
        branch: row.branch,
        reason,
      });
  }
  // Only a well-formed supersede link counts; anything else is ignored. A
  // link across branch names is checked against the renames (reflog read
  // only for such links, once per branch).
  const scopes = new Map<string, BranchScope>();
  const scopeOf = (branch: string): BranchScope => {
    let scope = scopes.get(branch);
    if (!scope) scopes.set(branch, (scope = branchScope(cwd, branch)));
    return scope;
  };
  const byId = new Map<string, ReadRow>();
  for (const row of rows) {
    const target = row.supersedes ? byId.get(row.supersedes) : undefined;
    if (target && supersedeAllowed(row, target, renameAwareBranch(scopeOf, row.branch)) === null)
      target.superseded = true;
    else if (row.supersedes) row.supersedeIgnored = true;
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return {
    ok: true,
    value: { path: file.value, rows, skipped, integrity: options.integrity ? integrity : null },
  };
}

export type RowFilter = { branch?: string; pr?: number; type?: string; last?: number };

export function filterRows(rows: readonly ReadRow[], filter: RowFilter): ReadRow[] {
  const matched = rows.filter(
    (row) =>
      (filter.branch === undefined || row.branch === filter.branch) &&
      (filter.pr === undefined || row.pr === filter.pr) &&
      (filter.type === undefined || row.type === filter.type),
  );
  return filter.last === undefined
    ? matched
    : matched.slice(Math.max(0, matched.length - filter.last));
}

// ---------------------------------------------------------------------------
// PR → branch (never from arbitrary rows)

export type PrBranch =
  | { ok: true; branch: string; source: "pr_row" | "forge_ref" }
  | { ok: false; reason: "unknown" | "ambiguous"; candidates: string[] };

/**
 * The branch a PR/MR number belongs to, from (1) rows the CLI's own PR verbs
 * observed (`PR_ROW_TYPES` with `observer:"workit_cli"`), else (2) a fetched
 * forge ref (`refs/pull/<n>/head`, `refs/merge-requests/<n>/head`, or the same
 * under `refs/remotes/<remote>/`) whose commit is the tip of exactly one local
 * branch. Forge refs that disagree, or a tip shared by several branches, are
 * `ambiguous`; nothing at all is `unknown`.
 */
export function branchForPr(cwd: string, rows: readonly ReadRow[], pr: number): PrBranch {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.pr === pr && row.branch && PR_ROW_TYPES.has(row.type) && row.observer === "workit_cli")
      return { ok: true, branch: row.branch, source: "pr_row" };
  }
  const tips = git(cwd, [
    "for-each-ref",
    "--format=%(objectname)",
    `refs/pull/${pr}/head`,
    `refs/merge-requests/${pr}/head`,
    `refs/remotes/*/pull/${pr}/head`,
    `refs/remotes/*/merge-requests/${pr}/head`,
  ]);
  const shas = [...new Set((tips ?? "").split("\n").filter(Boolean))];
  if (shas.length === 0) return { ok: false, reason: "unknown", candidates: [] };
  if (shas.length > 1) return { ok: false, reason: "ambiguous", candidates: shas };
  const branches = (
    git(cwd, ["for-each-ref", "--format=%(refname:short)", "--points-at", shas[0], "refs/heads"]) ??
    ""
  )
    .split("\n")
    .filter(Boolean);
  if (branches.length === 1) return { ok: true, branch: branches[0], source: "forge_ref" };
  return branches.length === 0
    ? { ok: false, reason: "unknown", candidates: [] }
    : { ok: false, reason: "ambiguous", candidates: branches };
}

// ---------------------------------------------------------------------------
// code keys and verdict validity (§2.2)

/**
 * The code state of `branch` (default: the checked-out branch) against
 * `base` (default: defaultBase). The worktree tree is included only for the
 * checked-out branch.
 */
export function codeKey(
  cwd: string,
  options: { branch?: string | null; base?: string | null } = {},
): CodeKey {
  const checkedOut = currentBranch(cwd);
  const branch = options.branch ?? checkedOut;
  const head = branch ? branchHead(cwd, branch) : headSha(cwd);
  const base = options.base ?? defaultBase(cwd);
  const baseSha = base ? resolveCommit(cwd, base) : null;
  const onTree = branch !== null && branch === checkedOut;
  const tree = onTree ? worktreeTree(cwd) : null;
  return {
    branch,
    head,
    base,
    baseSha,
    patchId: base && head ? patchId(cwd, base, head) : null,
    diffHash: base && head ? diffHash(cwd, base, head) : null,
    tree: tree?.key ?? null,
    dirty: tree ? tree.dirty : null,
  };
}

export type VerdictBasis = "fresh" | "carried" | "stale" | "none";

type Keyed = { head: string | null; patchId: string | null; diffHash: string | null };

/** fresh: same head · carried: same non-null patch-id AND exact diff · stale: otherwise. */
export function verdictBasis(verdict: Keyed, current: Keyed): Exclude<VerdictBasis, "none"> {
  if (verdict.head && verdict.head === current.head) return "fresh";
  if (
    verdict.patchId &&
    verdict.patchId === current.patchId &&
    verdict.diffHash &&
    verdict.diffHash === current.diffHash
  )
    return "carried";
  return "stale";
}

export type RejectReason =
  | "stale"
  | "not_passing"
  | "self"
  | "no_session"
  | "author_session"
  | "failing_verdict"
  /** The only passing current verdict is `type-check-only`, which proves no behavior. */
  | "type_check_only"
  | "no_verdict";

export type VerdictEntry = {
  kind: string;
  basis: Exclude<VerdictBasis, "none">;
  /** The verdict still applies to the code (fresh or carried). */
  current: boolean;
  /** Independent: not self, a known session, not an author of the branch. */
  independent: boolean;
  /** current AND passing AND independent. */
  accepted: boolean;
  reasons: RejectReason[];
  verdict: ReadRow;
};

export type VerdictCheck = {
  branch: string;
  head: string | null;
  base: string | null;
  patchId: string | null;
  /** Newest current verdict (else newest verdict): does it still apply? */
  current: { basis: VerdictBasis; verdict: ReadRow | null };
  /**
   * What merge gates read: an accepted strong (`verified`/`tests-verified`)
   * verdict and no current independent failure. `type-check-only` never counts.
   */
  accepted: { accepted: boolean; verdict: ReadRow | null; reasons: RejectReason[] };
  review: ReviewLabel;
  /** The newest current, strong, self verdict when `review` is self-reviewed. */
  selfVerdict: ReadRow | null;
  verdicts: VerdictEntry[];
  authors: string[];
  /**
   * Things a human should read before trusting the result; none of them
   * blocks (D18): unverified ledger rows on the branch, and an author's own
   * failure newer than the accepted pass.
   */
  warnings: string[];
};

const isLiveVerdict = (row: ReadRow): boolean =>
  row.type === "verdict" && typeof row.result === "string" && !row.superseded;

/** Sessions recorded in `Workit-Session:` trailers of `base...head` commits. */
function trailerSessions(cwd: string, base: string | null, head: string | null): string[] {
  if (!base || !head || !safeRef(base) || !safeRef(head)) return [];
  const out = git(cwd, [
    "log",
    "--format=%(trailers:key=Workit-Session,valueonly,separator=%x00)",
    `${base}..${head}`,
  ]);
  return (out ?? "")
    .split(/[\0\n]/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Does a row belong to a branch? Its own name, or an earlier name up to the rename. */
export type BranchScope = (row: Pick<ReadRow, "branch" | "at">) => boolean;

const RENAMED = /^branch: renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/iu;

/**
 * The rows of `branch`, following `git branch -m` through the branch's
 * reflog (git moves the reflog with the branch): a row keyed to an earlier
 * name counts until that rename, so a name reused later does not leak in.
 */
export function branchScope(cwd: string, branch: string): BranchScope {
  const renamedAt = new Map<string, number>();
  // The branch's oldest reflog entry (its creation): rows of an older,
  // deleted branch that once had one of its earlier names predate it.
  let since = Number.NEGATIVE_INFINITY;
  if (safeRef(branch)) {
    const log = git(cwd, [
      "log",
      "-g",
      "--date=unix",
      "--format=%gd%x09%gs",
      `refs/heads/${branch}`,
      "--",
    ]);
    for (const line of (log ?? "").split("\n")) {
      const [selector = "", subject = ""] = line.split("\t");
      const seconds = Number(/@\{(\d+)\}$/u.exec(selector)?.[1]);
      if (!Number.isFinite(seconds)) continue;
      // Newest first: the last entry read is the oldest.
      since = seconds * 1000;
      const match = RENAMED.exec(subject);
      if (!match || match[1] === branch) continue;
      // Reflog times are whole seconds: the rename's second still counts.
      const until = (seconds + 1) * 1000;
      renamedAt.set(match[1], Math.max(renamedAt.get(match[1]) ?? 0, until));
    }
  }
  return (row) => {
    if (row.branch === branch) return true;
    const until = row.branch === null ? undefined : renamedAt.get(row.branch);
    if (until === undefined) return false;
    const at = Date.parse(row.at);
    return at >= since && at <= until;
  };
}

/** `supersedeAllowed`'s branch test for rows on `branch`, following its renames. */
const renameAwareBranch = (scopeOf: (branch: string) => BranchScope, branch: unknown) => {
  return (target: SupersedeRow): boolean => {
    const own = typeof branch === "string" ? branch : null;
    const theirs = typeof target.branch === "string" ? target.branch : null;
    if (own === theirs) return true;
    if (own === null || theirs === null || typeof target.at !== "string") return false;
    return scopeOf(own)({ branch: theirs, at: target.at });
  };
};

/**
 * Sessions that authored `branch`: the union of `commit.recorded` /
 * `task.opened` ledger rows (under its current or an earlier name) and
 * `Workit-Session:` commit trailers on `base..head`. Git author name/email is
 * not used: every agent on a machine shares it, so it cannot tell sessions
 * apart.
 */
export function authorSessions(
  cwd: string,
  rows: readonly ReadRow[],
  branch: string,
  range: { base: string | null; head: string | null } = { base: null, head: null },
  scope: BranchScope = branchScope(cwd, branch),
): Set<string> {
  const sessions = new Set<string>();
  for (const row of rows) {
    if (!scope(row) || (row.type !== "commit.recorded" && row.type !== "task.opened")) continue;
    const session = str(row.session) ?? row.actor.session;
    if (session) sessions.add(session);
  }
  for (const session of trailerSessions(cwd, range.base, range.head)) sessions.add(session);
  return sessions;
}

const independenceReasons = (row: ReadRow, authors: Set<string>): RejectReason[] => {
  const reasons: RejectReason[] = [];
  if (!row.actor.session) reasons.push("no_session");
  else if (authors.has(row.actor.session)) reasons.push("author_session");
  if (row.self === true && !reasons.includes("no_session")) reasons.push("self");
  return reasons;
};

/**
 * The effective verdict of one kind, walking rows in order: a self verdict
 * never displaces a current independent one (a stale one it does, so the
 * author's pass on new code is not hidden behind it), and an independent failed/blocked
 * verdict sticks, for the code it judged, until an independent verdict from a
 * different session (or its own session's supersede) replaces it. A verdict
 * from the same session on different code (`sameCode` false: a real change,
 * not a carry or restack of the failed code) is a re-review of the fix and
 * replaces it.
 */
function effectiveOf(
  rows: readonly ReadRow[],
  authors: Set<string>,
  sameCode: (failed: ReadRow, row: ReadRow) => boolean,
  isCurrent: (row: ReadRow) => boolean,
): ReadRow | null {
  let effective: ReadRow | null = null;
  for (const row of rows) {
    if (!effective) {
      effective = row;
      continue;
    }
    const rowIndependent = independenceReasons(row, authors).length === 0;
    const effIndependent = independenceReasons(effective, authors).length === 0;
    if (effIndependent && !rowIndependent && isCurrent(effective)) continue;
    if (
      effIndependent &&
      FAILING.has(String(effective.result)) &&
      row.actor.session === effective.actor.session &&
      sameCode(effective, row)
    )
      continue;
    effective = row;
  }
  return effective;
}

/**
 * Stacked branches (S12): a verdict keyed against the trunk cannot carry
 * through a restack after its parent was squash-merged, because the
 * trunk-relative diff loses the parent's change. `workit stack sync` observes
 * each restack itself and records `stack.restacked` with `patchEqual` when
 * the change relative to the parent is identical (same patch-id AND same
 * exact diff hash, D18). A verdict carries when such observed rows link its
 * head to the current head.
 */
function restackCarries(
  rows: readonly ReadRow[],
  branch: string,
  from: string | null,
  to: string | null,
): boolean {
  if (!from || !to) return false;
  const edges = new Map<string, string[]>();
  for (const row of rows)
    if (
      row.type === "stack.restacked" &&
      row.observer === "workit_cli" &&
      row.branch === branch &&
      row.patchEqual === true &&
      typeof row.fromHead === "string" &&
      row.head
    )
      edges.set(row.fromHead, [...(edges.get(row.fromHead) ?? []), row.head]);
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const next = queue.shift() as string;
    if (next === to) return true;
    for (const target of edges.get(next) ?? [])
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
  }
  return false;
}

/** Current and accepted verdicts for `branch`, after carry-over (D18). */
export function checkVerdicts(cwd: string, branch: string, rows: readonly ReadRow[]): VerdictCheck {
  const head = branchHead(cwd, branch);
  const fallbackBase = defaultBase(cwd);
  const scope = branchScope(cwd, branch);
  const keyCache = new Map<string, { patchId: string | null; diffHash: string | null }>();
  const keysAt = (base: string | null, at: string | null) => {
    if (!base || !at) return { patchId: null, diffHash: null };
    const cacheKey = `${base}\0${at}`;
    let key = keyCache.get(cacheKey);
    if (!key) {
      key = { patchId: patchId(cwd, base, at), diffHash: diffHash(cwd, base, at) };
      keyCache.set(cacheKey, key);
    }
    return key;
  };
  const keyFor = (base: string | null) => keysAt(base, head);
  const basisOf = (row: ReadRow): Exclude<VerdictBasis, "none"> => {
    const basis = verdictBasis(row, { head, ...keyFor(row.base ?? fallbackBase) });
    return basis === "stale" && restackCarries(rows, branch, row.head, head) ? "carried" : basis;
  };
  // A newer row is judged under the failure's own base, so a row recorded
  // with a different --base cannot make unchanged code look changed. When
  // both rows were keyed against the same base commit, the newer row's own
  // stored keys are that comparison already: no git call per row.
  const sameCode = (failed: ReadRow, row: ReadRow): boolean => {
    if (failed.head && failed.head === row.head) return true;
    const base = failed.base ?? fallbackBase;
    const stored =
      (row.base ?? fallbackBase) === base && row.baseSha !== null && row.baseSha === failed.baseSha;
    const keys = stored ? { patchId: row.patchId, diffHash: row.diffHash } : keysAt(base, row.head);
    return (
      verdictBasis(failed, { head: row.head, ...keys }) !== "stale" ||
      restackCarries(rows, branch, failed.head, row.head)
    );
  };
  const authors = authorSessions(cwd, rows, branch, { base: fallbackBase, head }, scope);
  const byKind = new Map<string, ReadRow[]>();
  for (const row of rows)
    if (isLiveVerdict(row) && scope(row)) {
      const kind = typeof row.kind === "string" ? row.kind : "review";
      byKind.set(kind, [...(byKind.get(kind) ?? []), row]);
    }
  const verdicts: VerdictEntry[] = [];
  const warnings: string[] = [];
  for (const [kind, list] of byKind) {
    const row = effectiveOf(list, authors, sameCode, (candidate) => basisOf(candidate) !== "stale");
    if (!row) continue;
    const basis = basisOf(row);
    const current = basis !== "stale";
    const independence = independenceReasons(row, authors);
    const reasons: RejectReason[] = [
      ...(current ? [] : (["stale"] as const)),
      ...(PASSING.has(String(row.result)) ? [] : (["not_passing"] as const)),
      ...independence,
    ];
    verdicts.push({
      kind,
      basis,
      current,
      independent: independence.length === 0,
      accepted: reasons.length === 0,
      reasons,
      verdict: row,
    });
    // The author's own failure never displaces an independent pass, but it
    // must not vanish either.
    if (reasons.length === 0)
      for (const later of list)
        if (
          later.seq > row.seq &&
          independenceReasons(later, authors).length > 0 &&
          FAILING.has(String(later.result)) &&
          basisOf(later) !== "stale"
        )
          warnings.push(
            `the author's own (self) ${String(later.result)} ${kind} verdict ${later.id} by ${later.actor.session ?? "no session"} on the current code is newer than the accepted pass ${row.id}: read it before merging`,
          );
  }
  for (const row of rows)
    if (row.integrity === "unverified" && scope(row))
      warnings.push(
        `ledger row ${row.id} (${row.type}) on ${row.branch ?? branch} is unverified: the workit CLI did not write it or it changed afterwards (workit ledger verify-integrity)`,
      );
  verdicts.sort((a, b) => a.verdict.seq - b.verdict.seq);
  const newestCurrent = verdicts.findLast((entry) => entry.current) ?? verdicts.at(-1) ?? null;
  const failing = verdicts.find(
    (entry) => entry.current && entry.independent && FAILING.has(String(entry.verdict.result)),
  );
  const newestAccepted =
    verdicts.findLast(
      (entry) => entry.accepted && STRONG_RESULTS.has(String(entry.verdict.result)),
    ) ?? null;
  const accepted =
    newestAccepted && !failing
      ? { accepted: true, verdict: newestAccepted.verdict, reasons: [] }
      : {
          accepted: false,
          verdict: failing?.verdict ?? null,
          reasons: failing
            ? (["failing_verdict"] as RejectReason[])
            : !newestCurrent
              ? (["no_verdict"] as RejectReason[])
              : newestCurrent.reasons.length
                ? newestCurrent.reasons
                : (["type_check_only"] as RejectReason[]),
        };
  const selfEntry = failing
    ? undefined
    : verdicts.findLast(
        (entry) =>
          entry.current && !entry.independent && STRONG_RESULTS.has(String(entry.verdict.result)),
      );
  return {
    branch,
    head,
    review: accepted.accepted ? "verified" : selfEntry ? "self-reviewed" : "unreviewed",
    selfVerdict: accepted.accepted ? null : (selfEntry?.verdict ?? null),
    base: newestCurrent?.verdict.base ?? fallbackBase,
    patchId: keyFor(newestCurrent?.verdict.base ?? fallbackBase).patchId,
    current: { basis: newestCurrent?.basis ?? "none", verdict: newestCurrent?.verdict ?? null },
    accepted,
    verdicts,
    authors: [...authors].toSorted(),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// recording helpers

export type RecordContext = {
  cwd: string;
  actor: LedgerActor;
  branch?: string | null;
  base?: string | null;
  pr?: number;
  supersedes?: string;
  /** Where `actor.session` came from (verdicts record it). Default: the environment. */
  sessionSource?: SessionSource;
  now?: Date;
};

const common = (context: RecordContext, key: CodeKey) => ({
  ...key,
  actor: context.actor,
  ...(context.pr === undefined ? {} : { pr: context.pr }),
  ...(context.supersedes ? { supersedes: context.supersedes } : {}),
});

/** Cheap key for notes: branch and head only (no tree hashing, no patch-id). */
const noteKey = (context: RecordContext): CodeKey => {
  const branch = context.branch ?? currentBranch(context.cwd);
  return {
    branch,
    head: branch ? branchHead(context.cwd, branch) : headSha(context.cwd),
    base: null,
    baseSha: null,
    patchId: null,
    diffHash: null,
    tree: null,
    dirty: null,
  };
};

const required = (value: string | undefined | null, flag: string): LedgerResult<string> => {
  const text = value?.trim();
  return text ? { ok: true, value: text } : err("invalid_input", `${flag} is required`);
};

/** Refuse a supersede link that the reader would ignore. */
function checkSupersede(
  context: RecordContext,
  type: string,
  row: { self?: boolean; kind?: string; branch?: string | null } = {},
): LedgerResult<void> {
  if (!context.supersedes) return { ok: true, value: undefined };
  const ledger = readLedger(context.cwd);
  if (!ledger.ok) return ledger;
  const target = ledger.value.rows.find((candidate) => candidate.id === context.supersedes);
  if (!target) return err("not_found", `no ledger row ${context.supersedes} to supersede`);
  const branch =
    row.branch === undefined ? (context.branch ?? currentBranch(context.cwd)) : row.branch;
  const problem = supersedeAllowed(
    { type, actor: context.actor, ...row, branch },
    target,
    renameAwareBranch((name) => branchScope(context.cwd, name), branch),
  );
  return problem
    ? err("invalid_input", `--supersedes: ${problem}`)
    : { ok: true, value: undefined };
}

export function recordDecision(
  context: RecordContext,
  input: { what?: string; why?: string; refs?: string[] },
): LedgerResult<DecisionRow> {
  const what = required(input.what, "<what>");
  if (!what.ok) return what;
  const why = required(input.why, "--why");
  if (!why.ok) return why;
  const link = checkSupersede(context, "decision");
  if (!link.ok) return link;
  return appendRow<DecisionRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "decision",
      what: what.value,
      why: why.value,
      refs: input.refs ?? [],
    },
    { now: context.now },
  );
}

export function recordRuling(
  context: RecordContext,
  input: { what?: string; why?: string; costIfWrong?: string; refs?: string[] },
): LedgerResult<RulingRow> {
  const what = required(input.what, "<what>");
  if (!what.ok) return what;
  const why = required(input.why, "--why");
  if (!why.ok) return why;
  const cost = required(input.costIfWrong, "--cost-if-wrong");
  if (!cost.ok) return cost;
  const link = checkSupersede(context, "ruling");
  if (!link.ok) return link;
  return appendRow<RulingRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "ruling",
      what: what.value,
      why: why.value,
      costIfWrong: cost.value,
      refs: input.refs ?? [],
    },
    { now: context.now },
  );
}

/**
 * May this row speak for the fanout's lead? With recorded leads (the current
 * one and any it took over from) only their rows count; a plan from before
 * leads (null) takes any session.
 */
const fromLead = (row: ReadRow, leads: readonly string[] | null): boolean =>
  leads === null || (row.actor.session !== null && leads.includes(row.actor.session));

/**
 * The standing orders in force for `fanout`, oldest first (D17: odd rows are
 * skipped). Given the plan's lead session, orders and clears recorded by any
 * other session are ignored, so a worker can neither add nor clear one.
 */
export function activeStanding(
  rows: readonly ReadRow[],
  fanout: string,
  leads: readonly string[] | null = null,
): ReadRow[] {
  const active: ReadRow[] = [];
  for (const row of rows) {
    if (row.fanout !== fanout || !fromLead(row, leads)) continue;
    if (row.type === "standing" && typeof row.what === "string" && row.what.trim()) {
      if (!row.superseded) active.push(row);
    } else if (row.type === "standing.cleared") {
      const target = str(row.target);
      if (target === null) active.length = 0;
      else {
        const index = active.findIndex((order) => order.id === target);
        if (index >= 0) active.splice(index, 1);
      }
    }
  }
  return active;
}

/**
 * A worker or verifier session by the ids workit hands out: `fanout brief`'s
 * `<lead>-w-<slice>[+try<n>]`, a verifier's `<lead>-v<n>`, the Claude Code
 * hook's `<lead>:<agent id>` and `--as` ids (`<session>:<role>:<hex>`). Host
 * session ids carry no colon. Used where no recorded lead decides: plans that
 * predate `leadSession`, and `fanout plan --take-lead`.
 */
export const isDelegateSession = (session: string | null): boolean =>
  session !== null &&
  (/-w-[a-z0-9._-]+(?:\+try\d)?$/u.test(session) ||
    /-v\d+$/u.test(session) ||
    session.includes(":"));

/**
 * Standing orders come from the fanout's lead: the session that first made
 * the plan (`lead`). A plan without one falls back to refusing the session
 * ids handed to workers and verifiers.
 */
function leadOnly(context: RecordContext, lead: string | null): LedgerResult<void> {
  const session = context.actor.session;
  if (lead !== null ? session === lead : !isDelegateSession(session))
    return { ok: true, value: undefined };
  return err(
    "blocked",
    lead !== null
      ? `session ${session ?? "(none)"} is not the fanout's lead (${lead}): standing orders come from the lead`
      : `session ${session} is a worker or verifier: standing orders come from the lead`,
    lead !== null
      ? `the lead in a new session? workit fanout plan <plan.json> --take-lead from this session; a worker or verifier reports the order to the lead instead`
      : "a worker or verifier reports the order to the lead instead",
  );
}

export function recordStanding(
  context: RecordContext,
  input: { fanout: string; lead: string | null; what?: string },
): LedgerResult<StandingRow> {
  const what = required(input.what, "<order>");
  if (!what.ok) return what;
  // One order per line of every brief: a newline or control character would
  // let an order forge other brief fields.
  if (/\p{Cc}/u.test(what.value))
    return err(
      "invalid_input",
      "a standing order is one line: no newlines or control characters",
      'add each order separately: workit ledger standing add "<order>"',
    );
  const lead = leadOnly(context, input.lead);
  if (!lead.ok) return lead;
  const link = checkSupersede(context, "standing");
  if (!link.ok) return link;
  return appendRow<StandingRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "standing",
      fanout: input.fanout,
      what: what.value,
    },
    { now: context.now },
  );
}

/** Clear one standing order by id (it must be in force), or all of them; lead only. */
export function clearStanding(
  context: RecordContext,
  input: {
    fanout: string;
    lead: string | null;
    leads?: readonly string[] | null;
    target: string | null;
  },
): LedgerResult<StandingClearedRow> {
  const lead = leadOnly(context, input.lead);
  if (!lead.ok) return lead;
  if (input.target !== null) {
    const ledger = readLedger(context.cwd);
    if (!ledger.ok) return ledger;
    if (
      !activeStanding(ledger.value.rows, input.fanout, input.leads ?? null).some(
        (row) => row.id === input.target,
      )
    )
      return err(
        "not_found",
        `no standing order ${input.target} in force for fanout ${input.fanout}`,
        `workit ledger standing list --fanout ${input.fanout}`,
      );
  }
  return appendRow<StandingClearedRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "standing.cleared",
      fanout: input.fanout,
      target: input.target,
    },
    { now: context.now },
  );
}

/**
 * Is `branch` checked out, with uncommitted changes, in another worktree of
 * this repository? (`codeKey` sees only the cwd's own worktree.)
 */
function dirtyElsewhere(cwd: string, branch: string, head: string): boolean {
  // A checkout of exactly the branch head (a verifier's detached worktree)
  // judges what it holds: clean judges that head, whatever state another
  // checkout of the branch is in; dirty (or unreadable) does not.
  if (headSha(cwd) === head) return worktreeTree(cwd)?.dirty !== false;
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  let worktree: string | null = null;
  for (const line of (list ?? "").split("\n")) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && worktree) {
      const status = gitRun(worktree, ["status", "--porcelain", "--untracked-files=normal"]);
      return status.ok && status.stdout.trim().length > 0;
    }
  }
  return false;
}

/**
 * Record an agent-asserted verdict on a branch's committed head. Refused on a
 * dirty worktree (the head would not be what was judged) and, for an author
 * session, unless `--self`. Without a session the verdict is recorded as
 * self: an unknown actor cannot be told apart from the author.
 */
export function recordVerdict(
  context: RecordContext,
  input: {
    result: string;
    kind?: string;
    how?: string;
    surface?: string | null;
    self?: boolean;
    evidenceRefs?: string[];
    /**
     * A role id derived from another session (`--as`): the session it was
     * derived from. `null` means it was derived from no session, which makes
     * the verdict self. An author's derived id is refused like the author.
     */
    derivedFrom?: string | null;
  },
): LedgerResult<VerdictRow> {
  if (!(VERDICT_RESULTS as readonly string[]).includes(input.result))
    return err(
      "invalid_input",
      `unknown verdict "${input.result}"; expected ${VERDICT_RESULTS.join("|")}`,
    );
  const kind = input.kind ?? "review";
  if (!(VERDICT_KINDS as readonly string[]).includes(kind))
    return err("invalid_input", `--kind must be ${VERDICT_KINDS.join("|")}`);
  const surface = input.surface ?? null;
  if (surface !== null && !(VERDICT_SURFACES as readonly string[]).includes(surface))
    return err("invalid_input", `--surface must be ${VERDICT_SURFACES.join("|")}`);
  const how = required(input.how, "--how");
  if (!how.ok) return how;
  const branch = context.branch ?? currentBranch(context.cwd);
  if (!branch)
    return err(
      "invalid_input",
      "HEAD is detached; name the branch the verdict is for",
      "pass --branch <branch>",
    );
  const ledger = readLedger(context.cwd);
  if (!ledger.ok) return ledger;
  const key = codeKey(context.cwd, { branch, base: context.base });
  if (!key.head) return err("not_found", `branch "${branch}" has no commit to judge`);
  if (key.dirty === true || (key.dirty === null && dirtyElsewhere(context.cwd, branch, key.head)))
    return err(
      "blocked",
      `dirty_worktree: ${branch} has uncommitted changes, so its head is not what was judged`,
      "commit or stash the changes, re-check, then record the verdict",
    );
  const session = context.actor.session;
  const selfReason: SelfReason | null =
    input.self === true ? "flag" : session && input.derivedFrom !== null ? null : "no_session";
  const self = selfReason !== null;
  const authors = authorSessions(context.cwd, ledger.value.rows, branch, {
    base: key.base,
    head: key.head,
  });
  const authoring = [session, input.derivedFrom].find(
    (candidate): candidate is string => typeof candidate === "string" && authors.has(candidate),
  );
  if (!self && authoring)
    return err(
      "blocked",
      `author_verdict: session ${authoring} authored ${branch}; a verdict must come from a different session`,
      input.derivedFrom === undefined
        ? "have a non-author session record the verdict: spawn a verifier with its own WORKIT_SESSION_ID=<lead>-v<n> (Claude Code: subagents get one from the SubagentStart hook); or, as the author, pass --self (self-reviewed, never accepted)"
        : "run the verifier as a separate session: the lead spawns it with its own WORKIT_SESSION_ID (Claude Code: subagents get one from the SubagentStart hook)",
    );
  const link = checkSupersede(context, "verdict", { self, kind, branch });
  if (!link.ok) return link;
  return appendRow<VerdictRow>(
    context.cwd,
    {
      ...common(context, key),
      type: "verdict",
      kind: kind as VerdictKind,
      result: input.result as VerdictResult,
      how: how.value,
      surface: surface as VerdictSurface | null,
      observer: "agent_asserted",
      self,
      selfReason,
      sessionSource: context.sessionSource ?? "env",
      evidenceRefs: input.evidenceRefs ?? [],
    },
    { now: context.now },
  );
}

export function recordHandoff(
  context: RecordContext,
  input: { note: string | null; next: string },
): LedgerResult<HandoffRow> {
  return appendRow<HandoffRow>(
    context.cwd,
    { ...common(context, noteKey(context)), type: "handoff", note: input.note, next: input.next },
    { now: context.now },
  );
}

// ---------------------------------------------------------------------------
// handoff brief (replaces export/import: the ledger is shared across worktrees)

export type RowSummary = {
  seq: number;
  id: string;
  at: string;
  type: string;
  branch: string | null;
  summary: string;
  /** Why a reader should discount the row: superseded, ignored (by the trust rules), self. */
  labels: Array<"superseded" | "ignored" | "self">;
};

/** Row types that count only when an observing verb wrote them. */
const OBSERVED_ONLY: ReadonlySet<string> = new Set([
  "check",
  "merge.unverified",
  "policy.judged",
  ...PR_ROW_TYPES,
]);

export function rowLabels(row: ReadRow): RowSummary["labels"] {
  const labels: RowSummary["labels"] = [];
  if (row.superseded) labels.push("superseded");
  if (row.supersedeIgnored || (OBSERVED_ONLY.has(row.type) && row.observer !== "workit_cli"))
    labels.push("ignored");
  if (row.type === "verdict" && row.self === true) labels.push("self");
  return labels;
}

export function summarizeRow(row: ReadRow): RowSummary {
  const text = (key: string): string => str(row[key]) ?? "";
  let summary: string;
  switch (row.type) {
    case "decision":
      summary = `${text("what")} (why: ${text("why")})`;
      break;
    case "ruling":
      summary = `${text("what")} (why: ${text("why")}; cost if wrong: ${text("costIfWrong")})`;
      break;
    case "verdict":
      summary = `${text("result")} [${text("kind") || "review"}] at ${(row.head ?? "?").slice(0, 12)}${row.self === true ? ` (self${text("selfReason") === "no_session" ? ": no session" : ""})` : ""}${text("sessionSource") === "flag" ? ` (session ${row.actor.session ?? "?"} named by --session)` : ""}: ${text("how")}`;
      break;
    case "policy.judged": {
      const lifted = Array.isArray(row.lifted) ? row.lifted.map(String) : [];
      const requirements = Array.isArray(row.requirements) ? row.requirements.map(String) : [];
      summary = `judged by ${row.actor.session ?? "no session"}: ${requirements.length ? requirements.join(", ") : "no requirements"}${lifted.length ? `; lifted ${lifted.join(", ")} (why: ${text("why") || "none given"})` : ""}`;
      break;
    }
    case "handoff":
      summary = `next: ${text("next")}${text("note") ? ` (note: ${text("note")})` : ""}`;
      break;
    case "standing":
      summary = `${text("what")} (fanout ${text("fanout")})`;
      break;
    case "standing.cleared":
      summary = `cleared ${text("target") || "every standing order"} (fanout ${text("fanout")})`;
      break;
    case "skill.loaded":
      summary = `${text("skill")} (${text("via") || "tool"})${row.actor.session ? "" : " (no session)"}`;
      break;
    case "commit.recorded":
      summary = `${(row.head ?? "?").slice(0, 12)} ${text("subject")}${row.actor.session ? "" : " (no session)"}`;
      break;
    case "push.verified":
    case "push.noop":
      summary = `${text("remote")} ${(str(row.previous) ?? "(new)").slice(0, 12)} -> ${(row.head ?? "?").slice(0, 12)}${row.forced === true ? " (force-with-lease)" : ""}`;
      break;
    case "pr.created":
      summary = `#${row.pr ?? "?"} -> ${text("base")} at ${(row.head ?? "?").slice(0, 12)}${row.created === false ? " (existing)" : ""}`;
      break;
    case "pr.merged":
      summary = `#${row.pr ?? "?"} ${text("method")} at ${(row.head ?? "?").slice(0, 12)}${text("mergeSha") ? ` -> ${text("mergeSha").slice(0, 12)}` : ""}`;
      break;
    case "merge.unverified":
      summary = `#${row.pr ?? "?"} unverified merge requested at ${(row.head ?? "?").slice(0, 12)} (reason: ${text("reason")})`;
      break;
    case "delivery.verified":
      summary = `${text("expect")} delivered at ${(row.head ?? "?").slice(0, 12)}`;
      break;
    default:
      summary = text("what") || text("name") || row.type;
  }
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    type: row.type,
    branch: row.branch,
    summary,
    labels: rowLabels(row),
  };
}

export type StackPosition = {
  name: string;
  index: number;
  size: number;
  parent: string | null;
  pr: number | null;
};

/** The branch's place in a cached stack (`<store>/stacks/*.json`, S12), if any. */
export function stackPosition(root: string, branch: string): StackPosition | null {
  const dir = path.join(root, "stacks");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names.toSorted()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.branches)) continue;
    const branches = parsed.branches.filter(isRecord);
    const index = branches.findIndex((entry) => entry.branch === branch);
    if (index < 0) continue;
    const entry = branches[index];
    return {
      name: str(parsed.name) ?? name.replace(/\.json$/u, ""),
      index: index + 1,
      size: branches.length,
      parent: str(entry.parent),
      pr: typeof entry.pr === "number" ? entry.pr : null,
    };
  }
  return null;
}

export type CheckFreshness = { name: string; result: string | null; fresh: boolean; at: string };

type VerdictSummary = Omit<VerdictEntry, "verdict"> & { summary: string };

export type HandoffBrief = {
  store: { root: string; shared: boolean; ledger: string };
  branch: string | null;
  head: string | null;
  subject: string | null;
  base: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: { dirty: boolean; files: number; paths: string[] };
  pr: number | null;
  stack: StackPosition | null;
  verdict: {
    current: VerdictCheck["current"]["basis"];
    accepted: boolean;
    reasons: RejectReason[];
    verdicts: VerdictSummary[];
  };
  checks: CheckFreshness[];
  rulings: RowSummary[];
  recent: RowSummary[];
  lastHandoff: { at: string; note: string | null; next: string } | null;
  note: string | null;
  next: string;
  nextCommand: string;
  skippedRows: number;
};

const MAX_DIRTY_PATHS = 10;

const dirtyState = (cwd: string): HandoffBrief["dirty"] => {
  const run = gitRun(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    GIT_TIMEOUTS.worktree,
  );
  if (!run.ok) return { dirty: false, files: 0, paths: [] };
  const paths: string[] = [];
  const entries = run.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // Renames and copies carry the source path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return { dirty: paths.length > 0, files: paths.length, paths: paths.slice(0, MAX_DIRTY_PATHS) };
};

const nextCommandFor = (brief: Omit<HandoffBrief, "nextCommand" | "next">): string => {
  const branchFlag = brief.branch ? ` --branch ${brief.branch}` : "";
  const verify = `workit ledger verdict verified${branchFlag} --how "<method and evidence>"  (from a session that did not author the branch, with WORKIT_SESSION_ID set)`;
  if (!brief.head) return "make the first commit on this branch, then: workit handoff";
  if (brief.dirty.dirty)
    return `commit or stash the ${brief.dirty.files} changed file(s), then: workit handoff`;
  const stale = brief.checks.find((check) => !check.fresh);
  if (stale) return `workit check ${stale.name}`;
  const { verdict } = brief;
  if (verdict.reasons.includes("failing_verdict"))
    return `fix what the failing verdict found, then get a new independent verdict: ${verify}`;
  if (!verdict.accepted) return verify;
  return brief.pr === null ? "workit pr create" : `workit pr status --pr ${brief.pr}`;
};

/**
 * A compact resume brief for the checked-out branch: code state, dirty files,
 * stack position, verdict acceptance, check freshness, rulings, the newest
 * ledger rows, and one next command.
 */
export function buildHandoff(
  cwd: string,
  options: { last?: number; note?: string | null; next?: string | null } = {},
): LedgerResult<HandoffBrief> {
  const store = storeRoot(cwd);
  if (!store.ok) return store;
  const read = readLedger(cwd);
  if (!read.ok) return read;
  const ledger = read.value;
  const branch = currentBranch(cwd);
  const head = headSha(cwd);
  const base = defaultBase(cwd);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (base && head) {
    const counts = git(cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
    const [left, right] = (counts ?? "").split(/\s+/u).map(Number);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      behind = left;
      ahead = right;
    }
  }
  const mine = branch ? filterRows(ledger.rows, { branch }) : [];
  const stack = branch ? stackPosition(store.value.root, branch) : null;
  const pr =
    stack?.pr ??
    mine.findLast(
      (row) => row.pr !== undefined && PR_ROW_TYPES.has(row.type) && row.observer === "workit_cli",
    )?.pr ??
    null;
  const check = branch ? checkVerdicts(cwd, branch, ledger.rows) : null;
  const checkRows = mine.filter(
    (row) => row.type === "check" && row.observer === "workit_cli" && str(row.name),
  );
  const latestChecks = new Map<string, ReadRow>();
  for (const row of checkRows) latestChecks.set(str(row.name) as string, row);
  const tree = latestChecks.size ? (worktreeTree(cwd)?.key ?? null) : null;
  const checks: CheckFreshness[] = [...latestChecks.entries()].map(([name, row]) => ({
    name,
    result: str(row.result),
    fresh: tree !== null && row.tree === tree,
    at: row.at,
  }));
  const lastHandoffRow = mine.findLast((row) => row.type === "handoff");
  const partial: Omit<HandoffBrief, "nextCommand" | "next"> = {
    store: { root: store.value.root, shared: store.value.shared, ledger: ledger.path },
    branch,
    head,
    subject: head ? git(cwd, ["log", "-1", "--format=%s", head]) : null,
    base,
    ahead,
    behind,
    dirty: dirtyState(cwd),
    pr,
    stack,
    verdict: {
      current: check?.current.basis ?? "none",
      accepted: check?.accepted.accepted ?? false,
      reasons: check?.accepted.reasons ?? ["no_verdict"],
      verdicts: (check?.verdicts ?? []).map(({ verdict: row, ...rest }) => ({
        ...rest,
        summary: summarizeRow(row).summary,
      })),
    },
    checks,
    rulings: mine
      .filter((row) => row.type === "ruling" && !row.superseded)
      .slice(-5)
      .map(summarizeRow),
    recent: ledger.rows.slice(-(options.last ?? 10)).map(summarizeRow),
    lastHandoff: lastHandoffRow
      ? {
          at: lastHandoffRow.at,
          note: str(lastHandoffRow.note),
          next: str(lastHandoffRow.next) ?? "",
        }
      : null,
    note: options.note?.trim() || null,
    skippedRows: ledger.skipped,
  };
  const nextCommand = nextCommandFor(partial);
  return {
    ok: true,
    value: { ...partial, nextCommand, next: options.next?.trim() || nextCommand },
  };
}
