// Whether two paths name the same place: symlinks resolve to their target
// (realpath, so /var/x and /private/var/x match on macOS), separators are
// read as `/`, and case is ignored on win32. A path that does not exist is
// compared as written (resolved against cwd).
import fs from "node:fs";
import path from "node:path";

const slashes = (text: string): string => text.replace(/\\/g, "/");

const canonical = (target: string): string => {
  try {
    return slashes(fs.realpathSync.native(target));
  } catch {
    return slashes(path.resolve(target));
  }
};

export const samePath = (a: string, b: string): boolean => {
  const left = canonical(a);
  const right = canonical(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
};
