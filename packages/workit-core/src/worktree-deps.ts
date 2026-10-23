// Dependencies for a fresh worktree (issue #310): a linked worktree has no
// node_modules, so a resolver walks up to whatever node_modules is above it
// (the main checkout's, for a worktree nested inside it) and a workspace
// package resolves to the main checkout's source: tests then run the wrong
// code. Instead of a package-manager install, the worktree gets its own
// node_modules that mirrors the main checkout's one level deep:
//
// - a symlink is copied as it is: a relative one (bun, npm and yarn link
//   workspace packages as `../../packages/<name>`, and `.bin` entries as
//   `../<pkg>/bin/x`) then resolves inside the worktree, which has the same
//   layout; an absolute one into the main checkout (a Windows junction) is
//   re-pointed at the worktree's counterpart;
// - `@scope` directories and `.bin` are mirrored the same way, one level;
// - anything else (a third-party package) is linked to the main checkout's,
//   so installed packages are shared, never copied.
//
// It runs only where the worktree has no node_modules of its own and git
// ignores node_modules there (else the links would show as changes and block
// release). `git worktree remove` unlinks the links and never follows them.
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
