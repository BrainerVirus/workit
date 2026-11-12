// The bench's tripwire (#822, decision for #823): a bench run must never
// change the real Workit config or state. Isolation (isolation.ts) keeps a run
// away from them; this catches what isolation cannot stop.
//
// - Restored: the whole config dir, and the state files that grant or pick
//   what runs (host-permissions.json and its backups, node.json). The runner
//   snapshots them into its own memory once per bench start; that snapshot is
//   the only thing ever restored automatically, in place (same inode, mode and
//   mtime; a symlink as a symlink), after the changed bytes are rescued.
// - Reported only: approvals/, issued/, issued-tokens/ and verdicts/. Live
//   sessions add and consume these; putting a consumed approval back would
//   re-arm it, so a change stops the bench and nothing is restored.
// - Not guarded: leases/, logs/, hook-runs/, live-sessions/, worktrees/ and
//   the other caches every session rewrites; none grants anything.
//
// The disk journal (journal/) is a crash report, never an authority: the same
// OS user can rewrite it. A later start only compares it and reports; it is
// restored only by `--tripwire-restore <digest>`, with paths confined to the
// roots the runner recomputes, every blob hashed and the digest equal to the
// line the stopped run printed on the user's terminal.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "../../packages/workit-core/src/core/workit-paths.mjs";

/** State files that grant or pick what runs: restored like the config dir. */
const STATE_RESTORED = ["host-permissions.json", "host-permissions-backup", "node.json"];
/** State trees live sessions change during a run: a change is reported, never restored. */
const STATE_REPORTED = ["approvals", "issued", "issued-tokens", "verdicts"];
const RESCUE_KEEP = 5;
const RESCUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const WORLD_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * The OS account's home from the account record (/etc/passwd), never $HOME:
 * under bun `os.userInfo()` follows $HOME, so it cannot tell the real home.
 */
export const accountHome = (): string => {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;
  try {
    for (const entry of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = entry.split(":");
      if (uid !== null && fields[2] === uid && fields[5]) return fields[5];
    }
  } catch {
    // No passwd file (Windows): fall back to the runtime's answer.
  }
  return os.userInfo().homedir;
};

export type Guard = { restored: string[]; reported: string[] };

/** The real paths to guard: the default config and state dirs of `home`, and those `env` (the runner's) points at. */
export const guardFor = (home: string, env?: NodeJS.ProcessEnv): Guard => {
  const dirs = (kind: "config" | "state") => [
    ...new Set(
      [workitDir(kind, { HOME: home }), ...(env ? [workitDir(kind, env)] : [])].map((dir) =>
        path.resolve(dir),
      ),
    ),
  ];
  const state = dirs("state");
  return {
    restored: [
      ...dirs("config"),
      ...state.flatMap((dir) => STATE_RESTORED.map((name) => path.join(dir, name))),
    ],
    reported: state.flatMap((dir) => STATE_REPORTED.map((name) => path.join(dir, name))),
  };
};

/** Where the journal, the holders and rescued bytes live: outside every Workit dir, under the account's cache. */
export const tripwireBase = (home: string): string =>
  path.join(home, ".cache", "workit-bench-tripwire");

// ---------------------------------------------------------------- identity

/** What `ps` is called: off Linux, a process start time comes from it. */
const PS = "ps";

/** A process's start time (/proc field 22, or `ps -o lstart=`), null when it is gone. */
export const startOf = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    if (process.platform === "linux") return null;
    const run = spawnSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const start = run.status === 0 ? run.stdout.trim().replaceAll(/\s+/gu, "_") : "";
    return start || null;
  }
};

/** This runner as `<pid>.<start>`: a name no later process can reuse. */
export const runnerIdentity = (): string => `${process.pid}.${startOf(process.pid) ?? "0"}`;

/** The identity names a process that is still the same process. */
export const identityAlive = (identity: string): boolean => {
  const cut = identity.indexOf(".");
  const pid = Number(identity.slice(0, cut));
  return Number.isInteger(pid) && pid > 0 && startOf(pid) === identity.slice(cut + 1);
};

// ---------------------------------------------------------------- the base dir and the lock

/** The base must be a real dir of this user: a symlink or someone else's dir could point the journal anywhere. */
export const ensureBase = (base: string): string | null => {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    return `${base} is not a directory this user owns`;
  chmodSync(base, 0o700);
  return null;
};

const holders = (base: string): string => path.join(base, "holders");

/**
 * Take the tripwire: one O_EXCL file per runner named by its identity. After
 * creating its own, a runner drops dead entries; any other live identity
 * means another bench holds it: own entry removed, that pid returned.
 */
export const acquire = (base: string): number | null => {
  const dir = holders(base);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mine = runnerIdentity();
  closeSync(openSync(path.join(dir, mine), "wx", 0o600));
  for (const name of readdirSync(dir)) {
    if (name === mine) continue;
    if (identityAlive(name)) {
      rmSync(path.join(dir, mine), { force: true });
      return Number(name.slice(0, name.indexOf(".")));
    }
    rmSync(path.join(dir, name), { force: true });
  }
  return null;
};

export const release = (base: string): void => {
  rmSync(path.join(holders(base), runnerIdentity()), { force: true });
};

// ---------------------------------------------------------------- snapshot

type Meta = { mode: number; atimeMs: number; mtimeMs: number; sha: string };
type Entry =
  | ({ type: "file"; bytes: Uint8Array; size: number; ino: number } & Meta)
  | { type: "link"; target: string }
  | { type: "dir"; mode: number };

/** The runner's in-memory snapshot: the only thing ever restored automatically. */
export type Snapshot = {
  guard: Guard;
  restored: Map<string, Entry>;
  reported: Map<string, string>;
  digest: string;
  files: number;
};

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const lstat = (file: string) => lstatSync(file, { throwIfNoEntry: false });
type Stat = NonNullable<ReturnType<typeof lstat>>;

/** Every entry under `root`; a root that is a symlink to a dir is followed, nothing below it is. */
const walk = (root: string, visit: (file: string, stat: Stat) => void): void => {
  const go = (file: string, follow: boolean): void => {
    const stat = lstat(file);
    if (!stat) return;
    visit(file, stat);
    const dir =
      stat.isDirectory() ||
      (follow &&
        stat.isSymbolicLink() &&
        statSync(file, { throwIfNoEntry: false })?.isDirectory() === true);
    if (!dir) return;
    for (const name of readdirSync(file).toSorted()) go(path.join(file, name), false);
  };
  go(root, true);
};

type Described = { type: string; mode?: number; sha?: string; target?: string };

/** sha256 over the sorted (path, type, mode, sha256 or link target) of the restored set: 16 hex. */
const digestOf = (entries: [string, Described][]): string => {
  const hash = createHash("sha256");
  for (const [file, entry] of entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    hash.update(
      `${file}\0${entry.type}\0${entry.mode ?? ""}\0${entry.sha ?? entry.target ?? ""}\n`,
    );
  return hash.digest("hex").slice(0, 16);
};

const hashReported = (guard: Guard): Map<string, string> => {
  const now = new Map<string, string>();
  for (const root of guard.reported)
    walk(root, (file, stat) => {
      if (stat.isFile()) now.set(file, sha(readFileSync(file)));
    });
  return now;
};

/** Snapshot the guarded paths into memory. */
export const armSnapshot = (guard: Guard): Snapshot => {
  const restored = new Map<string, Entry>();
  for (const root of guard.restored)
    walk(root, (file, stat) => {
      if (stat.isSymbolicLink()) restored.set(file, { type: "link", target: readlinkSync(file) });
      else if (stat.isDirectory()) restored.set(file, { type: "dir", mode: stat.mode & 0o7777 });
      else if (stat.isFile()) {
        const bytes = readFileSync(file);
        restored.set(file, {
          type: "file",
          bytes,
          size: stat.size,
          ino: stat.ino,
          mode: stat.mode & 0o7777,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          sha: sha(bytes),
        });
      }
    });
  return {
    guard,
    restored,
    reported: hashReported(guard),
    digest: digestOf([...restored]),
    files: [...restored.values()].filter((entry) => entry.type !== "dir").length,
  };
};

const differs = (entry: Described | undefined, file: string): boolean => {
  const stat = lstat(file);
  if (!entry || !stat) return entry !== undefined || stat !== undefined;
  if (entry.type === "link") return !stat.isSymbolicLink() || readlinkSync(file) !== entry.target;
  if (entry.type === "dir") return !stat.isDirectory() || (stat.mode & 0o7777) !== entry.mode;
  return (
    !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || sha(readFileSync(file)) !== entry.sha
  );
};

/** Every path under `roots` that differs from `entries`, created ones included. */
const changedUnder = (roots: string[], entries: Map<string, Described>): string[] => {
  const now: string[] = [];
  for (const root of roots) walk(root, (file) => now.push(file));
  return [...new Set([...entries.keys(), ...now])].filter((file) =>
    differs(entries.get(file), file),
  );
};

/**
 * The watch during a run: true when the restored set changed. It stats first
 * and hashes only an entry whose stat moved, so it is cheap every 2 s.
 */
export const restoredChanged = (snapshot: Snapshot): boolean => {
  let changed = false;
  const seen = new Set<string>();
  for (const root of snapshot.guard.restored)
    walk(root, (file, stat) => {
      seen.add(file);
      if (changed) return;
      const entry = snapshot.restored.get(file);
      if (entry?.type === "file" && stat.isFile()) {
        if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs && stat.ino === entry.ino)
          return;
      }
      changed = differs(entry, file);
    });
  return changed || [...snapshot.restored.keys()].some((file) => !seen.has(file));
};

/** What a run changed outside its world. */
export type Trip = {
  /** Put back to their snapshot (changed, deleted or created under a restored root). */
  restored: string[];
  /** Changed in a reported tree: left as they are. */
  reported: { added: string[]; changed: string[]; missing: string[] };
  /** Where the bytes the run left were saved before the restore, or null. */
  rescued: string | null;
};

const writeSecret = (file: string, bytes: Uint8Array | string): void => {
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
};

const rescueDir = (base: string): string =>
  path.join(base, "rescued", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);

const rescue = (into: string, file: string): void => {
  const stat = lstat(file);
  if (!stat || stat.isDirectory()) return;
  const copy = path.join(into, file);
  mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) writeSecret(`${copy}.symlink`, readlinkSync(file));
  else if (stat.isFile()) writeSecret(copy, readFileSync(file));
};

type Restorable =
  | ({ type: "file"; bytes: Uint8Array } & Meta)
  | { type: "link"; target: string }
  | { type: "dir"; mode: number };

const putBack = (file: string, entry: Restorable): void => {
  const stat = lstat(file);
  if (entry.type === "dir") {
    if (stat && !stat.isDirectory()) rmSync(file, { force: true });
    mkdirSync(file, { recursive: true });
    chmodSync(file, entry.mode);
    return;
  }
  if (entry.type === "link") {
    if (stat) rmSync(file, { recursive: true, force: true });
    symlinkSync(entry.target, file);
    return;
  }
  // In place, so the inode (and every hard link to it) gets the bytes back.
  if (stat && !stat.isFile()) rmSync(file, { recursive: true, force: true });
  const fd = openSync(file, "w", entry.mode);
  try {
    writeSync(fd, entry.bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, entry.mode);
  utimesSync(file, entry.atimeMs / 1000, entry.mtimeMs / 1000);
};

/** Rescue the current bytes of `changed`, remove created paths, put snapshot paths back. */
const settle = (
  base: string,
  changed: string[],
  entryOf: (file: string) => Restorable | undefined,
): string | null => {
  if (changed.length === 0) return null;
  const rescued = rescueDir(base);
  mkdirSync(rescued, { recursive: true, mode: 0o700 });
  for (const file of changed) rescue(rescued, file);
  // Created paths go deepest first; snapshot paths come back parents first.
  for (const file of changed
    .filter((each) => !entryOf(each))
    .toSorted((a, b) => b.length - a.length))
    rmSync(file, { recursive: true, force: true });
  for (const file of changed.toSorted((a, b) => a.length - b.length)) {
    const entry = entryOf(file);
    if (entry) putBack(file, entry);
  }
  return rescued;
};

/** Compare with the in-memory snapshot and put every restored path back. Null when nothing changed. */
export const checkSnapshot = (base: string, snapshot: Snapshot): Trip | null => {
  const changed = changedUnder(snapshot.guard.restored, snapshot.restored);
  const now = hashReported(snapshot.guard);
  const reported = {
    added: [...now.keys()].filter((file) => !snapshot.reported.has(file)),
    changed: [...now]
      .filter(([file, hash]) => snapshot.reported.has(file) && snapshot.reported.get(file) !== hash)
      .map(([file]) => file),
    missing: [...snapshot.reported.keys()].filter((file) => !now.has(file)),
  };
  // The bench stops on any trip, so the reported trees need no new baseline.
  const rescued = settle(base, changed, (file) => snapshot.restored.get(file));
  const count =
    changed.length + reported.added.length + reported.changed.length + reported.missing.length;
  return count === 0 ? null : { restored: changed, reported, rescued };
};

// ---------------------------------------------------------------- journal (a crash report)

type JournalEntry = Described & { blob?: string; atimeMs?: number; mtimeMs?: number };
type Journal = { entries: Record<string, JournalEntry> };

const journalDir = (base: string): string => path.join(base, "journal");

/** Write the journal once at arm: blobs first, the manifest last. */
export const writeJournal = (base: string, snapshot: Snapshot): void => {
  const dir = journalDir(base);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const entries: Journal["entries"] = {};
  let blobs = 0;
  for (const [file, entry] of snapshot.restored) {
    if (entry.type !== "file") {
      entries[file] = entry;
      continue;
    }
    blobs += 1;
    writeSecret(path.join(dir, "blobs", String(blobs)), entry.bytes);
    entries[file] = {
      type: "file",
      mode: entry.mode,
      sha: entry.sha,
      atimeMs: entry.atimeMs,
      mtimeMs: entry.mtimeMs,
      blob: String(blobs),
    };
  }
  writeSecret(path.join(dir, "manifest.json"), JSON.stringify({ entries }));
};

export const dropJournal = (base: string): void => {
  rmSync(journalDir(base), { recursive: true, force: true });
};

/** What a leftover journal says, checked against roots the runner recomputes, never the journal's own. */
export type Leftover = {
  /** The journal cannot be trusted as written: unreadable, a path outside the roots, a blob that does not match. */
  problems: string[];
  /** Real paths that differ from the journal (or are new under a root). */
  changed: string[];
  /** Ready-to-run `diff -u <blob> <real>` lines for changed non-token files. */
  diffs: string[];
  /** The journal's own digest: proves nothing unless it equals the line the stopped run printed. */
  digest: string | null;
};

const insideRoots = (roots: string[], file: string): boolean =>
  path.isAbsolute(file) &&
  roots.some((root) => {
    const rel = path.relative(root, path.normalize(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });

/** Null when no journal is left; never writes a real file. */
export const inspectJournal = (base: string, guard: Guard): Leftover | null => {
  const dir = journalDir(base);
  if (!lstat(dir)) return null;
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Journal;
    if (typeof journal.entries !== "object" || journal.entries === null) throw new Error("shape");
  } catch {
    return { problems: ["leftover unreadable"], changed: [], diffs: [], digest: null };
  }
  const problems: string[] = [];
  const entries = new Map(Object.entries(journal.entries));
  for (const [file, entry] of entries) {
    if (!insideRoots(guard.restored, file)) {
      problems.push(`outside the guarded set: ${file}`);
      continue;
    }
    if (entry.type !== "file") continue;
    const blob = path.join(dir, "blobs", String(entry.blob ?? ""));
    let bytes: Uint8Array | null = null;
    try {
      bytes = lstat(blob)?.isFile() ? readFileSync(blob) : null;
    } catch {
      bytes = null;
    }
    if (bytes === null || sha(bytes) !== entry.sha)
      problems.push(`blob does not match its sha: ${file}`);
  }
  const inside = new Map([...entries].filter(([file]) => insideRoots(guard.restored, file)));
  const changed = changedUnder(guard.restored, inside);
  const diffs = changed
    .filter((file) => !file.endsWith(".token") && inside.get(file)?.type === "file")
    .map((file) => `diff -u ${path.join(dir, "blobs", String(inside.get(file)?.blob))} ${file}`);
  return { problems, changed, diffs, digest: digestOf([...entries]) };
};

/**
 * `--tripwire-restore <digest>`: put the journal back only when its digest is
 * the one given, every path is inside the recomputed roots and every blob
 * matches. Returns the restored paths, or why it refused.
 */
export const restoreJournal = (
  base: string,
  guard: Guard,
  digest: string,
): { restored: string[]; rescued: string | null } | { refused: string } => {
  const left = inspectJournal(base, guard);
  if (!left) return { refused: "no leftover journal" };
  if (left.problems.length > 0) return { refused: left.problems.join("; ") };
  if (left.digest !== digest)
    return { refused: `the journal's digest ${left.digest} is not ${digest}` };
  const dir = journalDir(base);
  const journal = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Journal;
  const entryOf = (file: string): Restorable | undefined => {
    const entry = journal.entries[file];
    if (!entry) return undefined;
    if (entry.type === "link") return { type: "link", target: String(entry.target) };
    if (entry.type === "dir") return { type: "dir", mode: Number(entry.mode) };
    return {
      type: "file",
      bytes: readFileSync(path.join(dir, "blobs", String(entry.blob))),
      mode: Number(entry.mode),
      atimeMs: Number(entry.atimeMs),
      mtimeMs: Number(entry.mtimeMs),
      sha: String(entry.sha),
    };
  };
  const rescued = settle(base, left.changed, entryOf);
  dropJournal(base);
  return { restored: left.changed, rescued };
};

// ---------------------------------------------------------------- housekeeping

/** Keep the 5 newest rescue dirs, none older than 7 days. */
export const pruneRescued = (base: string, now = Date.now()): void => {
  const dir = path.join(base, "rescued");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const dated = names
    .map((name) => ({ name, mtime: lstat(path.join(dir, name))?.mtimeMs ?? 0 }))
    .toSorted((a, b) => b.mtime - a.mtime);
  for (const [index, { name, mtime }] of dated.entries())
    if (index >= RESCUE_KEEP || now - mtime > RESCUE_MAX_AGE_MS)
      rmSync(path.join(dir, name), { recursive: true, force: true });
};

/** The marker a world carries: the identity of the runner that made it. */
export const RUNNER_MARKER = ".runner";

/**
 * Remove bench worlds a dead runner left in the temp dir: real dirs this user
 * owns whose marker names a dead runner, or with no marker and older than 24 h.
 * A symlink is never followed.
 */
export const sweepWorlds = (tmp = os.tmpdir(), now = Date.now()): string[] => {
  const removed: string[] = [];
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith("workit-eval-")) continue;
    const dir = path.join(tmp, name);
    const stat = lstat(dir);
    if (!stat?.isDirectory() || (process.getuid && stat.uid !== process.getuid())) continue;
    let marker: string | null = null;
    try {
      marker = readFileSync(path.join(dir, RUNNER_MARKER), "utf8").trim();
    } catch {
      marker = null;
    }
    const dead = marker ? !identityAlive(marker) : now - stat.mtimeMs > WORLD_MAX_AGE_MS;
    if (!dead) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
};

export const tripDetail = (trip: Trip, transcript: string): string =>
  [
    trip.restored.length > 0 ? `restored ${trip.restored.join(", ")}` : "",
    trip.rescued
      ? `the bytes the run left are saved in ${trip.rescued} (delete it once read; it may hold token bytes)`
      : "",
    trip.reported.added.length > 0 ? `added (left in place) ${trip.reported.added.join(", ")}` : "",
    trip.reported.changed.length > 0
      ? `changed (left in place) ${trip.reported.changed.join(", ")}`
      : "",
    trip.reported.missing.length > 0
      ? `missing (not restored: a live session may have consumed them) ${trip.reported.missing.join(", ")}`
      : "",
    `transcript ${transcript}`,
  ]
    .filter(Boolean)
    .join("; ");
