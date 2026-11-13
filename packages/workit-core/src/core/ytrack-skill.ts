// The ytrack agent skill (youtrack-cli #16): ytrack ships a skill stamped
// with its own version (`ytrack skill print`, `ytrack skill install --dir`).
// Workit runs that install into each agent host's native user skills
// directory and records what it installed, so uninstall removes exactly
// those directories. Workit never copies the skill's text.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { issueTrackerOf } from "./vcs-config";
import { readWorkspacesResult } from "./workspaces";
import { ytrackDetail, type YtrackRun } from "./youtrack-ytrack";

export type SkillHost = "claude-code" | "codex" | "cursor" | "opencode" | "pi";

/** The skill's directory name and its frontmatter `name`. */
export const YTRACK_SKILL = "ytrack";

/** The ytrack that adds `ytrack skill`; an older one needs this. */
export const YTRACK_UPGRADE = "ytrack upgrade";

/** Whether Workit uses YouTrack: youtrack.json exists, or a workspace tracks issues in YouTrack. */
export const youTrackInUse = (configDir: string, env: NodeJS.ProcessEnv): boolean => {
  if (existsSync(env.WORKIT_YOUTRACK_CONFIG ?? path.join(configDir, "youtrack.json"))) return true;
  return readWorkspacesResult(configDir).entries.some((entry) => {
    const raw = entry as Record<string, unknown>;
    return issueTrackerOf(raw.issues, raw.youtrack)?.provider === "youtrack";
  });
};

const bare = (version: string): string => version.trim().replace(/^v/u, "");

/** Two versions name the same release (`v0.3.0` and `0.3.0` do). */
export const sameVersion = (a: string, b: string): boolean => bare(a) === bare(b);

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

export type YtrackSkillSupport =
  | { state: "missing" }
  | { state: "unsupported"; version: string | null }
  | { state: "supported"; version: string };

/**
 * Whether the ytrack on PATH ships the skill: `ytrack skill print` exits 0
 * with the ytrack skill. An older ytrack (0.2.1 and before) has no `skill` command.
 */
export function ytrackSkillSupport(run: YtrackRun): YtrackSkillSupport {
  const out = run(["version"]);
  if (out.missing) return { state: "missing" };
  const version = /ytrack version (\S+)/u.exec(out.stdout)?.[1] ?? null;
  const print = run(["skill", "print"]);
  const meta = print.status === 0 ? parseSkillMeta(print.stdout) : null;
  if (!meta || meta.name !== YTRACK_SKILL) return { state: "unsupported", version };
  const stamped = version ?? meta.version;
  return stamped ? { state: "supported", version: stamped } : { state: "unsupported", version };
}

/** One skill install Workit made: uninstall removes `path` and only that. */
export type YtrackSkillInstall = { host: SkillHost; path: string; version: string };

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
        typeof (row as YtrackSkillInstall).version === "string",
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

export type YtrackSkillResult = {
  host: SkillHost;
  /** The skill directory (`<host skills root>/ytrack`). */
  path: string;
  /** installed: new or refreshed; current: already this version; failed: ytrack refused. */
  status: "installed" | "current" | "failed";
  /** The version found before this run, when a ytrack skill was there. */
  previous: string | null;
  error?: string;
  /** The command that installs this host's skill by hand. */
  command: string;
};

export type YtrackSkillSync =
  | { state: "missing" }
  | { state: "unsupported"; version: string | null }
  | { state: "synced"; version: string; results: YtrackSkillResult[] };

const quoteArg = (value: string): string =>
  /^[\w./:@~+-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;

/** The command that installs the skill into `root` by hand. */
export const ytrackSkillCommand = (root: string): string =>
  `ytrack skill install --dir ${quoteArg(root)}`;

/**
 * Install the skill of the ytrack on PATH into each host's skills directory
 * (`roots`: the host's native user skills directory)
 * (`ytrack skill install --dir <root> --json`). A directory already at this
 * version is left alone. Workit records a directory it created, and keeps
 * recording one it created before; a ytrack skill someone else put there is
 * refreshed but never recorded, so uninstall leaves it.
 */
export function syncYtrackSkill(options: {
  roots: readonly { host: SkillHost; root: string }[];
  stateDir: string;
  run: YtrackRun;
}): YtrackSkillSync {
  const support = ytrackSkillSupport(options.run);
  if (support.state !== "supported") return support;
  const recorded = readYtrackSkillRecord(options.stateDir);
  const results: YtrackSkillResult[] = [];
  for (const { host, root } of options.roots) {
    const dir = path.join(root, YTRACK_SKILL);
    const command = ytrackSkillCommand(root);
    const previous = installedSkillVersion(dir);
    const ours = recorded.find((row) => row.host === host && row.path === dir);
    if (previous !== null && sameVersion(previous, support.version)) {
      results.push({ host, path: dir, status: "current", previous, command });
      continue;
    }
    const existed = previous !== null || existsSync(dir) || isLink(dir);
    const out = options.run(["skill", "install", "--dir", root, "--json"]);
    let installed: { path?: unknown; version?: unknown } | null = null;
    try {
      installed = out.status === 0 ? JSON.parse(out.stdout) : null;
    } catch {
      installed = null;
    }
    if (!installed || typeof installed.version !== "string") {
      results.push({
        host,
        path: dir,
        status: "failed",
        previous,
        error: ytrackDetail(out) || `ytrack exited ${out.status ?? "without a status"}`,
        command,
      });
      continue;
    }
    results.push({ host, path: dir, status: "installed", previous, command });
    if (ours || !existed) {
      const rest = recorded.filter((row) => row.host !== host);
      recorded.splice(0, recorded.length, ...rest, {
        host,
        path: dir,
        version: installed.version,
      });
    }
  }
  writeRecord(options.stateDir, recorded);
  return { state: "synced", version: support.version, results };
}

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
  | { kind: "remove"; detail: string }
  /** Nothing left to delete: only Workit's record of it goes. */
  | { kind: "absent"; detail: string }
  /** Not a path Workit may delete, or no longer the skill Workit installed: left as it is. */
  | { kind: "keep"; detail: string };

const YTRACK_SKILL_REMOVE = "remove the ytrack skill Workit installed";
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
  return { kind: "remove", detail: YTRACK_SKILL_REMOVE };
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
  try {
    rmSync(install.path, { recursive: true, force: true });
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  forget();
  return { status: "removed" };
}
