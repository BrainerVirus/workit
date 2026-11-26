// An absolute path glob expanded the way a POSIX shell does, segment by
// segment against the directories on disk: `*`, `?` and `[…]` (`[!…]`
// negated), never a leading dot unless the segment spells one. The hook
// guards read it for a path the shell would expand before the command runs.
import { readdirSync } from "node:fs";
import path from "node:path";

const GLOB = /[*?[]/u;

/**
 * One segment's pattern, or null when it is no glob the shell expands (`x[`). `dots` lets `*`
 * and `?` match a leading dot, as `find -name` and `-path` do.
 */
export const globPattern = (glob: string, dots = false): RegExp | null => {
  try {
    return new RegExp(
      `^${dots || glob.startsWith(".") ? "" : "(?!\\.)"}${glob
        .replace(/[.+^$(){}|\\]/gu, "\\$&")
        .replace(/\[!/gu, "[^")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
      "u",
    );
  } catch {
    return null;
  }
};

/** The paths `file` (absolute) expands to, at most `limit`; the path itself when nothing matches. */
export const expandGlob = (file: string, limit = 64): string[] => {
  if (!GLOB.test(file)) return [file];
  const { root } = path.parse(file);
  let found = [root];
  for (const part of file.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    if (!GLOB.test(part)) {
      found = found.map((dir) => path.join(dir, part));
      continue;
    }
    const pattern = globPattern(part);
    if (pattern === null) return [file];
    found = found
      .flatMap((dir) => {
        try {
          return readdirSync(dir)
            .filter((name) => pattern.test(name))
            .map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      })
      .slice(0, limit);
  }
  return found.length > 0 ? found : [file];
};
