// The bench's tripwire (#822): a bench run must never change the real Workit
// config or state. Isolation (isolation.ts) keeps a run away from them; this
// catches what isolation cannot stop, such as a write to an absolute path.
//
// - Restored: the whole config dir, and the state files that grant or pick
//   what runs (host-permissions.json and its backups, node.json). Before each
//   run the runner snapshots them to disk; after it, every change is put back
//   in place (same inode, mode and mtime; a symlink as a symlink), after the
//   changed bytes are saved to a rescue dir, since the user or a live session
//   may have made the change.
// - Reported only: approvals/, issued/, issued-tokens/ and verdicts/. Live
//   sessions add and consume these during a run; putting a consumed approval
//   back would re-arm it, so a change fails the run and nothing is restored.
// - Not guarded: leases/, logs/, hook-runs/, live-sessions/, worktrees/ and
//   the other caches every live session rewrites; none grants anything.
//
// The snapshot lives on disk (0700 dir, 0600 files: tokens are in it) with a
// lock naming the runner's pid, so a crash leaves it for the next start to
// check, and two bench runs never restore each other's snapshot.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
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

/** Where the snapshot, the lock and rescued bytes live: outside every Workit dir, under the account's cache. */
export const tripwireBase = (home: string): string =>
  path.join(home, ".cache", "workit-bench-tripwire");

type Entry =
  | { type: "file"; mode: number; atimeMs: number; mtimeMs: number; sha: string; blob: string }
  | { type: "link"; target: string }
  | { type: "dir"; mode: number };
type Manifest = {
  guard: Guard;
  restored: Record<string, Entry>;
  reported: Record<string, string>;
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

const writeSecret = (file: string, bytes: Uint8Array | string): void => {
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
};

const snapshotDir = (base: string): string => path.join(base, "snapshot");

/** Snapshot the guarded paths to disk before a run. */
export const armTripwire = (base: string, guard: Guard): void => {
  const dir = snapshotDir(base);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const manifest: Manifest = { guard, restored: {}, reported: {} };
  let blobs = 0;
  for (const root of guard.restored)
    walk(root, (file, stat) => {
      if (stat.isSymbolicLink())
        manifest.restored[file] = { type: "link", target: readlinkSync(file) };
      else if (stat.isDirectory())
        manifest.restored[file] = { type: "dir", mode: stat.mode & 0o7777 };
      else if (stat.isFile()) {
        const bytes = readFileSync(file);
        blobs += 1;
        const blob = String(blobs);
        writeSecret(path.join(dir, "blobs", blob), bytes);
        manifest.restored[file] = {
          type: "file",
          mode: stat.mode & 0o7777,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          sha: sha(bytes),
          blob,
        };
      }
    });
  for (const root of guard.reported)
    walk(root, (file, stat) => {
      if (stat.isFile()) manifest.reported[file] = sha(readFileSync(file));
    });
  writeSecret(path.join(dir, "manifest.json"), JSON.stringify(manifest));
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

const differs = (entry: Entry | undefined, file: string): boolean => {
  const stat = lstat(file);
  if (!entry || !stat) return entry !== undefined || stat !== undefined;
  if (entry.type === "link") return !stat.isSymbolicLink() || readlinkSync(file) !== entry.target;
  if (entry.type === "dir") return !stat.isDirectory() || (stat.mode & 0o7777) !== entry.mode;
  return (
    !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || sha(readFileSync(file)) !== entry.sha
  );
};

const rescue = (into: string, file: string): void => {
  const stat = lstat(file);
  if (!stat || stat.isDirectory()) return;
  const copy = path.join(into, file);
  mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) writeSecret(`${copy}.symlink`, readlinkSync(file));
  else if (stat.isFile()) writeSecret(copy, readFileSync(file));
};

const putBack = (dir: string, file: string, entry: Entry): void => {
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
    writeSync(fd, readFileSync(path.join(dir, "blobs", entry.blob)));
  } finally {
    closeSync(fd);
  }
  chmodSync(file, entry.mode);
  utimesSync(file, entry.atimeMs / 1000, entry.mtimeMs / 1000);
};

const reportedChanges = (manifest: Manifest): Trip["reported"] => {
  const now = new Map<string, string>();
  for (const root of manifest.guard.reported)
    walk(root, (file, stat) => {
      if (stat.isFile()) now.set(file, sha(readFileSync(file)));
    });
  return {
    added: [...now.keys()].filter((file) => !(file in manifest.reported)),
    changed: [...now]
      .filter(([file, hash]) => file in manifest.reported && manifest.reported[file] !== hash)
      .map(([file]) => file),
    missing: Object.keys(manifest.reported).filter((file) => !now.has(file)),
  };
};

/**
 * Compare the guarded paths with the snapshot on disk, put every restored
 * path back (its current bytes saved first) and drop the snapshot. Null when
 * nothing changed or no snapshot is armed.
 */
export const checkTripwire = (base: string): Trip | null => {
  const dir = snapshotDir(base);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const now: string[] = [];
  for (const root of manifest.guard.restored) walk(root, (file) => now.push(file));
  const changed = [...new Set([...Object.keys(manifest.restored), ...now])].filter((file) =>
    differs(manifest.restored[file], file),
  );
  const reported = reportedChanges(manifest);
  let rescued: string | null = null;
  if (changed.length > 0) {
    rescued = path.join(base, "rescued", new Date().toISOString().replaceAll(":", "-"));
    mkdirSync(rescued, { recursive: true, mode: 0o700 });
    for (const file of changed) rescue(rescued, file);
    // Created paths go deepest first; snapshot paths come back parents first.
    for (const file of changed
      .filter((each) => !manifest.restored[each])
      .toSorted((a, b) => b.length - a.length))
      rmSync(file, { recursive: true, force: true });
    for (const file of changed.toSorted((a, b) => a.length - b.length)) {
      const entry = manifest.restored[file];
      if (entry) putBack(dir, file, entry);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  const count =
    changed.length + reported.added.length + reported.changed.length + reported.missing.length;
  return count === 0 ? null : { restored: changed, reported, rescued };
};

const lockFile = (base: string): string => path.join(base, "lock");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Take the tripwire for this process: null when taken, else the pid of the
 * live bench run that holds it. A dead holder's lock is taken over; its
 * snapshot, if any, is for `checkTripwire` to settle before any new run.
 */
export const acquire = (base: string): number | null => {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile(base), "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockFile(base), "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return holder;
      rmSync(lockFile(base), { force: true });
    }
  }
  return -1;
};

export const release = (base: string): void => {
  try {
    if (readFileSync(lockFile(base), "utf8").trim() === String(process.pid))
      rmSync(lockFile(base), { force: true });
  } catch {
    // Not held.
  }
};

/** A snapshot is still on disk: a run ended without its check (a crash or SIGKILL). */
export const leftover = (base: string): boolean =>
  existsSync(path.join(snapshotDir(base), "manifest.json"));

export const tripDetail = (trip: Trip, transcript: string): string =>
  [
    trip.restored.length > 0 ? `restored ${trip.restored.join(", ")}` : "",
    trip.rescued ? `the bytes the run left are saved in ${trip.rescued}` : "",
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
