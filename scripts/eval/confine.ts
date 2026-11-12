#!/usr/bin/env bun
/**
 * Write confinement for a bench host (#822, decision 2 for #823): Landlock,
 * which needs no user namespace and no addon, through `bun:ffi` syscalls.
 *
 *   bun scripts/eval/confine.ts --rw <dir>… --file <file>… -- <cmd> <args…>
 *   bun scripts/eval/confine.ts --abi
 *
 * This process and everything it starts may write (write, truncate, create,
 * remove, rename, link, mknod) only under the `--rw` dirs, and only write or
 * truncate the `--file` files; reads stay unrestricted. Any failure (not
 * Linux, an arch without these syscall numbers, no glibc, Landlock ABI below
 * 3, a rule that cannot be added, restrict_self) exits 126 without running
 * the command.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** This launcher, for the runner to put in front of a host. */
export const CONFINE = import.meta.path;

/** Landlock syscalls: the generic table, the same on x86_64 and arm64. */
const SYS = { create: 444n, add: 445n, restrict: 446n };
const PR_SET_NO_NEW_PRIVS = 38;
/** LANDLOCK_ACCESS_FS_*: write_file, remove_dir/file, make_char/dir/reg/sock/fifo/block/sym, refer, truncate. */
const WRITE_FILE = 1n << 1n;
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

const confineSelf = async (rw: string[], files: string[]): Promise<number> => {
  const c = await libc();
  const abi = abiOf(c);
  if (abi < 3) throw new Refused(`Landlock ABI ${abi} (needs 3, kernel 6.2+)`);
  const { ptr } = await import("bun:ffi");
  const attr = new BigUint64Array([DIR_WRITES]);
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
  for (const dir of rw) allow(dir, DIR_WRITES);
  for (const file of files) allow(file, WRITE_FILE | TRUNCATE);
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
    throw new Refused("usage: --rw <dir>… --file <file>… -- <cmd> <args…>");
  const rw: string[] = [];
  const files: string[] = [];
  for (let index = 0; index < split; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if ((flag !== "--rw" && flag !== "--file") || value === undefined || index + 1 >= split)
      throw new Refused(`unknown argument ${flag}`);
    (flag === "--rw" ? rw : files).push(value);
  }
  await confineSelf(rw, files);
  const [cmd = "", ...args] = argv.slice(split + 1);
  const run = spawnSync(cmd, args, { stdio: "inherit" });
  if (run.error) throw new Refused(`cannot run ${cmd}: ${run.error.message}`);
  return run.status ?? 128 + (os.constants.signals[run.signal ?? "SIGKILL"] ?? 9);
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

/** The launcher argv in front of `cmd`. */
export const confined = (dirs: string[], files: string[], cmd: string[]): string[] => [
  process.execPath,
  CONFINE,
  ...dirs.flatMap((dir) => ["--rw", dir]),
  ...files.flatMap((file) => ["--file", file]),
  "--",
  ...cmd,
];

export type Confinement = { on: true; abi: number } | { on: false; reason: string };

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
  return { on: true, abi: Number(abi.stdout.trim()) };
};

export const confinementLine = (confinement: Confinement): string =>
  confinement.on
    ? `write confinement: on (Landlock ABI ${confinement.abi})`
    : `write confinement: off (${confinement.reason})`;

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
