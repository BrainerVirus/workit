// The bench's tripwire (#822, decision 2 for #823): it detects and reports,
// and never writes, removes or renames anything outside its own dir
// (`<real home>/.cache/workit-bench-tripwire/`). Landlock (confine.ts) keeps
// a host from writing the real home; this sees what gets through anyway.
//
// - Watched: the whole config dir, and the state files that grant or pick
//   what runs (host-permissions.json and its backups, node.json). The runner
//   snapshots them into memory once per bench start, and writes a journal
//   (the user's recovery copy) to its own dir.
// - Reported the same way: approvals/, issued/, issued-tokens/ and verdicts/,
//   which live sessions change during a run.
// - Not watched: leases/, logs/, hook-runs/, live-sessions/, worktrees/ and
//   the other caches every session rewrites; none grants anything.
//
// Read safety: a root whose kind, link target or dev+ino changed is reported
// as `root replaced` and not walked; below a root everything is lstat'ed,
// never followed; bytes are read only through O_RDONLY|O_NOFOLLOW|O_NONBLOCK
// and an fstat that says regular file; files over 64 MB are compared by size;
// a created dir is reported, not descended; at most 50 created paths per root.
//
// The only writes in this file are to the tripwire dir: ensureBase, acquire,
// release, writeJournal and dropJournal (test/behavior/eval-tripwire.test.ts
// holds that by name).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "../../packages/workit-core/src/core/workit-paths.mjs";

/** State files that grant or pick what runs: watched like the config dir. */
const STATE_WATCHED = ["host-permissions.json", "host-permissions-backup", "node.json"];
/** State trees live sessions change during a run: a change is reported too. */
const STATE_REPORTED = ["approvals", "issued", "issued-tokens", "verdicts"];
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_CREATED = 50;

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

export type Guard = { watched: string[]; reported: string[] };

/** The real paths to watch: the default config and state dirs of `home`, and those `env` (the runner's) points at. */
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
    watched: [
      ...dirs("config"),
      ...state.flatMap((dir) => STATE_WATCHED.map((name) => path.join(dir, name))),
    ],
    reported: state.flatMap((dir) => STATE_REPORTED.map((name) => path.join(dir, name))),
  };
};

/** Where the journal and the holders live: outside every Workit dir, under the account's cache. */
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
    const run = spawnSync(PS, ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
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

// ---------------------------------------------------------------- the tripwire dir and the lock

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

// ---------------------------------------------------------------- reading without following

/** One path as it is: what lstat says, and for a regular file its bytes' sha. */
type State =
  | { type: "absent" }
  | {
      type: "file";
      mode: number;
      size: number;
      ino: number;
      nlink: number;
      mtimeMs: number;
      /** Null over 64 MB: compared by size only. */
      sha: string | null;
    }
  | { type: "dir"; mode: number }
  | { type: "link"; target: string }
  | { type: "fifo" | "socket" | "device" };

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const lstat = (file: string) => lstatSync(file, { throwIfNoEntry: false });
type Stat = NonNullable<ReturnType<typeof lstat>>;

/** A regular file's bytes, opened so no link is followed and no fifo blocks; null when it is not one. */
const readRegular = (file: string): Uint8Array | null => {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

const stateOf = (file: string, stat = lstat(file)): State => {
  if (!stat) return { type: "absent" };
  if (stat.isSymbolicLink()) return { type: "link", target: readlinkSync(file) };
  if (stat.isDirectory()) return { type: "dir", mode: stat.mode & 0o7777 };
  if (stat.isFIFO()) return { type: "fifo" };
  if (stat.isSocket()) return { type: "socket" };
  if (!stat.isFile()) return { type: "device" };
  const bytes = stat.size > MAX_HASH_BYTES ? null : readRegular(file);
  return {
    type: "file",
    mode: stat.mode & 0o7777,
    size: stat.size,
    ino: stat.ino,
    nlink: stat.nlink,
    mtimeMs: stat.mtimeMs,
    sha: bytes ? sha(bytes) : null,
  };
};

/** A root as it is: kind, link target, and the dev+ino of what it resolves to. */
type RootState = { kind: string; target?: string; dev?: number; ino?: number };

const rootStateOf = (root: string): RootState => {
  const stat = lstat(root);
  if (!stat) return { kind: "absent" };
  const resolved = statSync(root, { throwIfNoEntry: false });
  const id = resolved ? { dev: resolved.dev, ino: resolved.ino } : {};
  if (stat.isSymbolicLink()) return { kind: "link", target: readlinkSync(root), ...id };
  return { kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other", ...id };
};

const sameRoot = (a: RootState, b: RootState): boolean =>
  a.kind === b.kind && a.target === b.target && a.dev === b.dev && a.ino === b.ino;

/**
 * Every path below `root`, lstat'ed: a root that resolves to a dir is
 * entered, nothing below it is followed, and a dir is entered only when
 * `enter` says so (a created dir is reported, not descended).
 */
const walk = (
  root: string,
  visit: (file: string, stat: Stat) => void,
  enter: (dir: string) => boolean = () => true,
): void => {
  const go = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).toSorted();
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const stat = lstat(file);
      if (!stat) continue;
      visit(file, stat);
      if (stat.isDirectory() && enter(file)) go(file);
    }
  };
  const stat = lstat(root);
  if (!stat) return;
  visit(root, stat);
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() && enter(root)) go(root);
};

// ---------------------------------------------------------------- snapshot

/** The runner's in-memory snapshot, taken once per bench start. */
export type Snapshot = {
  guard: Guard;
  roots: Map<string, RootState>;
  entries: Map<string, State>;
  /** The bytes of each watched file, for the journal only. */
  bytes: Map<string, Uint8Array>;
  /** Journal blob paths, once the journal is written. */
  blobs: Map<string, string>;
  reported: Map<string, string>;
  digest: string;
  files: number;
};

type Described = { type: string; mode?: number; sha?: string | null; target?: string };

/** sha256 over the sorted (path, type, mode, sha256 or link target) of the watched set: 16 hex. */
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
      if (!stat.isFile()) return;
      const bytes = readRegular(file);
      now.set(file, bytes ? sha(bytes) : `size ${stat.size}`);
    });
  return now;
};

/** Snapshot the watched paths into memory. */
export const armSnapshot = (guard: Guard): Snapshot => {
  const roots = new Map(guard.watched.map((root) => [root, rootStateOf(root)] as const));
  const entries = new Map<string, State>();
  const bytes = new Map<string, Uint8Array>();
  for (const root of guard.watched)
    walk(root, (file, stat) => {
      const state = stateOf(file, stat);
      entries.set(file, state);
      if (state.type === "file" && state.sha !== null) {
        const read = readRegular(file);
        if (read) bytes.set(file, read);
      }
    });
  return {
    guard,
    roots,
    entries,
    bytes,
    blobs: new Map(),
    reported: hashReported(guard),
    digest: digestOf([...entries]),
    files: [...entries.values()].filter((entry) => entry.type !== "dir").length,
  };
};

// ---------------------------------------------------------------- findings

/** One changed path: what was there, what is there now, where the original is, and what to run. */
export type Finding = {
  path: string;
  was: string;
  now: string;
  blob: string | null;
  commands: string[];
};

const octal = (mode: number): string => (mode & 0o7777).toString(8);

const describe = (state: State, links = false): string => {
  switch (state.type) {
    case "absent":
      return "absent";
    case "dir":
      return `dir, mode ${octal(state.mode)}`;
    case "link":
      return `symlink to ${state.target}`;
    case "file":
      return [
        "file",
        ...(links ? [`${state.nlink} link${state.nlink === 1 ? "" : "s"}`] : []),
        `mode ${octal(state.mode)}`,
        `${state.size} B`,
        state.sha ? `sha ${state.sha.slice(0, 12)}` : "not hashed (over 64 MB)",
      ].join(", ");
    default:
      return state.type;
  }
};

const describeRoot = (root: RootState): string =>
  root.kind === "link"
    ? `symlink to ${root.target}`
    : `${root.kind}${root.ino === undefined ? "" : ` (dev ${root.dev}, inode ${root.ino})`}`;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const sameFile = (was: State, now: State): boolean => {
  if (was.type !== now.type) return false;
  if (was.type === "file" && now.type === "file")
    return (
      was.mode === now.mode &&
      was.nlink === now.nlink &&
      (was.sha !== null && now.sha !== null
        ? was.sha === now.sha
        : was.size === now.size && was.mtimeMs === now.mtimeMs)
    );
  if (was.type === "dir" && now.type === "dir") return was.mode === now.mode;
  if (was.type === "link" && now.type === "link") return was.target === now.target;
  return true;
};

/** The dir between `root` and `file` that is no longer a real dir, or null. */
const brokenParent = (root: string, file: string): string | null => {
  for (let dir = path.dirname(file); dir.length > root.length; dir = path.dirname(dir))
    if (!lstat(dir)?.isDirectory()) return dir;
  return null;
};

const commandsFor = (file: string, was: State, now: State, blob: string | null): string[] => {
  const look = [`ls -la ${quote(file)}`];
  if (was.type === "file") {
    const single = now.type === "absent" || (now.type === "file" && now.nlink === 1);
    if (!blob || !single) return look;
    if (now.type === "file" && now.sha === was.sha && now.size === was.size)
      return [`chmod ${octal(was.mode)} ${quote(file)}`];
    return [
      ...(now.type === "file" && !file.endsWith(".token")
        ? [`diff -u ${quote(blob)} ${quote(file)}`]
        : []),
      `rm -f -- ${quote(file)} && cp -- ${quote(blob)} ${quote(file)} && chmod ${octal(was.mode)} ${quote(file)}`,
    ];
  }
  if (was.type === "absent") {
    if ((now.type === "file" && now.nlink === 1) || now.type === "link" || now.type === "fifo")
      return [`rm -- ${quote(file)}`];
  }
  return look;
};

/**
 * Compare the watched paths with `entries` (and roots with `roots`). Read
 * only: nothing is written, removed, renamed or followed.
 */
const findingsFor = (
  watched: string[],
  roots: Map<string, RootState>,
  entries: Map<string, State>,
  blobs: Map<string, string>,
): Finding[] => {
  const findings: Finding[] = [];
  for (const root of watched) {
    const wasRoot = roots.get(root) ?? { kind: "absent" };
    const nowRoot = rootStateOf(root);
    if (!sameRoot(wasRoot, nowRoot)) {
      findings.push({
        path: root,
        was: describeRoot(wasRoot),
        now: `${describeRoot(nowRoot)} (root replaced: not walked)`,
        blob: null,
        commands: [`ls -la ${quote(root)}`],
      });
      continue;
    }
    const under = (file: string): boolean => file === root || file.startsWith(`${root}/`);
    const seen = new Set<string>();
    let created = 0;
    walk(
      root,
      (file, stat) => {
        seen.add(file);
        const was = entries.get(file);
        if (was) {
          // Fast path: a file whose stat did not move is not re-hashed.
          if (
            was.type === "file" &&
            stat.isFile() &&
            stat.size === was.size &&
            stat.mtimeMs === was.mtimeMs &&
            stat.ino === was.ino &&
            stat.nlink === was.nlink &&
            (stat.mode & 0o7777) === was.mode
          )
            return;
          const now = stateOf(file, stat);
          if (sameFile(was, now)) return;
          const blob = blobs.get(file) ?? null;
          findings.push({
            path: file,
            was: describe(was),
            now: describe(now, true),
            blob,
            commands: commandsFor(file, was, now, blob),
          });
          return;
        }
        created += 1;
        if (created > MAX_CREATED) return;
        const now = stateOf(file, stat);
        findings.push({
          path: file,
          was: "absent",
          now: `${describe(now, true)} (created)`,
          blob: null,
          commands: commandsFor(file, { type: "absent" }, now, null),
        });
      },
      (dir) => dir === root || entries.get(dir)?.type === "dir",
    );
    if (created > MAX_CREATED)
      findings.push({
        path: root,
        was: "",
        now: `${created - MAX_CREATED} more created paths under it, not listed`,
        blob: null,
        commands: [],
      });
    for (const [file, was] of entries) {
      if (!under(file) || seen.has(file)) continue;
      const broken = brokenParent(root, file);
      if (broken) {
        findings.push({
          path: file,
          was: describe(was),
          now: `not reachable: ${broken} is no longer a dir`,
          blob: blobs.get(file) ?? null,
          commands: [`ls -la ${quote(broken)}`],
        });
        continue;
      }
      const blob = blobs.get(file) ?? null;
      findings.push({
        path: file,
        was: describe(was),
        now: "absent",
        blob,
        commands: commandsFor(file, was, { type: "absent" }, blob),
      });
    }
  }
  return findings;
};

/** What a run changed outside its world. Nothing was put back. */
export type Trip = {
  findings: Finding[];
  /** Changed in a reported state tree. */
  reported: { added: string[]; changed: string[]; missing: string[] };
};

/** Compare with the in-memory snapshot. Read only; null when nothing changed. */
export const checkSnapshot = (snapshot: Snapshot): Trip | null => {
  const findings = findingsFor(
    snapshot.guard.watched,
    snapshot.roots,
    snapshot.entries,
    snapshot.blobs,
  );
  const now = hashReported(snapshot.guard);
  const reported = {
    added: [...now.keys()].filter((file) => !snapshot.reported.has(file)),
    changed: [...now]
      .filter(([file, hash]) => snapshot.reported.has(file) && snapshot.reported.get(file) !== hash)
      .map(([file]) => file),
    missing: [...snapshot.reported.keys()].filter((file) => !now.has(file)),
  };
  const count =
    findings.length + reported.added.length + reported.changed.length + reported.missing.length;
  return count === 0 ? null : { findings, reported };
};

/** The watch during a run: true when a watched path changed. Stat first, hash only on a stat change. */
export const watchedChanged = (snapshot: Snapshot): boolean =>
  findingsFor(snapshot.guard.watched, snapshot.roots, snapshot.entries, new Map()).length > 0;

/** Each finding as indented lines: path, was, now, the original's copy, and commands to run. */
export const findingLines = (findings: Finding[]): string[] =>
  findings.flatMap((finding) => [
    `  ${finding.path}`,
    ...(finding.was ? [`    was: ${finding.was}`] : []),
    `    now: ${finding.now}`,
    ...(finding.blob ? [`    original: ${finding.blob}`] : []),
    ...finding.commands.map((command) => `    $ ${command}`),
  ]);

export const tripDetail = (trip: Trip, transcript: string): string =>
  [
    trip.findings.length > 0
      ? `nothing was put back; the originals are in the journal: ${trip.findings
          .map((finding) => `${finding.path} (was ${finding.was || "-"}; now ${finding.now})`)
          .join("; ")}`
      : "",
    trip.reported.added.length > 0 ? `added ${trip.reported.added.join(", ")}` : "",
    trip.reported.changed.length > 0 ? `changed ${trip.reported.changed.join(", ")}` : "",
    trip.reported.missing.length > 0 ? `missing ${trip.reported.missing.join(", ")}` : "",
    `transcript ${transcript}`,
  ]
    .filter(Boolean)
    .join("; ");

// ---------------------------------------------------------------- journal (the user's recovery copy)

type Journal = {
  roots: Record<string, RootState>;
  entries: Record<string, State & { blob?: string }>;
};

const journalDir = (base: string): string => path.join(base, "journal");

/** Write the journal once at arm, blobs first and the manifest last; record each blob's path in the snapshot. */
export const writeJournal = (base: string, snapshot: Snapshot): void => {
  const dir = journalDir(base);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const entries: Journal["entries"] = {};
  let count = 0;
  for (const [file, entry] of snapshot.entries) {
    const bytes = snapshot.bytes.get(file);
    if (!bytes) {
      entries[file] = entry;
      continue;
    }
    count += 1;
    const blob = path.join(dir, "blobs", String(count));
    writeFileSync(blob, bytes, { mode: 0o600 });
    chmodSync(blob, 0o600);
    snapshot.blobs.set(file, blob);
    entries[file] = { ...entry, blob: String(count) };
  }
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ roots: Object.fromEntries(snapshot.roots), entries }), {
    mode: 0o600,
  });
  chmodSync(manifest, 0o600);
};

/** Delete the journal dir; nothing else. */
export const dropJournal = (base: string): void => {
  rmSync(journalDir(base), { recursive: true, force: true });
};

/** What a leftover journal says, compared against roots the runner recomputes, never the journal's own. */
export type Leftover = {
  /** The journal cannot be trusted as written: unreadable, a path outside the roots, a blob that does not match. */
  problems: string[];
  findings: Finding[];
  /** The journal's own digest: proves nothing unless it equals the line the stopped run printed. */
  digest: string | null;
};

const insideRoots = (roots: string[], file: string): boolean =>
  path.isAbsolute(file) &&
  roots.some((root) => {
    const rel = path.relative(root, path.normalize(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });

/** Null when no journal is left. Read only, like the live check. */
export const inspectJournal = (base: string, guard: Guard): Leftover | null => {
  const dir = journalDir(base);
  if (!lstat(dir)) return null;
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Journal;
    if (typeof journal.entries !== "object" || journal.entries === null) throw new Error("shape");
  } catch {
    return { problems: ["leftover unreadable"], findings: [], digest: null };
  }
  const problems: string[] = [];
  const entries = new Map<string, State>();
  const blobs = new Map<string, string>();
  for (const [file, { blob, ...entry }] of Object.entries(journal.entries)) {
    if (!insideRoots(guard.watched, file)) {
      problems.push(`outside the watched set: ${file}`);
      continue;
    }
    entries.set(file, entry);
    if (entry.type !== "file" || !blob) continue;
    const blobPath = path.join(dir, "blobs", String(blob));
    const bytes = readRegular(blobPath);
    if (bytes === null || sha(bytes) !== entry.sha) {
      problems.push(`blob does not match its sha: ${file}`);
      continue;
    }
    blobs.set(file, blobPath);
  }
  const roots = new Map(Object.entries(journal.roots ?? {}));
  const findings = findingsFor(guard.watched, roots, entries, blobs).map((finding) =>
    // An untrusted journal gets no command to run, only a look.
    problems.length > 0 ? { ...finding, commands: [`ls -la ${quote(finding.path)}`] } : finding,
  );
  return {
    problems,
    findings,
    digest: digestOf(Object.entries(journal.entries)),
  };
};
