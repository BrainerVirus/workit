// Every `workit` a shell could run: each one on PATH (in PATH order, like
// `which -a`) and each copy in a version manager's npm global prefix (fnm,
// nvm, volta, mise, asdf), whether or not PATH sees it today. Versions come
// from the package.json on disk, never from running the binary.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { scanInstalledNodes } from "@brainervirus/workit-core/src/core/node-resolve.mjs";
import { isEphemeralCachePath } from "@brainervirus/workit-core/src/core/runtime-identity";
import { isOwnedLauncher } from "./owned";
import { CLI_PACKAGE_NAME, ownedPaths, ownedVersion, packageVersion, realpathOr } from "./paths";

/**
 * owned: the Workit launcher; npm: a package in an npm global prefix; volta: a
 * volta-managed package; wrapper: a hand-written script; host: a host plugin's
 * own launcher (the Claude Code plugin's bin/workit, #683), which its host
 * manages; link: anything else (a dev checkout link, a link into an npx
 * cache), reported but never removed.
 */
type InstallKind = "owned" | "npm" | "volta" | "wrapper" | "host" | "link";

export type FoundInstall = {
  /** The file PATH (or the prefix's bin) holds. */
  path: string;
  realpath: string;
  version: string | null;
  kind: InstallKind;
  /** fnm, nvm, volta, mise, asdf, or null for a prefix no version manager owns. */
  manager: string | null;
  /** The npm global prefix holding the package (npm kind). */
  prefix: string | null;
  packageDir: string | null;
  /** Position among the PATH matches (0 = what `workit` runs), or null when PATH misses it. */
  pathIndex: number | null;
  /** The `workit` a wrapper execs, as its text names it (it may be gone); null otherwise. */
  runs: string | null;
};

const PACKAGE_SEGMENTS = ["node_modules", ...CLI_PACKAGE_NAME.split("/")];

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const managerOf = (dir: string): string | null => {
  const lower = dir.toLowerCase().replaceAll("\\", "/");
  for (const name of ["fnm", "nvm", "volta", "mise", "asdf"])
    if (lower.includes(`/${name}/`) || lower.includes(`/.${name}/`)) return name;
  return null;
};

/** The global prefix and package dir a path inside `<prefix>/[lib/]node_modules/@brainervirus/workit-cli` belongs to. */
const npmPackageOf = (file: string): { prefix: string; packageDir: string } | null => {
  const parts = file.split(/[\\/]/);
  for (let index = parts.length - PACKAGE_SEGMENTS.length; index >= 0; index -= 1) {
    if (PACKAGE_SEGMENTS.every((segment, offset) => parts[index + offset] === segment)) {
      const packageDir = parts.slice(0, index + PACKAGE_SEGMENTS.length).join(path.sep) || path.sep;
      const base = parts.slice(0, index);
      const prefixParts = base.at(-1) === "lib" ? base.slice(0, -1) : base;
      return { prefix: prefixParts.join(path.sep) || path.sep, packageDir };
    }
  }
  return null;
};

/** The workit-cli package dir a file (after its links) belongs to, or null. */
export const npmPackageOfFile = (file: string): string | null =>
  npmPackageOf(realpathOr(file))?.packageDir ?? null;

/** Interpreters a wrapper may name before the script it runs. */
const RUNNERS = new Set(["node", "node.exe", "nodejs", "env"]);

/** The words of one shell or cmd command, quotes removed. */
const words = (command: string): string[] =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );

/** The script a command runs: past `exec`, `call`, VAR=value, `env` and a node with its flags. */
const commandTarget = (command: string): string | null => {
  const list = words(command.trim().replace(/^@/, ""));
  let at = 0;
  while (at < list.length) {
    const word = list[at];
    const name = path.basename(word.replaceAll("\\", "/")).toLowerCase();
    if (["exec", "call"].includes(word.toLowerCase()) || /^\w+=/.test(word)) at += 1;
    else if (RUNNERS.has(name)) {
      at += 1;
      while (list[at]?.startsWith("-")) at += 1;
    } else return word;
  }
  return null;
};

const isRegularFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * What a hand-written wrapper runs (W2.39): the script of its `exec` line,
 * else of the last command that runs one, never a path in a comment or an
 * argument. It counts only when that script is an existing file that resolves
 * to a real workit install: a file inside a workit-cli package (its
 * dist/index.js, or an npm bin linked to it) or the owned launcher. Anything
 * else makes the wrapper a foreign file, left alone and reported.
 */
const wrapperTarget = (
  file: string,
  env: NodeJS.ProcessEnv,
  ownedLauncher: string,
): { runs: string; packageDir: string | null; owned: boolean } | null => {
  let text = "";
  try {
    text = readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return null;
  }
  const home = env.HOME || env.USERPROFILE || "";
  const self = realpathOr(file);
  const commands = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:#|::|rem(?:\s|$))/i.test(line))
    .flatMap((line) => line.split(/&&|\|\||;|\|/));
  const execs = commands.filter((command) => /^exec\s/.test(command.trim()));
  for (const command of (execs.length ? execs : commands).toReversed()) {
    let target = commandTarget(command);
    if (!target) continue;
    if (home) target = target.replace(/^(?:\$\{HOME\}|\$HOME|~)(?=[\\/])/, home);
    if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) continue;
    if (!isRegularFile(target)) continue;
    const real = realpathOr(target);
    if (real === self) continue;
    if (real === ownedLauncher || isOwnedLauncher(real))
      return { runs: target, packageDir: null, owned: true };
    const npm = npmPackageOf(real);
    if (npm) return { runs: target, packageDir: npm.packageDir, owned: false };
  }
  return null;
};

const HOST_PLUGIN_PACKAGE = /^@brainervirus\/workit-(?:claude-code|codex|cursor|opencode|pi)$/;

/**
 * The host plugin package whose own `bin/workit` this is (#683: the Claude
 * Code plugin's launcher on the Bash tool's PATH), read from the plugin
 * root's package.json; null for anything else.
 */
export const hostLauncherOf = (
  file: string,
  platform: NodeJS.Platform = process.platform,
): { name: string; version: string | null } | null => {
  const names = platform === "win32" ? ["workit", "workit.cmd"] : ["workit"];
  if (!names.includes(path.basename(file).toLowerCase())) return null;
  const bin = path.dirname(file);
  if (path.basename(bin) !== "bin") return null;
  try {
    const found = JSON.parse(
      readFileSync(path.join(path.dirname(bin), "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    return typeof found.name === "string" && HOST_PLUGIN_PACKAGE.test(found.name)
      ? { name: found.name, version: typeof found.version === "string" ? found.version : null }
      : null;
  } catch {
    return null;
  }
};

const pathNames = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  if (platform !== "win32") return ["workit"];
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...exts.map((ext) => `workit${ext.toLowerCase()}`), "workit"];
};

/**
 * PATH as a login shell keeps it: absolute directories only (an empty entry,
 * `.` or a relative one would run a file from the current directory), without
 * the ones a package runner put there for one run (npx, pnpm dlx).
 */
export const persistentPath = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] =>
  (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(
      (dir) =>
        (platform === "win32" ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir)) &&
        !isEphemeralCachePath(`${dir}/`, env),
    );

/**
 * Every `workit` on PATH, in order, duplicates of the same file dropped. A
 * package runner's cache dir (`~/.npm/_npx/<hash>/node_modules/.bin` while
 * `npx … upgrade` runs) is skipped: no shell the person opens later has it.
 */
export const pathWorkits = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const dir of persistentPath(env, platform)) {
    for (const name of pathNames(env, platform)) {
      const file = path.join(dir, name);
      if (seen.has(file) || !isFile(file)) continue;
      seen.add(file);
      found.push(file);
    }
  }
  return found;
};

/** Each version manager's npm global prefix that holds a workit-cli package. */
const managerCopies = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): {
  prefix: string;
  packageDir: string;
  bin: string;
  manager: string | null;
  volta: boolean;
}[] => {
  const win = platform === "win32";
  const copies: ReturnType<typeof managerCopies> = [];
  for (const node of scanInstalledNodes(env, platform)) {
    const prefix = win ? path.dirname(node.path) : path.dirname(path.dirname(node.path));
    const packageDir = win
      ? path.join(prefix, ...PACKAGE_SEGMENTS)
      : path.join(prefix, "lib", ...PACKAGE_SEGMENTS);
    if (!existsSync(packageDir)) continue;
    copies.push({
      prefix,
      packageDir,
      bin: win ? path.join(prefix, "workit.cmd") : path.join(prefix, "bin", "workit"),
      manager: managerOf(node.source),
      volta: false,
    });
  }
  const home = env.HOME || env.USERPROFILE || "";
  const volta = env.VOLTA_HOME || (home ? path.join(home, ".volta") : "");
  if (volta) {
    const base = path.join(volta, "tools", "image", "packages", ...CLI_PACKAGE_NAME.split("/"));
    for (const packageDir of [
      path.join(base, "lib", ...PACKAGE_SEGMENTS),
      path.join(base, ...PACKAGE_SEGMENTS),
    ])
      if (existsSync(packageDir)) {
        copies.push({
          prefix: base,
          packageDir,
          bin: path.join(volta, "bin", win ? "workit.exe" : "workit"),
          manager: "volta",
          volta: true,
        });
        break;
      }
  }
  return copies;
};

const classify = (
  file: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  owned: { launcher: string; version: string | null },
): Omit<FoundInstall, "pathIndex"> => {
  const real = realpathOr(file);
  const base = { path: file, realpath: real, manager: null, prefix: null, packageDir: null };
  if (real === owned.launcher || isOwnedLauncher(real))
    return { ...base, version: owned.version, kind: "owned", runs: null };
  const host = hostLauncherOf(real, platform);
  if (host) return { ...base, version: host.version, kind: "host", runs: null };
  // A link into a package runner's cache: npm cannot uninstall it, and it breaks when the cache goes.
  if (isEphemeralCachePath(real, env)) return { ...base, version: null, kind: "link", runs: null };
  const npm = npmPackageOf(real);
  if (npm) {
    const manager = managerOf(npm.packageDir);
    return {
      path: file,
      realpath: real,
      version: packageVersion(npm.packageDir),
      kind: manager === "volta" && npm.prefix.includes("packages") ? "volta" : "npm",
      manager,
      ...npm,
      runs: null,
    };
  }
  // A volta shim, or a Windows npm .cmd shim: find the package beside it.
  if (managerOf(real) === "volta")
    for (const copy of managerCopies(env, platform))
      if (copy.volta)
        return {
          path: file,
          realpath: real,
          version: packageVersion(copy.packageDir),
          kind: "volta",
          manager: "volta",
          prefix: copy.prefix,
          packageDir: copy.packageDir,
          runs: null,
        };
  if (platform === "win32") {
    const packageDir = path.join(path.dirname(real), ...PACKAGE_SEGMENTS);
    if (existsSync(packageDir))
      return {
        path: file,
        realpath: real,
        version: packageVersion(packageDir),
        kind: "npm",
        manager: managerOf(packageDir),
        prefix: path.dirname(real),
        packageDir,
        runs: null,
      };
  }
  let symlink = false;
  try {
    symlink = lstatSync(file).isSymbolicLink();
  } catch {
    symlink = false;
  }
  const target = symlink ? null : wrapperTarget(real, env, owned.launcher);
  // A wrapper around the owned launcher is the owned launcher: never a copy to replace.
  if (target?.owned) return { ...base, version: owned.version, kind: "owned", runs: target.runs };
  return {
    ...base,
    version: target?.packageDir ? packageVersion(target.packageDir) : null,
    kind: symlink ? "link" : "wrapper",
    runs: target?.runs ?? null,
  };
};

/** True when `file` is a hand-written wrapper whose exec line runs the owned launcher. */
export const isOwnedWrapper = (
  file: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  wrapperTarget(file, env, realpathOr(ownedPaths(env, platform).launcher))?.owned === true;

/** Every workit install, PATH order first, then the copies PATH does not reach. */
export const listInstalls = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): FoundInstall[] => {
  const paths = ownedPaths(env, platform);
  const owned = { launcher: realpathOr(paths.launcher), version: ownedVersion(env, platform) };
  const found: FoundInstall[] = [];
  const keys = new Set<string>();
  const keyOf = (install: Omit<FoundInstall, "pathIndex">) =>
    install.packageDir ?? install.realpath;
  pathWorkits(env, platform).forEach((file, index) => {
    const install = classify(file, env, platform, owned);
    // The same package reached twice on PATH (a link and its target) is one install.
    if (keys.has(keyOf(install)) && install.kind !== "owned") return;
    keys.add(keyOf(install));
    found.push({ ...install, pathIndex: index });
  });
  for (const copy of managerCopies(env, platform)) {
    if (keys.has(copy.packageDir)) continue;
    keys.add(copy.packageDir);
    found.push({
      path: copy.bin,
      realpath: realpathOr(copy.bin),
      version: packageVersion(copy.packageDir),
      kind: copy.volta ? "volta" : "npm",
      manager: copy.manager,
      prefix: copy.prefix,
      packageDir: copy.packageDir,
      pathIndex: null,
      runs: null,
    });
  }
  return found;
};

/** One `which -a` style line per install. */
export const describeInstall = (install: FoundInstall): string => {
  const where =
    install.kind === "owned"
      ? "Workit-owned launcher"
      : install.kind === "wrapper"
        ? `hand-written wrapper${install.runs ? ` running ${install.runs}` : ""}`
        : install.kind === "host"
          ? "host plugin launcher, managed by its host"
          : install.kind === "link"
            ? "link"
            : `${install.manager ?? "npm"} global prefix ${install.prefix}`;
  const pathPart = install.pathIndex === null ? "not on PATH" : `PATH #${install.pathIndex + 1}`;
  const real = install.realpath === install.path ? "" : ` -> ${install.realpath}`;
  return `${install.path}${real} (workit ${install.version ?? "unknown"}; ${where}; ${pathPart})`;
};
