// Reading a `workit approve <id>…` call out of a shell command. A host acts
// only on one simple call: anything around it (a chain, a substitution, a
// leading `cd`, an env prefix, a redirect) could change what runs, so the hook
// denies it and names the plain form. Ids are read from argv words, never text.
import { segmentsOf, type ShellDialect } from "../hooks/shell-words";
import { isApprovalId } from "./store";

export type ApproveCall =
  /** Exactly `workit approve <id>…`: the ids, in order. */
  | { plain: true; ids: string[] }
  /** A `workit approve` call inside something else: the plain command to run instead. */
  | { plain: false; fix: string };

const isWorkitWord = (word: string): boolean => /^(?:.*[\\/])?workit(?:-cli)?$/u.test(word);

/** Global options the CLI reads before its verb. */
const verbIndex = (words: readonly string[], start: number): number => {
  let at = start;
  for (;;) {
    const word = words[at];
    if (word === "--json") at += 1;
    else if (word === "--cwd" || word === "--session") at += 2;
    else if (word?.startsWith("--cwd=")) at += 1;
    else return at;
  }
};

/**
 * The `workit approve` call in `command`, or null when it runs none (a
 * mention in an argument, `workit help approve`, is not one). A plain call
 * whose arguments are not all request ids (`workit approve --help`) is left to
 * the CLI: null.
 */
export const approveCallIn = (
  command: string,
  dialect: ShellDialect = "posix",
): ApproveCall | null => {
  const segments = segmentsOf(command, dialect);
  for (const segment of segments) {
    if (segment.unanalyzable) continue;
    const start = segment.words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const at = verbIndex(segment.words, start + 1);
    if (segment.words[at] !== "approve") continue;
    const args = segment.words.slice(at + 1);
    const ids = args.filter(isApprovalId);
    const plain =
      segments.length === 1 &&
      start === 0 &&
      segment.words[0] === "workit" &&
      at === 1 &&
      !segment.redirects.length &&
      !segment.subs?.length &&
      !segment.stdin?.length &&
      !segment.expands?.length &&
      !segment.group;
    if (plain) return ids.length > 0 && ids.length === args.length ? { plain: true, ids } : null;
    return {
      plain: false,
      fix: `workit approve ${ids.length ? ids.join(" ") : "<id>…"}`,
    };
  }
  return null;
};

/** The deny reason for a `workit approve` call inside something else. */
export const approveCallDeny = (fix: string): string =>
  `Run \`${fix}\` as its own call: no chain, pipe, substitution, leading cd, env prefix or redirect around it, so the host can show the request and record the user's answer.`;
