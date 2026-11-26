// The `shared` workspace check `workit pr create` and `workit pr edit` run
// (#879): in a team repo that must not name the personal tooling, warn, never
// block, when the PR title, its body or a doc the branch adds names Workit.
// What Workit itself writes is exempt: the `Workit-Session:` trailer and its
// `<!-- workit… -->` markers.
import { spawnSync } from "node:child_process";
import { GIT_TIMEOUTS } from "../git/rev";

// A whole word in any script: a letter, digit or underscore on either side, ASCII or not, joins it.
const NAMES_WORKIT = /(?<![\p{L}\p{N}_])workit(?![\p{L}\p{N}_])/iu;
const SESSION_TRAILER = /^\s*Workit-Session\s*:/iu;
const WORKIT_MARKER = /<!--\s*workit[\s\S]*?-->/giu;
const NEW_DOC = /\.mdx?$/iu;

/** One line of a PR or doc that names Workit: where it is, its 1-based line, its text. */
export type SharedHit = { place: string; line: number; text: string };

/** The lines of `text` that name Workit, the trailer and markers aside. */
export function workitLines(text: string): Array<{ line: number; text: string }> {
  const unmarked = text.replaceAll(WORKIT_MARKER, (marker) => marker.replaceAll(/[^\n]/gu, ""));
  return unmarked
    .split("\n")
    .flatMap((line, index) =>
      !SESSION_TRAILER.test(line) && NAMES_WORKIT.test(line)
        ? [{ line: index + 1, text: line.trim() }]
        : [],
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

const lineList = (hits: readonly { line: number }[]): string =>
  `${hits.length === 1 ? "line" : "lines"} ${hits.map((hit) => hit.line).join(", ")}`;

/**
 * The places that name Workit: the title, the body, each doc the branch adds
 * since `fork` (skipped when `fork` is null). `messages` holds one warning per
 * place that names it and asks for a rewording; `hits` one entry per line
 * (`place` is title, body or the doc's path).
 */
export function sharedWorkspaceWarnings(input: {
  cwd: string;
  workspace: string | null;
  title?: string | undefined;
  body?: string | undefined;
  fork: string | null;
}): { messages: string[]; hits: SharedHit[] } {
  const places: Array<{
    place: string;
    label: string;
    lines: Array<{ line: number; text: string }>;
  }> = [];
  if (input.title !== undefined)
    places.push({ place: "title", label: "the PR title", lines: workitLines(input.title) });
  if (input.body !== undefined) {
    const lines = workitLines(input.body);
    places.push({ place: "body", label: `the PR body (${lineList(lines)})`, lines });
  }
  for (const file of input.fork ? addedDocs(input.cwd, input.fork) : []) {
    const lines = workitLines(git(input.cwd, ["show", `HEAD:${file}`]) ?? "");
    places.push({ place: file, label: `new doc ${file} (${lineList(lines)})`, lines });
  }
  const named = places.filter((entry) => entry.lines.length);
  const where = input.workspace ? `workspace ${input.workspace} is shared` : "shared workspace";
  return {
    messages: named.map(
      (entry) =>
        `${where}: ${entry.label} names Workit; reword it so the team repo does not mention it (a warning only)`,
    ),
    hits: named.flatMap((entry) => entry.lines.map((hit) => ({ place: entry.place, ...hit }))),
  };
}
