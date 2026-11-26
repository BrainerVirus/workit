// The `shared` workspace check `workit pr create` and `workit pr edit` run
// (#879): in a team repo that must not name the personal tooling, warn, never
// block, when the PR title, its body or a doc the branch adds names Workit.
// What Workit itself writes is exempt: the `Workit-Session:` trailer and its
// `<!-- workit… -->` markers.
import { spawnSync } from "node:child_process";
import { GIT_TIMEOUTS } from "../git/rev";

const NAMES_WORKIT = /\bworkit\b/iu;
const SESSION_TRAILER = /^\s*Workit-Session\s*:/iu;
const WORKIT_MARKER = /<!--\s*workit[\s\S]*?-->/giu;
const NEW_DOC = /\.mdx?$/iu;

/** The 1-based lines of `text` that name Workit, the trailer and markers aside. */
export function workitLines(text: string): number[] {
  const unmarked = text.replaceAll(WORKIT_MARKER, (marker) => marker.replaceAll(/[^\n]/gu, ""));
  return unmarked
    .split("\n")
    .flatMap((line, index) =>
      !SESSION_TRAILER.test(line) && NAMES_WORKIT.test(line) ? [index + 1] : [],
    );
}

const git = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
};

/** The Markdown docs the branch adds since `fork`, repo-relative. */
const addedDocs = (cwd: string, fork: string): string[] =>
  (git(cwd, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", fork, "HEAD"]) ?? "")
    .split("\0")
    .filter((file) => NEW_DOC.test(file));

const lineList = (lines: readonly number[]): string =>
  `${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}`;

/**
 * One warning per place that names Workit: the title, the body, each doc the
 * branch adds since `fork` (skipped when `fork` is null). Each names the place
 * and asks for a rewording.
 */
export function sharedWorkspaceWarnings(input: {
  cwd: string;
  workspace: string | null;
  title?: string | undefined;
  body?: string | undefined;
  fork: string | null;
}): string[] {
  const places: string[] = [];
  if (input.title !== undefined && workitLines(input.title).length) places.push("the PR title");
  const body = input.body === undefined ? [] : workitLines(input.body);
  if (body.length) places.push(`the PR body (${lineList(body)})`);
  for (const file of input.fork ? addedDocs(input.cwd, input.fork) : []) {
    const lines = workitLines(git(input.cwd, ["show", `HEAD:${file}`]) ?? "");
    if (lines.length) places.push(`new doc ${file} (${lineList(lines)})`);
  }
  const where = input.workspace ? `workspace ${input.workspace} is shared` : "shared workspace";
  return places.map(
    (place) =>
      `${where}: ${place} names Workit; reword it so the team repo does not mention it (a warning only)`,
  );
}
