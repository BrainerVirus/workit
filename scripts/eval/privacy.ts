// Bench privacy: what a committed result may not carry. evals/results is
// public, so a transcript keeps the world's own files and Workit's output,
// never the account's paths, a host's project history or a real Workit config.

/** Home-dir names a committed result may show: the runner's `<user>` and invented examples. */
const NEUTRAL_USERS = new Set(["<user>", "me", "user", "example"]);

/** An absolute path under a home dir; a placeholder root (`<world>/home/…`) is not one. */
const HOME_PATH = /(?<![\w>.~-])\/(?:home|Users)\/([^/\s"'\\]+)\//gu;
/** A host config's `projects` map: absolute (or `~`) paths as keys. */
const PROJECTS_MAP = /\\*"projects\\*"\s*:\s*\{\s*\\*"(?:\/|~|[A-Za-z]:)/u;
/** A workspace glob under the real home: a world's config globs `<world>/**`. */
const REAL_HOME_GLOB = /\\*"glob\\*"\s*:\s*\\*"~\/(?!projects\/placeholder-)/u;

export type Leak = "home path" | "projects map" | "real config";

/** The kinds of private content `text` (a committed result file) carries; never the content. */
export const committedLeaks = (text: string): Leak[] => {
  const leaks = new Set<Leak>();
  for (const match of text.matchAll(HOME_PATH))
    if (!NEUTRAL_USERS.has(match[1] ?? "")) leaks.add("home path");
  if (PROJECTS_MAP.test(text)) leaks.add("projects map");
  if (REAL_HOME_GLOB.test(text)) leaks.add("real config");
  return [...leaks];
};
