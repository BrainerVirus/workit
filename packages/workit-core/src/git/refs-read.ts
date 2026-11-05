// HEAD and branch tips read from the git files, without spawning git (#284 N6).
//
// Every read is fresh: HEAD and branch tips move during a workit call, and a
// stale HEAD would mis-key a SHA-keyed verdict, so nothing here is cached
// (decision mw3kbh1p). Each reader answers only the plain layouts it can be
// certain about, and returns null (ask git) otherwise:
//
// - an environment that changes where git looks (GIT_DIR, GIT_COMMON_DIR,
//   GIT_INDEX_FILE, GIT_NAMESPACE, object or replace overrides, ...);
// - reftable ref storage (`extensions.refStorage`, or a `reftable` dir);
// - a HEAD that is not a regular file (a symlink HEAD is a symref), a HEAD
//   symref outside refs/heads, a symbolic or non-regular branch ref;
// - a missing ref (unborn branch), a peeled packed entry, any line or name
//   it does not fully understand;
// - a tip it cannot prove is a commit (`^{commit}`): an object outside the
//   local loose objects and pack indexes, a delta in a pack, replace refs;
// - a short branch name another ref could shadow (`--short` would differ).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { gitDirs } from "./facts";

/** Environment that moves the repository, its refs or its objects away from the files read here. */
const REDIRECTING_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REF_PARANOIA",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];
// Command-line config (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT) is not here:
// git takes extensions only from the repository's own config, and the one
// config that changes what a ref names (core.useReplaceRefs) matters only
// with replace refs, which already send a read to git.

type Repo = { gitDir: string; commonDir: string; hexLength: 40 | 64 };

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The repository at `cwd` when its refs are plain files this module can read; null otherwise. */
const plainRepo = (cwd: string): Repo | null => {
  if (REDIRECTING_ENV.some((name) => process.env[name] !== undefined)) return null;
  const dirs = gitDirs(cwd);
  if (!dirs) return null;
  if (fs.existsSync(path.join(dirs.commonDir, "reftable"))) return null;
  const config = readText(path.join(dirs.commonDir, "config"));
  if (config === null) return null;
  if (/^\s*refstorage\s*=/imu.test(config) && !/^\s*refstorage\s*=\s*files\s*$/imu.test(config))
    return null;
  const format = /^\s*objectformat\s*=\s*(\S+)\s*$/imu.exec(config)?.[1]?.toLowerCase() ?? "sha1";
  if (format !== "sha1" && format !== "sha256") return null;
  return {
    gitDir: dirs.gitDir,
    commonDir: dirs.commonDir,
    hexLength: format === "sha256" ? 64 : 40,
  };
};

/** A branch name git accepts and this module can map to a file path (a conservative subset of check-ref-format). */
const plainBranchName = (name: string): boolean =>
  /^[A-Za-z0-9_][\w.+,=@-]*(?:\/[\w+,=@-][\w.+,=@-]*)*$/u.test(name) &&
  !/\.\.|@\{|\.lock(?:\/|$)|\.$|\.\//u.test(name) &&
  name !== "@" &&
  name !== "HEAD";

/** A loose ref file's content: an object id, a symref, or null for anything else. */
type LooseRef = { kind: "id"; id: string } | { kind: "symref"; target: string };

const parseRefFile = (text: string, hexLength: number): LooseRef | null => {
  const id = /^([0-9a-f]+)\n?$/u.exec(text);
  if (id) return id[1].length === hexLength ? { kind: "id", id: id[1] } : null;
  const symref = /^ref: (refs\/[^\s]+)\n?$/u.exec(text);
  return symref ? { kind: "symref", target: symref[1] } : null;
};

/** Larger packed-refs files are left to git, which binary-searches them instead of parsing every line. */
const MAX_PACKED_BYTES = 1024 * 1024;

/**
 * A regular file's content; undefined when nothing (or a missing parent) is
 * there; null for anything git might read differently (a symlink, a
 * directory) or a file over `maxBytes`.
 */
const regularFile = (file: string, maxBytes = Infinity): string | undefined | null => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? undefined : null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;
  return readText(file);
};

type Packed = Map<string, { id: string; peeled: boolean }>;

/** packed-refs by name; an empty map when there is none; null on any line it does not understand, or a large file. */
const readPacked = (repo: Repo): Packed | null => {
  const text = regularFile(path.join(repo.commonDir, "packed-refs"), MAX_PACKED_BYTES);
  if (text === undefined) return new Map();
  if (text === null || text.includes("\r")) return null;
  const refs: Packed = new Map();
  let last: string | null = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, entry] of lines.entries()) {
    if (index === 0 && entry.startsWith("# pack-refs with:")) continue;
    const peeled = /^\^([0-9a-f]+)$/u.exec(entry);
    if (peeled) {
      const ref = last === null ? undefined : refs.get(last);
      if (!ref || ref.peeled || peeled[1].length !== repo.hexLength) return null;
      ref.peeled = true;
      continue;
    }
    const line = /^([0-9a-f]+) (refs\/\S+)$/u.exec(entry);
    if (!line || line[1].length !== repo.hexLength || refs.has(line[2])) return null;
    refs.set(line[2], { id: line[1], peeled: false });
    last = line[2];
  }
  return refs;
};

/** Whether a ref exists in the files backend; null when unsure. */
const refExists = (repo: Repo, packed: Packed, ref: string): boolean | null => {
  for (const dir of new Set([repo.gitDir, repo.commonDir])) {
    try {
      fs.lstatSync(path.join(dir, ref));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
  }
  return packed.has(ref);
};

/** The object a branch names: loose ref first, then packed-refs, as git reads them; null when absent or unsure. */
const branchObject = (repo: Repo, branch: string, packed: () => Packed | null): string | null => {
  if (!plainBranchName(branch)) return null;
  const ref = `refs/heads/${branch}`;
  const loose = regularFile(path.join(repo.commonDir, ref));
  if (loose === null) return null;
  if (loose !== undefined) {
    const parsed = parseRefFile(loose, repo.hexLength);
    return parsed?.kind === "id" ? parsed.id : null;
  }
  const entry = packed()?.get(ref);
  return entry && !entry.peeled ? entry.id : null;
};

const readAt = (fd: number, length: number, position: number): Buffer | null => {
  const buffer = Buffer.alloc(length);
  return fs.readSync(fd, buffer, 0, length, position) === length ? buffer : null;
};

/**
 * The pack entry type of `id` from one `.idx` (version 2) and its pack: 1 is a
 * commit, 6 and 7 are deltas. Undefined when the index does not list the id.
 */
const packedType = (pack: string, id: string): number | undefined | null => {
  const want = Buffer.from(id, "hex");
  const idx = fs.openSync(`${pack}.idx`, "r");
  try {
    const header = readAt(idx, 8 + 256 * 4, 0);
    if (!header || header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2)
      return null;
    const count = header.readUInt32BE(8 + 255 * 4);
    let low = want[0] === 0 ? 0 : header.readUInt32BE(8 + (want[0] - 1) * 4);
    let high = header.readUInt32BE(8 + want[0] * 4);
    const names = 8 + 256 * 4;
    let found = -1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const name = readAt(idx, want.length, names + mid * want.length);
      if (!name) return null;
      const order = Buffer.compare(name, want);
      if (order === 0) {
        found = mid;
        break;
      }
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    if (found < 0) return undefined;
    const offsets = names + count * want.length + count * 4;
    const small = readAt(idx, 4, offsets + found * 4);
    if (!small) return null;
    let offset = small.readUInt32BE(0);
    if (offset & 0x80000000) {
      const large = readAt(idx, 8, offsets + count * 4 + (offset & 0x7fffffff) * 8);
      if (!large) return null;
      offset = Number(large.readBigUInt64BE(0));
    }
    const data = fs.openSync(`${pack}.pack`, "r");
    try {
      const entry = readAt(data, 1, offset);
      return entry ? (entry[0] >> 4) & 7 : null;
    } finally {
      fs.closeSync(data);
    }
  } finally {
    fs.closeSync(idx);
  }
};

/**
 * Whether `id` is a commit in the local object store: true only when proven
 * (a loose object's header, or a pack entry's type). Null when unsure:
 * missing here (alternates, a lazy fetch), a delta, replace refs.
 */
const isCommit = (repo: Repo, id: string, packed: Packed): boolean | null => {
  if (fs.existsSync(path.join(repo.commonDir, "refs", "replace"))) return null;
  for (const name of packed.keys()) if (name.startsWith("refs/replace/")) return null;
  const objects = path.join(repo.commonDir, "objects");
  try {
    const fd = fs.openSync(path.join(objects, id.slice(0, 2), id.slice(2)), "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(64);
      head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
    } finally {
      fs.closeSync(fd);
    }
    const header = zlib.inflateSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return header.toString("latin1").startsWith("commit ");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  try {
    const packDir = path.join(objects, "pack");
    for (const file of fs.readdirSync(packDir)) {
      if (!file.endsWith(".idx")) continue;
      const type = packedType(path.join(packDir, file.slice(0, -4)), id);
      if (type === undefined) continue;
      return type === 1 ? true : null;
    }
  } catch {}
  return null;
};

/** `id` when it is proven to be a commit, else null (ask git). */
const commitOrNull = (
  repo: Repo,
  id: string | null,
  packed: () => Packed | null,
): string | null => {
  if (!id) return null;
  const refs = packed();
  return refs && isCommit(repo, id, refs) === true ? id : null;
};

/** One read of packed-refs per call, and only when needed. */
const lazyPacked = (repo: Repo): (() => Packed | null) => {
  let value: Packed | null | undefined;
  return () => {
    if (value === undefined) value = readPacked(repo);
    return value;
  };
};

type Head = { kind: "detached"; id: string } | { kind: "branch"; branch: string };

const readHead = (repo: Repo): Head | null => {
  const text = regularFile(path.join(repo.gitDir, "HEAD"));
  if (!text) return null;
  const parsed = parseRefFile(text, repo.hexLength);
  if (!parsed) return null;
  if (parsed.kind === "id") return { kind: "detached", id: parsed.id };
  const branch = /^refs\/heads\/(.+)$/u.exec(parsed.target)?.[1];
  return branch && plainBranchName(branch) ? { kind: "branch", branch } : null;
};

/** The commit HEAD points at (`git rev-parse --verify HEAD^{commit}`), or null when git must answer. */
export function readHeadCommit(cwd: string): string | null {
  const repo = plainRepo(cwd);
  if (!repo) return null;
  const head = readHead(repo);
  if (!head) return null;
  const packed = lazyPacked(repo);
  const id = head.kind === "detached" ? head.id : branchObject(repo, head.branch, packed);
  return commitOrNull(repo, id, packed);
}

/** The commit `refs/heads/<branch>` points at (`git rev-parse --verify refs/heads/<branch>^{commit}`), or null when git must answer. */
export function readBranchCommit(cwd: string, branch: string): string | null {
  const repo = plainRepo(cwd);
  if (!repo) return null;
  const packed = lazyPacked(repo);
  return commitOrNull(repo, branchObject(repo, branch, packed), packed);
}

/**
 * `git symbolic-ref --short -q HEAD`: `{ branch }` with the short name (also
 * on an unborn branch), `{ branch: null }` on a detached HEAD, or null when
 * git must answer. The short name is the branch name only when no other ref
 * could claim it (git then prints a longer form): `<name>` at the top of the
 * git dir, `refs/<name>`, `refs/tags/<name>`, `refs/remotes/<name>` or
 * `refs/remotes/<name>/HEAD`.
 */
export function readHeadBranch(cwd: string): { branch: string | null } | null {
  const repo = plainRepo(cwd);
  if (!repo) return null;
  const head = readHead(repo);
  if (!head) return null;
  if (head.kind === "detached") return { branch: null };
  const packed = readPacked(repo);
  if (!packed) return null;
  const name = head.branch;
  for (const shadow of [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ])
    if (refExists(repo, packed, shadow) !== false) return null;
  return { branch: name };
}
