// Outside every git repository a folder's Workit store lives in the state dir,
// `<state>/folders/<slug>` (workit-paths.mjs folderStoreDir), never in the
// folder (#892). Older Workit kept it in `<folder>/.workit`; the first
// resolve moves it once, keeping the folder's own config (checks.json,
// risk-paths) and what a 2.x migration left for 2.x readers where they are.
import fs from "node:fs";
import path from "node:path";

/** What `<folder>/.workit` may hold that is the folder's own config, not state. */
const FOLDER_CONFIG = new Set(["checks.json", "risk-paths"]);

/** The note left in `<folder>/.workit` when some of it could not move. */
export const MOVED_POINTER = "MOVED-TO-STATE.txt";

/**
 * What a 2.x migration leaves in `<folder>/.workit` on purpose: recovery
 * copies (`workit gc --prune-recovery` reads them there), the 2.x index, and
 * `tasks/<id>.json` stubs 2.x readers fail closed on.
 */
const V2_LEFTOVERS = new Set(["recovery", "index.json"]);
const isV2TaskStub = (rel: string): boolean => /^tasks[/\\][^/\\]+\.json$/u.test(rel);

/** The 3.x marker `<folder>/.workit/workspace.json` older Workit wrote (2.x readers fail closed on it). */
const MARKER = "workspace.json";

/** Null when absent, else whether it is a 2.x workspace (not a 3.x marker). */
const v2Workspace = (workit: string): boolean | null => {
  let bytes: string;
  try {
    bytes = fs.readFileSync(path.join(workit, MARKER), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(bytes) as { store?: { format?: unknown } } | null;
    return value?.store?.format !== "workit-store";
  } catch {
    return true;
  }
};

/** A `.gitignore` older Workit generated (`*`, or `*` and `!risk-paths`). */
const generatedIgnore = (file: string): boolean => {
  try {
    return /^\*\n(!risk-paths\n)?$/u.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
};

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const isDir = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isDirectory();
  } catch {
    return false;
  }
};

const onlyStubs = (tasks: string): boolean => {
  try {
    return fs.readdirSync(tasks).every((entry) => isV2TaskStub(`tasks/${entry}`));
  } catch {
    return false;
  }
};

/**
 * The entries of `<folder>/.workit` that are state to move: everything but
 * the folder's own config, the pointer, the marker, a generated `.gitignore`
 * and 2.x leftovers. Empty when there is no such directory.
 */
export const strayEntries = (workit: string): string[] => {
  if (!isDir(workit)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(workit);
  } catch {
    return [];
  }
  return names.filter(
    (name) =>
      !FOLDER_CONFIG.has(name) &&
      !V2_LEFTOVERS.has(name) &&
      name !== MOVED_POINTER &&
      name !== MARKER &&
      !(name === ".gitignore" && generatedIgnore(path.join(workit, name))) &&
      // A tasks dir holding only 2.x stubs has nothing to move.
      !(name === "tasks" && onlyStubs(path.join(workit, name))),
  );
};

type FolderMigration = {
  from: string;
  to: string;
  /** Paths (relative to `.workit`) moved, each whole. */
  moved: string[];
  /** Paths (relative to `.workit`) left in place: the store already has one, or the move failed. */
  kept: string[];
};

/**
 * Move `from` into `to` without replacing anything there: a whole entry when
 * `to` is absent (a rename, else a copy then a removal), a merge when both are
 * directories. Returns the relative paths left behind; adds those moved to `moved`.
 */
const merge = (from: string, to: string, rel: string, moved: string[]): string[] => {
  if (isV2TaskStub(rel)) return [];
  if (!exists(to)) {
    try {
      fs.renameSync(from, to);
    } catch {
      try {
        fs.cpSync(from, to, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        });
        fs.rmSync(from, { recursive: true, force: true });
      } catch {
        // Another process may have moved it meanwhile.
        return exists(from) ? [rel] : [];
      }
    }
    moved.push(rel);
    return [];
  }
  if (!isDir(from) || !isDir(to)) return [rel];
  const kept = fs
    .readdirSync(from)
    .flatMap((name) => merge(path.join(from, name), path.join(to, name), `${rel}/${name}`, moved));
  try {
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  } catch {}
  return kept;
};

/**
 * Move a folder's old `<folder>/.workit` store into `target` once. Never
 * replaces an entry the target has; what stays gets a pointer file naming the
 * target. Null when there was nothing to move (the usual case, one lstat).
 */
export function migrateFolderStore(
  folder: string,
  target: string,
  note: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): FolderMigration | null {
  const workit = path.join(folder, ".workit");
  const names = strayEntries(workit);
  // A 2.x store migrates through the task store first (task-store.ts).
  if (names.length === 0 || v2Workspace(workit) === true) return null;
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return null;
  }
  const result: FolderMigration = { from: workit, to: target, moved: [], kept: [] };
  for (const name of names) {
    result.kept.push(
      ...merge(path.join(workit, name), path.join(target, name), name, result.moved),
    );
  }
  // The marker and a generated .gitignore go once only the folder's config is left.
  const left = (() => {
    try {
      return fs.readdirSync(workit);
    } catch {
      return [];
    }
  })();
  const v2Left = left.some(
    (name) => V2_LEFTOVERS.has(name) || (name === "tasks" && isDir(path.join(workit, name))),
  );
  if (!v2Left && result.kept.length === 0) {
    fs.rmSync(path.join(workit, MARKER), { force: true });
    if (generatedIgnore(path.join(workit, ".gitignore")))
      fs.rmSync(path.join(workit, ".gitignore"), { force: true });
  }
  const pointer = path.join(workit, MOVED_POINTER);
  let wrote = false;
  if (result.kept.length > 0) {
    const text = `Workit keeps this folder's state in ${target}.\nNot moved, because the store there already has them or the move failed: ${result.kept.join(", ")}.\nMerge them by hand (cp -Rn ${workit}/. ${target}/), then delete them here.\n`;
    try {
      if (!exists(pointer) || fs.readFileSync(pointer, "utf8") !== text) {
        fs.writeFileSync(pointer, text);
        wrote = true;
      }
    } catch {}
  } else {
    fs.rmSync(pointer, { force: true });
    try {
      if (fs.readdirSync(workit).length === 0) fs.rmdirSync(workit);
    } catch {}
  }
  if (result.moved.length > 0 || wrote)
    note(
      result.kept.length > 0
        ? `workit: moved ${workit} to ${target}; ${result.kept.length} path${result.kept.length === 1 ? "" : "s"} left in place, see ${pointer}`
        : `workit: moved ${workit} to ${target} (outside a git repository Workit keeps its state there)`,
    );
  return result;
}
