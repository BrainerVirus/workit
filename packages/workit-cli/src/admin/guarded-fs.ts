// The one way admin/** writes the filesystem (#859): every write, move and
// remove first asks core/account-home.ts testRunWriteRefusal, so under the
// test run marker nothing lands in the OS account home's host settings or
// Workit's own dirs, naming the file. Without the marker each call is the
// plain node:fs (or safe-write) one. test/workit-cli/real-home-admin-writes
// fails when an admin module writes through anything else.
import * as fs from "node:fs";
import path from "node:path";
import { testRunWriteRefusal } from "@workit-dev/core/src/core/account-home";
import * as safe from "@workit-dev/core/src/core/safe-write";

/** The account home the guard protects (test seam; undefined: the OS account record's). */
export const guardedHome: { value: string | null | undefined } = { value: undefined };

/** Why a test run must not write `file` under the account home, or null. */
export const writeRefusal = (file: string): string | null =>
  testRunWriteRefusal(file, guardedHome.value);

/** Throw when a test run must not write `file` under the account home. */
const refuseWrite = (file: fs.PathLike | number): void => {
  if (typeof file === "number") return;
  const reason = testRunWriteRefusal(String(file), guardedHome.value);
  if (reason) throw new Error(reason);
};

/**
 * Why a host CLI must not run against `home` in a test run (it writes the
 * host's plugin and settings dirs there), or null: `home` is the account's.
 */
export const hostCommandRefusal = (home: string, purpose: string): string | null =>
  testRunWriteRefusal(path.join(home, ".claude"), guardedHome.value) === null
    ? null
    : `refusing to run ${purpose} against ${home}: a test run (WORKIT_TEST_RUN) never writes the OS account's home (#859)`;

export const writeFileSync = (
  file: fs.PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options?: fs.WriteFileOptions,
): void => {
  if (typeof file !== "number") refuseWrite(file);
  fs.writeFileSync(file, data, options);
};

export const mkdirSync = (dir: fs.PathLike, options?: fs.MakeDirectoryOptions): void => {
  refuseWrite(dir);
  fs.mkdirSync(dir, options);
};

export const rmSync = (target: fs.PathLike, options?: fs.RmOptions): void => {
  refuseWrite(target);
  fs.rmSync(target, options);
};

export const rmdirSync = (target: fs.PathLike): void => {
  refuseWrite(target);
  fs.rmdirSync(target);
};

export const unlinkSync = (target: fs.PathLike): void => {
  refuseWrite(target);
  fs.unlinkSync(target);
};

export const renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
  refuseWrite(from);
  refuseWrite(to);
  fs.renameSync(from, to);
};

export const cpSync = (src: string, dest: string, options?: fs.CopySyncOptions): void => {
  refuseWrite(dest);
  fs.cpSync(src, dest, options);
};

export const copyFileSync = (src: fs.PathLike, dest: fs.PathLike, mode?: number): void => {
  refuseWrite(dest);
  fs.copyFileSync(src, dest, mode);
};

export const symlinkSync = (
  target: fs.PathLike,
  link: fs.PathLike,
  type?: fs.symlink.Type,
): void => {
  refuseWrite(link);
  fs.symlinkSync(target, link, type);
};

export const linkSync = (existing: fs.PathLike, link: fs.PathLike): void => {
  refuseWrite(link);
  fs.linkSync(existing, link);
};

export const chmodSync = (target: fs.PathLike, mode: fs.Mode): void => {
  refuseWrite(target);
  fs.chmodSync(target, mode);
};

export const mkdtempSync = (prefix: string): string => {
  refuseWrite(prefix);
  return fs.mkdtempSync(prefix);
};

export const writeFileAtomic = (file: string, content: string, mode?: number): void => {
  refuseWrite(file);
  safe.writeFileAtomic(file, content, mode);
};

export const writeFileExclusive: typeof safe.writeFileExclusive = (file, ...rest) => {
  refuseWrite(file);
  return safe.writeFileExclusive(file, ...rest);
};
