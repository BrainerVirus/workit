// The ytrack agent skill (youtrack-cli #16). ytrack 0.6.0 and newer installs,
// remembers and refreshes every copy itself (`ytrack skill install|list|sync`),
// so Workit never installs it: doctor reads `ytrack skill list --json`, and
// the copies an older Workit installed (recorded in ytrack-skill.json) are
// removed once ytrack's own ~/.agents/skills/ytrack is there, or by uninstall.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { issueTrackerOf } from "./vcs-config";
import { readWorkspacesResult } from "./workspaces";
import { type YtrackRun } from "./youtrack-ytrack";

export type SkillHost = "claude-code" | "codex" | "cursor" | "opencode" | "pi";

/** The skill's directory name and its frontmatter `name`. */
export const YTRACK_SKILL = "ytrack";

/** The fix for a ytrack too old for a command Workit reads. */
export const YTRACK_UPGRADE = "ytrack upgrade";

/** The first ytrack that keeps its own skill copies (`ytrack skill list`). */
export const YTRACK_SKILL_LIST_SINCE = "0.6.0";

/** Whether Workit uses YouTrack: youtrack.json exists, or a workspace tracks issues in YouTrack. */
export const youTrackInUse = (configDir: string, env: NodeJS.ProcessEnv): boolean => {
  if (existsSync(env.WORKIT_YOUTRACK_CONFIG ?? path.join(configDir, "youtrack.json"))) return true;
  return readWorkspacesResult(configDir).entries.some((entry) => {
    const raw = entry as Record<string, unknown>;
    return issueTrackerOf(raw.issues, raw.youtrack)?.provider === "youtrack";
  });
};

/** A SKILL.md's frontmatter `name` and `metadata.version`. */
export const parseSkillMeta = (text: string): { name: string | null; version: string | null } => {
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  if (lines[0] !== "---") return { name: null, version: null };
  const end = lines.indexOf("---", 1);
  const front = end > 0 ? lines.slice(1, end) : [];
  const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/u, "$2");
  let name: string | null = null;
  let version: string | null = null;
  let inMetadata = false;
  for (const line of front) {
    if (/^\S/u.test(line)) inMetadata = /^metadata:\s*$/u.test(line);
    const top = /^name:(.*)$/u.exec(line);
    if (top) name = unquote(top[1]);
    const nested = inMetadata ? /^\s+version:(.*)$/u.exec(line) : null;
    if (nested) version = unquote(nested[1]);
  }
  return { name, version };
};

/** The ytrack skill installed at `dir` (`<root>/ytrack`): its version, or null when absent or not ytrack's. */
export const installedSkillVersion = (dir: string): string | null => {
  try {
    const meta = parseSkillMeta(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    return meta.name === YTRACK_SKILL ? (meta.version ?? "") : null;
  } catch {
    return null;
  }
};

/** One copy of the skill ytrack keeps (`ytrack skill list --json`). */
export type YtrackSkillCopy = {
  /** The skills directory, e.g. ~/.claude/skills. */
  dir: string;
  /** The skill directory, `<dir>/ytrack`. */
  path: string;
  /** Its SKILL.md's metadata.version; empty when missing. */
  version: string;
  state: "current" | "stale" | "missing";
  /** ytrack rewrites it when a newer ytrack runs (a home copy); false for one in a repository. */
  managed: boolean;
};

export type YtrackSkillList =
  | { state: "missing" }
  | { state: "unsupported"; version: string | null }
  | { state: "listed"; copies: YtrackSkillCopy[] };

const isCopy = (row: unknown): row is YtrackSkillCopy => {
  const copy = row as YtrackSkillCopy;
  return (
    typeof row === "object" &&
    row !== null &&
    typeof copy.dir === "string" &&
    typeof copy.path === "string" &&
    typeof copy.version === "string" &&
    ["current", "stale", "missing"].includes(copy.state) &&
    typeof copy.managed === "boolean"
  );
};

/**
 * The skill copies the ytrack on PATH keeps: `ytrack skill list --json`, an
 * array. A ytrack before 0.6.0 has no `skill list` (or no `skill`): that is
 * `unsupported`, with the version `ytrack version` prints. Reads only.
 */
export function listYtrackSkill(run: YtrackRun): YtrackSkillList {
  const out = run(["skill", "list", "--json"]);
  if (out.missing) return { state: "missing" };
  let rows: unknown = null;
  try {
    rows = out.status === 0 ? JSON.parse(out.stdout) : null;
  } catch {
    rows = null;
  }
  if (Array.isArray(rows)) return { state: "listed", copies: rows.filter(isCopy) };
  const version = /ytrack version (\S+)/u.exec(run(["version"]).stdout)?.[1] ?? null;
  return { state: "unsupported", version };
}

/**
 * One skill install Workit made: uninstall removes the files it wrote under
 * `path` and only those. `files` lists them (relative, `/`-separated) as the
 * install left them; a record from before it was kept has none.
 */
export type YtrackSkillInstall = {
  host: SkillHost;
  path: string;
  version: string;
  files?: string[];
};

const recordFile = (stateDir: string): string => path.join(stateDir, "ytrack-skill.json");

/** The skill installs Workit recorded, one per host. */
export const readYtrackSkillRecord = (stateDir: string): YtrackSkillInstall[] => {
  try {
    const data = JSON.parse(readFileSync(recordFile(stateDir), "utf8")) as { installs?: unknown };
    return (Array.isArray(data.installs) ? data.installs : []).filter(
      (row): row is YtrackSkillInstall =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as YtrackSkillInstall).host === "string" &&
        typeof (row as YtrackSkillInstall).path === "string" &&
        typeof (row as YtrackSkillInstall).version === "string" &&
        ((row as YtrackSkillInstall).files === undefined ||
          (Array.isArray((row as YtrackSkillInstall).files) &&
            (row as YtrackSkillInstall).files!.every((file) => typeof file === "string"))),
    );
  } catch {
    return [];
  }
};

const writeRecord = (stateDir: string, installs: YtrackSkillInstall[]): void => {
  const file = recordFile(stateDir);
  if (installs.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ installs }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
};

const quoteArg = (value: string): string =>
  /^[\w./:@~+-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;

/** The command that installs the skill into the skills directory `dir` by hand. */
export const ytrackSkillCommand = (dir: string): string =>
  `ytrack skill install --dir ${quoteArg(dir)}`;

/** Forget every skill install Workit recorded (ytrack-skill.json goes). */
export const forgetYtrackSkillRecord = (stateDir: string): void => writeRecord(stateDir, []);

/** Every non-directory entry under `dir` (links not followed), relative and `/`-separated. */
const filesUnder = (dir: string, prefix = ""): string[] => {
  let entries;
  try {
    entries = readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(dir, rel) : [rel];
    })
    .toSorted();
};

/** Every directory under `dir` (links not followed), relative. */
const dirsUnder = (dir: string, prefix = ""): string[] => {
  let entries;
  try {
    entries = readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return [rel, ...dirsUnder(dir, rel)];
    });
};

/**
 * The files the ytrack skill install wrote: the record's list, or for a
 * record from before Workit kept one, the layout `ytrack skill install`
 * documents (SKILL.md and its references/ directory).
 */
const skillFiles = (install: YtrackSkillInstall): Set<string> =>
  new Set(
    install.files ?? [
      "SKILL.md",
      ...filesUnder(install.path).filter((file) => file.startsWith("references/")),
    ],
  );

/** What stays in a skill directory once the skill's own files go. */
const othersIn = (install: YtrackSkillInstall): string[] => {
  const ours = skillFiles(install);
  return filesUnder(install.path).filter((file) => !ours.has(file));
};

const isLink = (file: string): boolean => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

const realpathOrNull = (file: string): string | null => {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
};

/**
 * Why a recorded skill path is not the one Workit may delete, or null when it
 * is. The only allowed path is `<root>/ytrack` for the host's skills root,
 * spelled exactly so (no `..`, no other host's root), and no component from
 * `home` (or, for a root outside home, the root's parent) down to it may be a
 * symlink: its real path must be the anchor's real path plus the same
 * relative path.
 */
export function ytrackSkillPathRefusal(
  recorded: string,
  root: string,
  home: string,
): string | null {
  const expected = path.join(path.resolve(root), YTRACK_SKILL);
  if (recorded !== expected)
    return `${recorded} is not ${expected}, the only ytrack skill directory Workit installs for this host`;
  const inHome = path.relative(path.resolve(home), expected);
  const anchor =
    inHome && !inHome.startsWith("..") && !path.isAbsolute(inHome)
      ? path.resolve(home)
      : path.dirname(path.resolve(root));
  const realAnchor = realpathOrNull(anchor);
  if (realAnchor === null) return null; // nothing there to delete
  const lexical = path.join(realAnchor, path.relative(anchor, expected));
  // Walk down from the anchor: an existing component must be itself, not a link.
  let current = realAnchor;
  for (const part of path.relative(anchor, expected).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!existsSync(current) && !isLink(current)) return null;
    if (isLink(current) || realpathOrNull(current) !== current)
      return `${current} is a symlink: ${expected} does not resolve to ${lexical}`;
  }
  return null;
}

/** What uninstall does with one recorded skill directory, in the words preview and apply share. */
export type YtrackSkillRemoval =
  /** `kept`: files of someone else's stay, and so does the directory. */
  | { kind: "remove"; detail: string; kept: boolean }
  /** Nothing left to delete: only Workit's record of it goes. */
  | { kind: "absent"; detail: string }
  /** Not a path Workit may delete, or no longer the skill Workit installed: left as it is. */
  | { kind: "keep"; detail: string };

const YTRACK_SKILL_REMOVE = "remove the ytrack skill Workit installed";
const ytrackSkillKept = (dir: string, others: string[]) =>
  `remove the ytrack skill's files; ${dir} kept (holds ${others.join(", ")})`;
const YTRACK_SKILL_ABSENT = "ytrack skill already absent; Workit forgets its record of it";
const YTRACK_SKILL_NOT_OURS = "no longer holds the ytrack skill Workit installed; left untouched";

/** What `removeYtrackSkill` would do now with `install`; reads only. */
export function ytrackSkillRemoval(
  install: YtrackSkillInstall,
  expected: { root: string; home: string },
): YtrackSkillRemoval {
  const refusal = ytrackSkillPathRefusal(install.path, expected.root, expected.home);
  if (refusal) return { kind: "keep", detail: `ytrack skill left untouched: ${refusal}` };
  if (!existsSync(install.path) && !isLink(install.path))
    return { kind: "absent", detail: YTRACK_SKILL_ABSENT };
  if (isLink(install.path) || installedSkillVersion(install.path) === null)
    return { kind: "keep", detail: YTRACK_SKILL_NOT_OURS };
  const others = othersIn(install);
  return others.length > 0
    ? { kind: "remove", detail: ytrackSkillKept(install.path, others), kept: true }
    : { kind: "remove", detail: YTRACK_SKILL_REMOVE, kept: false };
}

/**
 * Remove one recorded skill directory: only `<root>/ytrack` for the host's
 * skills root (`ytrackSkillPathRefusal`), a real directory that still holds
 * the ytrack skill; never a symlink, another path or another skill. A kept
 * directory is skipped with the plan's wording, so running again never fails.
 */
export function removeYtrackSkill(
  install: YtrackSkillInstall,
  stateDir: string,
  expected: { root: string; home: string },
): { status: "removed" | "skipped" | "failed"; detail?: string } {
  const forget = () =>
    writeRecord(
      stateDir,
      readYtrackSkillRecord(stateDir).filter(
        (row) => !(row.host === install.host && row.path === install.path),
      ),
    );
  const removal = ytrackSkillRemoval(install, expected);
  if (removal.kind === "keep") return { status: "skipped", detail: removal.detail };
  if (removal.kind === "absent") {
    forget();
    return { status: "skipped", detail: removal.detail };
  }
  // Only the files the install wrote; then each directory left empty, deepest first.
  try {
    // Listed without following a link, so a linked subdirectory is never entered.
    const ours = skillFiles(install);
    for (const file of filesUnder(install.path))
      if (ours.has(file)) unlinkSync(path.join(install.path, ...file.split("/")));
    const dirs = [install.path];
    for (const file of dirsUnder(install.path)) dirs.push(path.join(install.path, file));
    for (const dir of dirs.toSorted((a, b) => b.length - a.length))
      if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  forget();
  return removal.kept ? { status: "removed", detail: removal.detail } : { status: "removed" };
}
