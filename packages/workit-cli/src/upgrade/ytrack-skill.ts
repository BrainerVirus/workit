// ytrack 0.6.0 and newer installs and refreshes its own agent skill, into
// ~/.agents/skills (read by Codex, Cursor, OpenCode and Pi) and
// ~/.claude/skills. Workit no longer installs it; `workit upgrade` removes the
// per-host copies an older Workit installed once ytrack's shared copy exists,
// so those hosts do not list the skill twice.
import { realpathSync } from "node:fs";
import path from "node:path";
import { stateDir as workitStateDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import {
  forgetYtrackSkillRecord,
  installedSkillVersion,
  readYtrackSkillRecord,
  removeYtrackSkill,
  YTRACK_SKILL,
  type SkillHost,
} from "@workit-dev/core/src/core/ytrack-skill";
import { type HostOutcome } from "./shared";
import { hostSkillsRoot } from "./skill-roots";

// ~/.claude/skills/ytrack is one of ytrack's own default copies: it stays.
const SHARED_READERS: ReadonlySet<SkillHost> = new Set(["codex", "cursor", "opencode", "pi"]);

/** ytrack's shared copy of its skill, `~/.agents/skills/ytrack`. */
const sharedYtrackSkill = (home: string): string =>
  path.join(home, ".agents", "skills", YTRACK_SKILL);

/** Whether ytrack keeps its own skill copies here: `~/.agents/skills/ytrack` holds the skill. */
const ytrackKeepsSkill = (home: string): boolean =>
  installedSkillVersion(sharedYtrackSkill(home)) !== null;

/**
 * Whether `host`'s skill copy is ytrack's own now: Claude Code's
 * `~/.claude/skills/ytrack` is one of ytrack's default copies once ytrack
 * keeps its skill, so uninstall leaves it even when Workit recorded it.
 */
export const ytrackOwnsCopy = (host: SkillHost, home: string): boolean =>
  !SHARED_READERS.has(host) && ytrackKeepsSkill(home);

const realOrResolved = (file: string): string => {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

/** `a` is `b`, holds it, or sits inside it. */
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/**
 * Remove the Codex, Cursor, OpenCode and Pi copies Workit installed (its
 * ytrack-skill.json record, the files it wrote, never a copy someone else
 * made) when `~/.agents/skills/ytrack` holds the ytrack skill, then forget the
 * whole record, so uninstall leaves ytrack's own copies alone. A recorded copy
 * that is the shared one through a symlink (either way round), holds it or
 * sits inside it is never removed, and the shared copy is checked again
 * before each removal. One `ytrack` row when something was removed or could
 * not be; null otherwise.
 */
export function retireYtrackSkillCopies(options: {
  home: string;
  env: NodeJS.ProcessEnv;
}): HostOutcome | null {
  const { env, home } = options;
  const stateDir = workitStateDir(env);
  const recorded = readYtrackSkillRecord(stateDir);
  const shared = sharedYtrackSkill(home);
  if (recorded.length === 0 || !ytrackKeepsSkill(home)) return null;
  const realShared = realOrResolved(shared);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const install of recorded) {
    if (!SHARED_READERS.has(install.host)) continue;
    if (overlaps(realOrResolved(install.path), realShared)) continue;
    // Each removal may change the tree: the shared copy must still be ytrack's.
    if (!ytrackKeepsSkill(home) || realOrResolved(shared) !== realShared) {
      failed.push(`${shared} no longer holds the ytrack skill; nothing more removed`);
      break;
    }
    const root = hostSkillsRoot(install.host, home, env);
    const outcome = removeYtrackSkill(install, stateDir, { root, home });
    if (outcome.status === "removed") removed.push(install.path);
    if (outcome.status === "failed") failed.push(`${install.path}: ${outcome.detail}`);
  }
  // A failed removal keeps the record, so the next upgrade tries again.
  if (failed.length)
    return {
      host: "ytrack",
      status: "skipped",
      reason: `Workit's copies of the ytrack skill not removed: ${failed.join("; ")}`,
      fix: "workit upgrade",
    };
  forgetYtrackSkillRecord(stateDir);
  if (removed.length === 0) return null;
  return {
    host: "ytrack",
    status: "updated",
    reason: `retired Workit's copies of the ytrack skill: ytrack keeps ${shared}; ytrack still lists them as missing until \`ytrack skill sync\` (optional)`,
    details: removed,
  };
}
