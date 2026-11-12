#!/usr/bin/env bun
/**
 * Write and read confinement for a bench host (#822, decision 2 for #823):
 * Landlock, which needs no user namespace and no addon, through `bun:ffi`.
 *
 *   bun scripts/eval/confine.ts --rw <dir>… --file <file>… [--ro <dir>…] -- <cmd> <args…>
 *   bun scripts/eval/confine.ts --abi
 *
 * This process and everything it starts may write (write, truncate, create,
 * remove, rename, link, mknod) only under the `--rw` dirs, and only write or
 * truncate the `--file` files. With any `--ro`, reads (read, list, execute)
 * are confined too: to the `--ro` and `--rw` dirs and the `--file` files;
 * without one, reads stay unrestricted. Any failure (not
 * Linux, an arch without these syscall numbers, no glibc, Landlock ABI below
 * 3, a rule that cannot be added, restrict_self) exits 126 without running
 * the command.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** This launcher, for the runner to put in front of a host. */
const CONFINE = import.meta.path;

/** Landlock syscalls: the generic table, the same on x86_64 and arm64. */
const SYS = { create: 444n, add: 445n, restrict: 446n };
const PR_SET_NO_NEW_PRIVS = 38;
/** LANDLOCK_ACCESS_FS_*: write_file, remove_dir/file, make_char/dir/reg/sock/fifo/block/sym, refer, truncate. */
const WRITE_FILE = 1n << 1n;
/** LANDLOCK_ACCESS_FS_EXECUTE, READ_FILE, READ_DIR. */
const READS = (1n << 0n) | (1n << 2n) | (1n << 3n);
const READ_FILE = 1n << 2n;
const EXECUTE = 1n << 0n;
const TRUNCATE = 1n << 14n;
const DIR_WRITES = (() => {
  let all = WRITE_FILE | TRUNCATE | (1n << 13n);
  for (let bit = 4n; bit <= 12n; bit += 1n) all |= 1n << bit;
  return all;
})();

class Refused extends Error {}

type Libc = {
  syscall: (...args: bigint[]) => bigint | number;
  prctl: (option: number, ...args: bigint[]) => number;
};

const libc = async (): Promise<Libc> => {
  if (process.platform !== "linux") throw new Refused(`not Linux (${process.platform})`);
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Refused(`no Landlock syscall numbers for ${process.arch}`);
  const { dlopen } = await import("bun:ffi");
  try {
    return dlopen("libc.so.6", {
      syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" },
      prctl: { args: ["i32", "i64", "i64", "i64", "i64"], returns: "i32" },
    }).symbols;
  } catch {
    throw new Refused("no glibc (libc.so.6) to call Landlock through");
  }
};

const abiOf = (c: Libc): number => Number(c.syscall(SYS.create, 0n, 0n, 1n, 0n, 0n));

const confineSelf = async (rw: string[], files: string[], ro: string[]): Promise<number> => {
  const c = await libc();
  const abi = abiOf(c);
  if (abi < 3) throw new Refused(`Landlock ABI ${abi} (needs 3, kernel 6.2+)`);
  const { ptr } = await import("bun:ffi");
  const reads = ro.length > 0 ? READS : 0n;
  const attr = new BigUint64Array([DIR_WRITES | reads]);
  const ruleset = Number(c.syscall(SYS.create, BigInt(ptr(attr)), 8n, 0n, 0n, 0n));
  if (ruleset < 0) throw new Refused("landlock_create_ruleset failed");
  const allow = (target: string, access: bigint): void => {
    let fd: number;
    try {
      fd = openSync(target, "r");
    } catch (error) {
      throw new Refused(`cannot open ${target}: ${(error as Error).message}`);
    }
    try {
      const rule = new DataView(new ArrayBuffer(12));
      rule.setBigUint64(0, access, true);
      rule.setInt32(8, fd, true);
      const added = c.syscall(
        SYS.add,
        BigInt(ruleset),
        1n,
        BigInt(ptr(new Uint8Array(rule.buffer))),
        0n,
        0n,
      );
      if (Number(added) !== 0) throw new Refused(`landlock_add_rule ${target} failed`);
    } finally {
      closeSync(fd);
    }
  };
  for (const dir of rw) allow(dir, DIR_WRITES | reads);
  for (const file of files) allow(file, WRITE_FILE | TRUNCATE | (reads === 0n ? 0n : READ_FILE));
  // A read-only file (a host binary outside every readable dir) takes the file rights only.
  for (const dir of ro)
    allow(dir, statSync(dir, { throwIfNoEntry: false })?.isFile() ? READ_FILE | EXECUTE : READS);
  if (c.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0)
    throw new Refused("prctl(PR_SET_NO_NEW_PRIVS) failed");
  if (Number(c.syscall(SYS.restrict, BigInt(ruleset), 0n, 0n, 0n, 0n)) !== 0)
    throw new Refused("landlock_restrict_self failed");
  return abi;
};

const launch = async (argv: string[]): Promise<number> => {
  if (argv[0] === "--abi") {
    const abi = abiOf(await libc());
    if (abi < 3) throw new Refused(`Landlock ABI ${abi} (needs 3, kernel 6.2+)`);
    console.log(abi);
    return 0;
  }
  const split = argv.indexOf("--");
  if (split < 0 || split === argv.length - 1)
    throw new Refused("usage: --rw <dir>… --file <file>… [--ro <dir>…] -- <cmd> <args…>");
  const lists: Record<string, string[]> = { "--rw": [], "--file": [], "--ro": [] };
  for (let index = 0; index < split; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    const list = lists[flag];
    if (!list || value === undefined || index + 1 >= split)
      throw new Refused(`unknown argument ${flag}`);
    list.push(value);
  }
  await confineSelf(lists["--rw"] ?? [], lists["--file"] ?? [], lists["--ro"] ?? []);
  const [cmd = "", ...args] = argv.slice(split + 1);
  // Async, so the host's lifetime is bounded by the runner, which kills this whole group.
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", (error) => reject(new Refused(`cannot run ${cmd}: ${error.message}`)));
    child.on("close", (code, signal) =>
      resolve(code ?? 128 + (os.constants.signals[signal ?? "SIGKILL"] ?? 9)),
    );
  });
};

// ---------------------------------------------------------------- the runner's side

const insideOrEqual = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const real = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * The dirs a host may write: its world, `/dev` and the temp dirs, minus any
 * dir that holds the real home, a guarded root or the tripwire base
 * (Landlock has no deny rules, so such a dir would allow writes to them).
 */
export const writableDirs = (world: string | null, protectedPaths: string[]): string[] => {
  const guarded = protectedPaths.map(real);
  const candidates = [
    ...(world ? [world] : []),
    "/dev",
    ...[os.tmpdir(), "/tmp", "/var/tmp"].filter((dir) => existsSync(dir)),
  ];
  return [...new Set(candidates.map(real))].filter(
    (dir) => !guarded.some((each) => insideOrEqual(dir, each)),
  );
};

/** System dirs a host reads: binaries, libraries, certificates, /proc, /sys and the runtime dirs. */
const SYSTEM_READS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/proc",
  "/sys",
  "/run",
  "/snap",
  "/nix",
  "/var/lib",
  "/var/cache",
];

/** A binary as `PATH` finds it, symlinks resolved; null when it is not there. */
export const binaryOf = (binary: string, pathEnv: string): string | null => {
  const found = path.isAbsolute(binary)
    ? binary
    : pathEnv
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary))
        .find((file) => existsSync(file));
  return found ? real(found) : null;
};

/**
 * Where the symlinked packages of a `node_modules` dir resolve (a Workit
 * worktree links its packages to the main checkout's): read rules follow
 * the resolved path, not the link.
 */
export const linkedPackages = (dir: string): string[] => {
  const entries = (at: string): string[] => {
    try {
      return readdirSync(at).map((name) => path.join(at, name));
    } catch {
      return [];
    }
  };
  return entries(dir)
    .flatMap((entry) => (path.basename(entry).startsWith("@") ? entries(entry) : [entry]))
    .filter((entry) => lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() === true)
    .map(real);
};

/**
 * The checkouts or stores the symlinked packages of a `node_modules` dir live
 * in (a Workit worktree links its packages into the main checkout): for each
 * resolved package, the nearest dir above it that holds a `.git`, else the
 * dir its `node_modules` sits in, else its parent.
 */
export const linkedRoots = (dir: string): string[] => {
  const rootOf = (target: string): string => {
    for (let at = path.dirname(target); at !== path.dirname(at); at = path.dirname(at))
      if (existsSync(path.join(at, ".git"))) return at;
    const store = target.split(`${path.sep}node_modules${path.sep}`);
    return store.length > 1 ? (store[0] ?? target) : path.dirname(target);
  };
  return [...new Set(linkedPackages(dir).map(rootOf))];
};

/** The install dir of a binary on `PATH`: its resolved dir, or that dir's parent when it is a `bin`. */
export const toolchainDir = (binary: string, pathEnv: string): string | null => {
  const found = binaryOf(binary, pathEnv);
  if (!found) return null;
  const dir = path.dirname(found);
  return path.basename(dir) === "bin" ? path.dirname(dir) : dir;
};

/**
 * The dirs a host may read besides the ones it may write: the system dirs,
 * then `extra` (the Workit checkout, the toolchains), minus any dir that
 * holds a protected path (the real home, the real Workit dirs, the host
 * config dirs, the tripwire base): Landlock has no deny rule, so such a dir
 * would open them all.
 */
export const readableDirs = (extra: string[], protectedPaths: string[]): string[] => {
  const guarded = protectedPaths.map(real);
  return [
    ...new Set([...SYSTEM_READS, ...extra].filter((dir) => existsSync(dir)).map(real)),
  ].filter((dir) => !guarded.some((each) => insideOrEqual(dir, each)));
};

/** The launcher argv in front of `cmd`; `reads` (any) confines reads to them and the writable rules. */
export const confined = (
  dirs: string[],
  files: string[],
  cmd: string[],
  reads: string[] = [],
): string[] => [
  process.execPath,
  CONFINE,
  ...dirs.flatMap((dir) => ["--rw", dir]),
  ...files.flatMap((file) => ["--file", file]),
  ...reads.flatMap((dir) => ["--ro", dir]),
  "--",
  ...cmd,
];

export type Confinement =
  | { on: true; abi: number; reads: { on: true } | { on: false; reason: string } }
  | { on: false; reason: string };

/**
 * Once per bench start: confinement is on only if the launcher, with the
 * same rules a run gets (no world yet), cannot create a canary in the
 * tripwire base under the real home.
 */
export const checkConfinement = (
  base: string,
  identity: string,
  dirs: string[],
  files: string[],
  reads: { dirs: string[]; secret: string } | null = null,
): Confinement => {
  const abi = spawnSync(process.execPath, [CONFINE, "--abi"], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (abi.status !== 0)
    return {
      on: false,
      reason: abi.stderr.trim().replace(/^confine: /u, "") || "the launcher failed",
    };
  const canary = path.join(base, `canary.${identity}`);
  const run = spawnSync(
    process.execPath,
    confined(dirs, files, ["sh", "-c", ': > "$1"', "sh", canary]).slice(1),
    {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  if (existsSync(canary)) {
    rmSync(canary, { force: true });
    return { on: false, reason: "the canary was written: a writable dir holds the tripwire base" };
  }
  if (run.status === 0) return { on: false, reason: "the canary write did not fail" };
  if (run.status === 126)
    return { on: false, reason: run.stderr.trim().replace(/^confine: /u, "") };
  const on = { on: true as const, abi: Number(abi.stdout.trim()) };
  if (!reads) return { ...on, reads: { on: false, reason: "not asked" } };
  // Reads are confined only if, with the run's rules, the secret (the real home) cannot be listed.
  const list = spawnSync(
    process.execPath,
    confined(dirs, files, ["ls", "-a", reads.secret], reads.dirs).slice(1),
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  if (list.status === 126)
    return { ...on, reads: { on: false, reason: list.stderr.trim().replace(/^confine: /u, "") } };
  return list.status === 0
    ? { ...on, reads: { on: false, reason: "the real home could be listed" } }
    : { ...on, reads: { on: true } };
};

export const confinementLine = (confinement: Confinement): string =>
  confinement.on
    ? `write confinement: on (Landlock ABI ${confinement.abi})\nread confinement: ${confinement.reads.on ? "on" : `off (${confinement.reads.reason})`}`
    : `write confinement: off (${confinement.reason})\nread confinement: off (no Landlock)`;

if (import.meta.main) {
  let code: number;
  try {
    code = await launch(process.argv.slice(2));
  } catch (error) {
    console.error(`confine: ${error instanceof Refused ? error.message : String(error)}`);
    code = 126;
  }
  process.exit(code);
}
