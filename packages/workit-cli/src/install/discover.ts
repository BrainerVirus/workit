// Every `workit` a shell could run: each one on PATH (in PATH order, like
// `which -a`) and each copy in a version manager's npm global prefix (fnm,
// nvm, volta, mise, asdf), whether or not PATH sees it today. Versions come
// from the package.json on disk, never from running the binary.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { scanInstalledNodes } from "@brainervirus/workit-core/src/core/node-resolve.mjs";
import { isOwnedLauncher } from "./owned";
import { CLI_PACKAGE_NAME, ownedPaths, ownedVersion, packageVersion, realpathOr } from "./paths";

/**
 * owned: the Workit launcher; npm: a package in an npm global prefix; volta: a
 * volta-managed package; wrapper: a hand-written script; link: anything else
 * (a dev checkout link), reported but never removed.
 */
type InstallKind = "owned" | "npm" | "volta" | "wrapper" | "link";

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

/** The workit-cli package a hand-written wrapper runs, read from its text. */
const wrapperTarget = (file: string): string | null => {
  let text = "";
  try {
    text = readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return null;
  }
  const found = /([^\s'"=]*node_modules[\\/]@brainervirus[\\/]workit-cli)/.exec(text);
  return found ? found[1] : null;
};

const pathNames = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  if (platform !== "win32") return ["workit"];
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...exts.map((ext) => `workit${ext.toLowerCase()}`), "workit"];
};

/** Every `workit` on PATH, in order, duplicates of the same file dropped. */
export const pathWorkits = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const found: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
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
  if (real === owned.launcher || isOwnedLauncher(real))
    return {
      path: file,
      realpath: real,
      version: owned.version,
      kind: "owned",
      manager: null,
      prefix: null,
      packageDir: null,
    };
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
      };
  }
  let symlink = false;
  try {
    symlink = lstatSync(file).isSymbolicLink();
  } catch {
    symlink = false;
  }
  const target = symlink ? null : wrapperTarget(real);
  return {
    path: file,
    realpath: real,
    version: target ? packageVersion(target) : null,
    kind: symlink ? "link" : "wrapper",
    manager: null,
    prefix: null,
    packageDir: null,
  };
};

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
        ? "hand-written wrapper"
        : install.kind === "link"
          ? "link"
          : `${install.manager ?? "npm"} global prefix ${install.prefix}`;
  const pathPart = install.pathIndex === null ? "not on PATH" : `PATH #${install.pathIndex + 1}`;
  const real = install.realpath === install.path ? "" : ` -> ${install.realpath}`;
  return `${install.path}${real} (workit ${install.version ?? "unknown"}; ${where}; ${pathPart})`;
};
