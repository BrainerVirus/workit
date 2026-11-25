// Dependencies for a fresh worktree. A linked worktree has no node_modules,
// so a resolver walks up to whatever node_modules is above it (the main
// checkout's, for a worktree nested inside it) and a workspace package
// resolves to the main checkout's source: tests then run the wrong code
// (#310). Two ways to give it node_modules of its own:
//
// - installWorktreeDependencies (the default, #934): the frozen install of
//   the worktree's own lockfile by the package manager that lockfile belongs
//   to. A linked tree can drift from what the lockfile installs even when
//   both lockfiles are identical, and a test that reads installed packages
//   then fails only in slice worktrees.
// - linkWorktreeDependencies (`--deps link`, and the fallback when the
//   install cannot run): node_modules that mirror the main checkout's one
//   level deep. A symlink is copied as it is: a relative one (bun, npm and
//   yarn link workspace packages as `../../packages/<name>`, and `.bin`
//   entries as `../<pkg>/bin/x`) then resolves inside the worktree, which has
//   the same layout; an absolute one into the main checkout (a Windows
//   junction) is re-pointed at the worktree's counterpart. `@scope`
//   directories and `.bin` are mirrored the same way, one level. Anything
//   else (a third-party package) is linked to the main checkout's, so
//   installed packages are shared, never copied. It runs only where the
//   worktree has no node_modules of its own and git ignores node_modules
//   there (else the links would show as changes and block release).
//   `git worktree remove` unlinks the links and never follows them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitRun } from "./fanout";

const MODULES = "node_modules";
/** Directories searched for node_modules below the checkout root (packages/<name>). */
const MAX_DEPTH = 2;

export type LinkedDependencies = {
  /** The main checkout the links point at. */
  from: string;
  /** The node_modules directories made, relative to the worktree. */
  dirs: string[];
  /** Links made across them. */
  entries: number;
  ms: number;
};

const within = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** node_modules directories of the main checkout, as paths relative to it. */
function moduleDirs(main: string): string[] {
  const out: string[] = [];
  const walk = (relative: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(main, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(relative, entry.name);
      if (entry.name === MODULES) out.push(child);
      else if (depth < MAX_DEPTH && !entry.name.startsWith(".")) walk(child, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

function linkEntry(main: string, worktree: string, source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(source);
    // An absolute link into the main checkout (outside its node_modules) is a
    // workspace package: point it at the worktree's copy.
    const outside =
      path.isAbsolute(link) &&
      within(link, main) &&
      !path.relative(main, link).split(path.sep).includes(MODULES);
    const to = outside ? path.join(worktree, path.relative(main, link)) : link;
    fs.symlinkSync(to, target, process.platform === "win32" ? "junction" : undefined);
    return;
  }
  fs.symlinkSync(
    source,
    target,
    process.platform === "win32" ? (stat.isDirectory() ? "junction" : "file") : undefined,
  );
}

/** Mirror `source` into a new directory `target`; returns the links made. */
function mirror(main: string, worktree: string, source: string, target: string, top: boolean) {
  fs.mkdirSync(target);
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (top && entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin"))
      count += mirror(main, worktree, from, to, false);
    else {
      linkEntry(main, worktree, from, to);
      count += 1;
    }
  }
  return count;
}

/**
 * Give `worktree` node_modules that resolve its own workspace packages and
 * share the main checkout's installed ones. Null when there is nothing to
 * link (no node_modules in the main checkout), with a note when it was
 * skipped; never throws.
 */
export function linkWorktreeDependencies(
  main: string,
  worktree: string,
): { linked: LinkedDependencies | null; notes: string[] } {
  const started = performance.now();
  const notes: string[] = [];
  const dirs: string[] = [];
  let entries = 0;
  for (const relative of moduleDirs(main)) {
    const target = path.join(worktree, relative);
    if (!fs.existsSync(path.dirname(target)) || fs.existsSync(target)) continue;
    // The trailing slash: the directory does not exist yet, and `node_modules/` only matches one.
    if (!gitRun(worktree, ["check-ignore", "-q", `${relative.split(path.sep).join("/")}/`]).ok) {
      notes.push(
        `${relative.split(path.sep).join("/")} is not ignored by git, so it was not linked from ${main}; install dependencies in the worktree yourself`,
      );
      continue;
    }
    try {
      entries += mirror(main, worktree, path.join(main, relative), target, true);
      dirs.push(relative.split(path.sep).join("/"));
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      notes.push(
        `could not link ${relative} from ${main} (${(error as Error).message}); install dependencies in the worktree yourself`,
      );
    }
  }
  if (dirs.length === 0) return { linked: null, notes };
  const ms = Math.round(performance.now() - started);
  notes.push(
    `linked ${dirs.join(", ")} from ${main} (${entries} entries, ${ms} ms): workspace packages resolve to this worktree, installed packages are shared`,
  );
  return { linked: { from: main, dirs, entries, ms }, notes };
}

/** A lockfile's frozen install: the package manager and its arguments, run in the worktree. */
export type FrozenInstall = { lockfile: string; bin: string; args: string[] };

/** Lockfiles in the order a package manager is picked. */
export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
] as const;

/** Yarn 2+ (berry) writes `__metadata:` into yarn.lock and reads `.yarnrc.yml`; Yarn 1 neither. */
const yarnBerry = (dir: string): boolean => {
  if (fs.existsSync(path.join(dir, ".yarnrc.yml"))) return true;
  try {
    return fs.readFileSync(path.join(dir, "yarn.lock"), "utf8").includes("\n__metadata:");
  } catch {
    return false;
  }
};

/** The frozen install for `lockfile` in `dir`. */
export function frozenInstallFor(lockfile: string, dir: string): FrozenInstall {
  if (lockfile === "pnpm-lock.yaml")
    return { lockfile, bin: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (lockfile === "yarn.lock")
    return {
      lockfile,
      bin: "yarn",
      args: ["install", yarnBerry(dir) ? "--immutable" : "--frozen-lockfile"],
    };
  if (lockfile === "package-lock.json") return { lockfile, bin: "npm", args: ["ci"] };
  return { lockfile, bin: "bun", args: ["install", "--frozen-lockfile"] };
}

/** The frozen install `dir`'s first lockfile names, or null without one. */
export function frozenInstall(dir: string): FrozenInstall | null {
  const lockfile = LOCKFILES.find((name) => fs.existsSync(path.join(dir, name)));
  return lockfile ? frozenInstallFor(lockfile, dir) : null;
}

/** The same install as one command a person runs from anywhere. */
export function installCommand(install: FrozenInstall, dir: string): string {
  const where =
    install.bin === "pnpm"
      ? ["--dir", dir]
      : install.bin === "npm"
        ? ["--prefix", dir]
        : ["--cwd", dir];
  return [install.bin, ...install.args, ...where].join(" ");
}

/** `bin` on the PATH of `env` (PATHEXT-aware on Windows), or null. */
function onPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const windows = process.platform === "win32";
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const exts = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (env[key] ?? "").split(path.delimiter).filter(Boolean))
    for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not here.
      }
    }
  return null;
}

/** The last non-empty line of the install log, for the reason a failure gives. */
function lastLine(log: string): string {
  try {
    const lines = fs.readFileSync(log, "utf8").split(/\r?\n/u);
    return (
      lines
        .findLast((line) => line.trim() !== "")
        ?.trim()
        .slice(0, 300) ?? ""
    );
  } catch {
    return "";
  }
}

export type InstallResult = { ok: true; ms: number } | { ok: false; reason: string; ms: number };

/**
 * Run `install` in `worktree` with the PATH and environment of `env`, its
 * output in `log`, killed after `timeoutMs`. On failure the node_modules
 * directories it made are removed again, so a fallback starts clean. Never
 * throws.
 */
export function installWorktreeDependencies(
  worktree: string,
  install: FrozenInstall,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; log: string },
): InstallResult {
  const shown = [install.bin, ...install.args].join(" ");
  const bin = onPath(install.bin, options.env);
  if (!bin) return { ok: false, reason: `${install.bin} is not on PATH`, ms: 0 };
  const before = new Set(moduleDirs(worktree));
  const started = performance.now();
  let out: number;
  try {
    fs.mkdirSync(path.dirname(options.log), { recursive: true });
    out = fs.openSync(options.log, "w");
  } catch (error) {
    return { ok: false, reason: `cannot write ${options.log}: ${(error as Error).message}`, ms: 0 };
  }
  // A Windows .cmd shim (npm, pnpm, yarn) runs only through cmd.exe; the
  // arguments are fixed words and the worktree goes in as cwd, never the line.
  const shim = /\.(?:cmd|bat)$/iu.test(bin);
  let ran: ReturnType<typeof spawnSync>;
  try {
    ran = spawnSync(shim ? `"${bin}"` : bin, install.args, {
      cwd: worktree,
      env: options.env,
      stdio: ["ignore", out, out],
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      shell: shim,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(out);
  }
  const ms = Math.round(performance.now() - started);
  const code = ran.error?.code;
  const reason =
    code === "ETIMEDOUT"
      ? `${shown} timed out after ${Math.round(options.timeoutMs / 1000)} s`
      : ran.error
        ? `${shown} did not start: ${ran.error.message}`
        : ran.status !== 0
          ? `${shown} exited ${ran.status ?? ran.signal}${lastLine(options.log) ? `: ${lastLine(options.log)}` : ""}`
          : null;
  if (reason === null) return { ok: true, ms };
  for (const relative of moduleDirs(worktree))
    if (!before.has(relative))
      fs.rmSync(path.join(worktree, relative), { recursive: true, force: true });
  return { ok: false, reason, ms };
}

/**
 * Where `worktree`'s node_modules links point when installed packages are
 * shared from another checkout (linkWorktreeDependencies made them): that
 * checkout's root, else null (an own install, or no node_modules). A link
 * inside the worktree (a workspace package, bun's isolated store) is not one.
 */
export function linkedFrom(worktree: string): string | null {
  const root = path.join(worktree, MODULES);
  const outside = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth === 0 && entry.name.startsWith("@")) {
        const found = outside(file, 1);
        if (found) return found;
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      let target: string;
      try {
        target = path.resolve(dir, fs.readlinkSync(file));
      } catch {
        continue;
      }
      if (within(target, worktree)) continue;
      const parts = target.split(path.sep);
      const at = parts.lastIndexOf(MODULES);
      return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : path.dirname(target);
    }
    return null;
  };
  return outside(root, 0);
}
