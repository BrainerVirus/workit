// Can a tool call reach a guarded path (the state dir's `issued*` and
// `approvals` registries, a config dir)? The launchers' cheap test before the
// runtime loads (ruling hook-reach-2026-11-13): in a checkout with no task
// store, a write the registry guard (write-gate.ts) may deny goes to the
// runtime, and every other write is answered by the launcher. No verb list:
// it reads every word as a path. Where it and the gate could disagree, it
// says yes. The Codex launcher imports this module as its own chunk; the
// Claude Code launcher (bin/workit-hook.mjs) carries the region between the
// markers as plain JavaScript, held equal after type erasure by
// test/workit-core/hooks/write-reach.test.ts.
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, stateDir, userHome } from "../core/workit-paths.mjs";

/** The guarded dirs and what a shell expands, as the hook process sees them. */
export type ReachDirs = {
  state: string;
  configs: string[];
  home: string;
  env: Record<string, string | undefined>;
  fold: boolean;
};

/** The core/workit-paths.mjs builders the guarded dirs come from. */
type ReachPaths = {
  configDir: (env: NodeJS.ProcessEnv) => string;
  stateDir: (env: NodeJS.ProcessEnv) => string;
  userHome: (env: NodeJS.ProcessEnv) => string;
};

// write-reach:begin
/** `<git-common-dir>/workit` (or `<dir>/.workit` outside git) holds tasks. */
const hasTaskStore = (cwd: string): boolean => {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!target) return true;
          gitDir = path.resolve(dir, target);
          const common = path.join(gitDir, "commondir");
          if (existsSync(common))
            gitDir = path.resolve(gitDir, readFileSync(common, "utf8").trim());
        }
        const store = path.join(gitDir, "workit");
        return (
          existsSync(path.join(store, "tasks")) || existsSync(path.join(store, "task-index.json"))
        );
      }
      if (existsSync(path.join(dir, ".workit"))) return true;
      if (path.dirname(dir) === dir) return false;
    }
  } catch {
    return true;
  }
};

/** The guarded dirs' tests: `at` a guarded path or below it, `above` one (an ancestor). */
/** canon's answer for a symlink chain too long to follow: it may reach a guarded path. */
const LOST = "\0lost";

const reachTests = (dirs: ReachDirs) => {
  const fold = (value: string) => (dirs.fold ? value.toLowerCase() : value);
  // write-gate.ts canonical: the nearest existing ancestor's real path, then the
  // rest; a dangling symlink on the way is followed to the file a write creates,
  // a relative one from its directory's real path; past 40 links, LOST.
  const canon = (file: string): string => {
    let dir = path.resolve(file);
    let rest = "";
    for (let hops = 0; ;) {
      try {
        return fold(path.join(realpathSync.native(dir), rest));
      } catch {
        let link: string | null = null;
        try {
          const to = readlinkSync(dir);
          let from = path.dirname(dir);
          try {
            from = realpathSync.native(from);
          } catch {
            // A directory not made yet: as spelled.
          }
          link = path.resolve(from, to);
        } catch {
          // Not a symlink: the next ancestor.
        }
        if (link !== null) {
          if (++hops > 40) return LOST;
          dir = path.join(link, rest);
          rest = "";
        } else if (path.dirname(dir) === dir) return fold(path.resolve(file));
        else {
          rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
          dir = path.dirname(dir);
        }
      }
    }
  };
  const within = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const state = canon(dirs.state);
  const configs = dirs.configs.map(canon);
  const at = (file: string) =>
    file === LOST ||
    configs.some((dir) => within(dir, file)) ||
    (within(state, file) &&
      /^(?:issued[^\\/]*|approvals)(?:[\\/]|$)/.test(path.relative(state, file)));
  const above = (file: string) => within(file, state) || configs.some((dir) => within(file, dir));
  const linked = (file: string) => {
    try {
      const stat = statSync(file, { throwIfNoEntry: false });
      return Boolean(stat?.isFile() && stat.nlink > 1);
    } catch {
      return false;
    }
  };
  return { canon, at, above, linked };
};

/** Whether an edit of `file` may reach a guarded path: through a symlink, a hard link, or by name. */
const fileReaches = (file: string, cwd: string, dirs: ReachDirs): boolean => {
  const { canon, at, linked } = reachTests(dirs);
  const target = canon(path.resolve(cwd, file));
  return at(target) || linked(target);
};

/** Whether shell `text` run in `cwd` may write at or above a guarded path. */
const mayReachWith = (text: string, cwd: string, dirs: ReachDirs): boolean => {
  const { canon, at, above, linked } = reachTests(dirs);
  // a. The command runs at or above a guarded path.
  const here = canon(cwd);
  if (at(here) || above(here)) return true;
  // b. A guarded path the word split below cannot spell.
  const BREAKS = /[\s;&|()<>=:,]/;
  if ([dirs.state, ...dirs.configs].some((dir) => BREAKS.test(dir)) && /[/~]/.test(text))
    return true;
  // c. Spellings this test does not resolve.
  const joined = text.replace(/\\\r?\n/g, "");
  const bare = joined.replace(/['"\\]/g, "");
  if (
    /\$['"]/.test(joined) ||
    /~[\w+-]|\$\{(?:!|\w+[^\w}])|\bpopd\b/.test(bare) ||
    /(?:^|[\s;&|(])(?:cd|pushd|chdir)(?:\s+-\S*)*\s*(?:$|[;&|)\n$`])/.test(bare) ||
    (dirs.env.CDPATH !== undefined && /\b(?:cd|pushd)\b/.test(bare))
  )
    return true;
  // d. Every word as a path, from every directory a `cd` may reach.
  const bound = (name: string) =>
    new RegExp(`(?:^|[^\\w$])${name}=|\\bfor\\s+${name}\\b|\\bread\\b[^;&|\\n]*\\b${name}\\b`).test(
      bare,
    );
  const expanded = bare.replace(
    /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (all: string, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain ?? "";
      return /^(?:OLD)?PWD$/.test(name) || bound(name) ? all : (dirs.env[name] ?? "");
    },
  );
  const words = expanded.split(/[\s;&|()<>=:,]+/).filter(Boolean);
  if (words.length > 64) return true;
  const home = dirs.env.HOME || dirs.home;
  const literal = (word: string) => {
    const cut = word.split(/[$`*?[{]/)[0] ?? "";
    return cut === "~" || cut.startsWith("~/") ? home + cut.slice(1) : cut;
  };
  const bases = [path.resolve(cwd)];
  for (let index = 0; index < words.length; index++) {
    if (!/^(?:cd|pushd|chdir)$/.test(words[index] ?? "")) continue;
    let next = index + 1;
    while (words[next]?.startsWith("-")) next++;
    const target = literal(words[next] ?? "");
    bases.push(...bases.map((base) => path.resolve(base, target)));
    if (bases.length > 8) return true;
  }
  const globby = /[$`*?[{]/.test(expanded);
  const seen = new Set<string>();
  for (const word of words) {
    const forms = [word];
    if (word.startsWith("-"))
      for (let from = 1; from < word.length; from++) forms.push(word.slice(from));
    for (const form of forms)
      for (const base of bases) {
        const file = canon(path.resolve(base, literal(form)));
        if (seen.has(file)) continue;
        seen.add(file);
        if (at(file) || linked(file)) return true;
        if (globby && (above(file) || above(path.dirname(file)))) return true;
      }
  }
  return false;
};
/**
 * The guarded dirs for `env`: its state and config dirs, the default config
 * dir and the OS account's, each built by core/workit-paths.mjs (`paths`).
 */
const guardedDirs = (env: NodeJS.ProcessEnv, paths: ReachPaths): ReachDirs => {
  let account: string | null = null;
  try {
    account = os.userInfo().homedir;
  } catch {
    // No account record: the env's dirs only.
  }
  return {
    state: paths.stateDir(env),
    configs: [
      paths.configDir(env),
      paths.configDir({}),
      ...(account ? [paths.configDir({ HOME: account, USERPROFILE: account })] : []),
    ],
    home: paths.userHome(env),
    env,
    fold: process.platform === "darwin" || process.platform === "win32",
  };
};
// write-reach:end

/** The guarded dirs for this process's env (core/workit-paths.mjs builds each). */
export const reachDirs = (env: NodeJS.ProcessEnv = process.env): ReachDirs =>
  guardedDirs(env, { configDir, stateDir, userHome });

/** Whether shell `text` run in `cwd` may write at or above a guarded path (see the header). */
export const mayReach = (text: string, cwd: string): boolean =>
  mayReachWith(text, cwd, reachDirs());

/** Whether an edit of `file` may reach a guarded path. */
export const editReaches = (file: string, cwd: string): boolean =>
  fileReaches(file, cwd, reachDirs());

export { hasTaskStore };
