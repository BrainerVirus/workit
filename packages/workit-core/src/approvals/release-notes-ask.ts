// What `workit release notes approve <v>` asks on the action itself (#864):
// the host hook (Claude Code PreToolUse, Pi's tool_call) reads the draft and
// shows it in full; the verb reads it once, checks that read against the
// ticket and records that read's sha256, so the yes covers exactly the text
// the person saw. No config read, so the hook stays cheap: a `--package`
// call (its tag needs the config) is not asked on, and the user-only ask or
// the terminal stays its path.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../core/task-contract";
import { gitCommonDir } from "../git/rev";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

/** The words past `release`, when they are `notes approve …`. */
export const isReleaseNotesApprove = (words: readonly string[]): boolean =>
  words[0] === "notes" && words[1] === "approve";

export type ReleaseNotesAsk = {
  kind: "release-notes";
  action: string;
  text: string;
  argvHash: string;
  contentHash: string;
};

/**
 * The one version (or release package tag) the words past `approve` name,
 * with `--track` allowed and `--json` skipped; null for anything else.
 */
const versionOf = (args: readonly string[]): string | null => {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") continue;
    if (arg === "--track") index += 1;
    else if (!arg.startsWith("--track=")) {
      if (arg.startsWith("-")) return null;
      positionals.push(arg);
    }
  }
  const [version] = positionals;
  return positionals.length === 1 &&
    version &&
    /^[\w@%+.:/-]+$/u.test(version) &&
    !version.includes("..")
    ? version
    : null;
};

/** The ask for `args` (past `approve`) on the draft read once; null when they name no one version. */
export const releaseNotesAsk = (
  args: readonly string[],
  draft: { path: string; notes: string },
): ReleaseNotesAsk | null => {
  const version = versionOf(args);
  if (!version) return null;
  const action = `workit release notes approve ${version}`;
  return {
    kind: "release-notes",
    action,
    // In full: finish publishes exactly this text.
    text: `Yes approves the release notes of ${version} (${draft.path}); finish publishes exactly this text:\n\n${draft.notes.trimEnd()}`,
    argvHash: sha256(canonicalJson(args)),
    contentHash: sha256(canonicalJson({ args, notes: sha256(draft.notes) })),
  };
};

/**
 * The hook's ask in `cwd`: the draft the verb reads for the version (a
 * release package tag's first), or null when there is none to show.
 */
export const releaseNotesAskAt = (args: readonly string[], cwd: string): ReleaseNotesAsk | null => {
  const version = versionOf(args);
  const common = version ? gitCommonDir(cwd) : null;
  if (!version || !common) return null;
  const dir = path.join(common, "workit", "release-notes");
  for (const file of [
    path.join(dir, "packages", `${version.replaceAll("/", "%2F")}.md`),
    path.join(dir, `${version}.md`),
  ])
    if (existsSync(file))
      try {
        return releaseNotesAsk(args, { path: file, notes: readFileSync(file, "utf8") });
      } catch {
        return null;
      }
  return null;
};
