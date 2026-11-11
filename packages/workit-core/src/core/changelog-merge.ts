// Three-way merge of a Keep a Changelog file for `workit changelog merge`, a git
// merge driver: two branches that each add bullets under `## [Unreleased]` merge
// without a conflict. Only the Unreleased body is merged here; the caller hands
// the rest of the file to `git merge-file`, so a conflict elsewhere keeps git's
// normal markers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitError, git } from "../git/ops";
import { workspaceChangelog } from "./workspaces";
import { bulletBlocks, hasUnreleasedHeading, splitSections, splitUnreleased } from "./changelog";

type Section = { heading: string; id: string; preamble: string[]; blocks: Map<string, string[]> };

const headingId = (heading: string): string =>
  heading
    .replace(/\r?\n$/u, "")
    .replace(/^###\s+/u, "")
    .trim()
    .toLowerCase();

const withNewline = (line: string): string => (line.endsWith("\n") ? line : `${line}\n`);

const parseBody = (body: string): { preamble: string[]; sections: Section[] } => {
  const [preamble, raw] = splitSections(body);
  const sections: Section[] = [];
  for (const one of raw) {
    const id = headingId(one.heading);
    let section = sections.find((s) => s.id === id);
    if (!section) {
      section = { heading: one.heading, id, preamble: [], blocks: new Map() };
      sections.push(section);
    }
    for (const [key, lines] of bulletBlocks(one.body)) {
      const kept = lines.map(withNewline);
      if (key === null) {
        if (kept.some((line) => line.trim())) section.preamble.push(...kept);
        continue;
      }
      while (kept.length > 1 && !kept[kept.length - 1].trim()) kept.pop();
      if (!section.blocks.has(key)) section.blocks.set(key, kept);
    }
  }
  return { preamble: preamble.map(withNewline), sections };
};

/** Ours, then theirs; a bullet one side dropped from base stays dropped. */
const mergeBlocks = (
  base: Map<string, string[]> | undefined,
  ours: Map<string, string[]> | undefined,
  theirs: Map<string, string[]> | undefined,
): string[][] => {
  const out = new Map<string, string[]>();
  for (const [key, lines] of ours ?? []) {
    if (base?.has(key) && theirs && !theirs.has(key)) continue;
    out.set(key, lines);
  }
  for (const [key, lines] of theirs ?? []) {
    if (out.has(key) || base?.has(key)) continue;
    out.set(key, lines);
  }
  return [...out.values()];
};

/** The merged `## [Unreleased]` body (everything after that heading line). */
export const mergeUnreleasedBody = (base: string, ours: string, theirs: string): string => {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const b = parseBody(base);
  const o = parseBody(ours);
  const t = parseBody(theirs);
  const ids = [...new Set([...o.sections, ...t.sections].map((s) => s.id))];
  const sectionOf = (side: { sections: Section[] }, id: string) =>
    side.sections.find((s) => s.id === id);
  let out = o.preamble.join("") || t.preamble.join("");
  for (const id of ids) {
    const mine = sectionOf(o, id);
    const theirsOne = sectionOf(t, id);
    const baseOne = sectionOf(b, id);
    const blocks = mergeBlocks(baseOne?.blocks, mine?.blocks, theirsOne?.blocks);
    // A section both sides emptied (or one emptied that the other left alone) is dropped.
    if (!blocks.length && baseOne && (!mine || !theirsOne)) continue;
    const prose = (mine ?? theirsOne)?.preamble.join("") ?? "";
    const heading = (mine ?? theirsOne)!.heading;
    out += `${withNewline(heading)}\n${prose}${blocks.flat().join("")}\n`;
  }
  // The joins above add bare LF; a CRLF file keeps CRLF throughout.
  return ours.includes("\r\n") ? out.replace(/\r?\n/gu, "\r\n") : out;
};

/**
 * Replace each file's Unreleased body with the merged body, so only text
 * outside Unreleased can still differ. null when a file has no Unreleased
 * heading (the caller falls back to a plain three-way merge).
 */
export const withMergedUnreleased = (
  base: string,
  ours: string,
  theirs: string,
): { base: string; ours: string; theirs: string } | null => {
  if (![base, ours, theirs].every(hasUnreleasedHeading)) return null;
  const [bBefore, bBody, bAfter] = splitUnreleased(base);
  const [oBefore, oBody, oAfter] = splitUnreleased(ours);
  const [tBefore, tBody, tAfter] = splitUnreleased(theirs);
  const merged = mergeUnreleasedBody(bBody, oBody, tBody);
  return {
    base: bBefore + merged + bAfter,
    ours: oBefore + merged + oAfter,
    theirs: tBefore + merged + tAfter,
  };
};

export const CHANGELOG_DRIVER = "workit-changelog";
/**
 * Git runs the driver through sh. When `workit` cannot run (not on PATH: 127,
 * an older CLI without the verb: 2), git would leave a conflicted file holding
 * only ours with no markers, and a quick `git add` would drop theirs; falling
 * back to `git merge-file` leaves normal markers instead. Exit 0 or 1 is the
 * driver's own answer and is passed through untouched.
 */
export const CHANGELOG_DRIVER_COMMAND =
  'workit changelog merge %O %A %B; s=$?; [ "$s" -le 1 ] && exit "$s"; git merge-file %A %O %B';

/** The `.gitattributes` file `driver install` edits: the one at the work tree root. */
export const gitattributesPath = (root: string): string => path.join(root, ".gitattributes");

/**
 * Three-way merge of changelog text: the Unreleased bodies merge entry by entry
 * and the rest goes through `git merge-file`. `clean` is false when conflict
 * markers are left in `text`.
 */
export const mergeChangelogText = (
  base: string,
  ours: string,
  theirs: string,
): { clean: boolean; text: string } | { error: string } => {
  const merged = withMergedUnreleased(base, ours, theirs) ?? { base, ours, theirs };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workit-changelog-merge-"));
  try {
    const one = (name: string, text: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, "utf8");
      return file;
    };
    const o = one("ours", merged.ours);
    const run = git(
      dir,
      [
        "merge-file",
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
        o,
        one("base", merged.base),
        one("theirs", merged.theirs),
      ],
      { timeoutMs: 30_000 },
    );
    if (run.status === null || run.status > 127) return { error: gitError(run) };
    return { clean: run.status === 0, text: fs.readFileSync(o, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Merge the three files git hands a merge driver, writing the result over
 * `ours`. Returns the exit code git expects: 0 clean, 1 conflict markers left.
 */
export const mergeChangelogFiles = (files: {
  base: string;
  ours: string;
  theirs: string;
}): { code: 0 | 1; error?: string } => {
  const read = (file: string) => fs.readFileSync(file, "utf8");
  const result = mergeChangelogText(read(files.base), read(files.ours), read(files.theirs));
  if ("error" in result) return { code: 1, error: result.error };
  fs.writeFileSync(files.ours, result.text, "utf8");
  return { code: result.clean ? 0 : 1 };
};

/**
 * Settle a conflicted changelog path during a rebase or merge without the
 * driver installed: merge its index stages and stage the result. False (and
 * nothing touched) when a stage is missing or the merge leaves markers.
 */
export const resolveChangelogConflict = (root: string, file: string): boolean => {
  const stage = (n: number) => git(root, ["show", `:${n}:${file}`]);
  const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
  if (!base.ok || !ours.ok || !theirs.ok) return false;
  const result = mergeChangelogText(base.stdout, ours.stdout, theirs.stdout);
  if ("error" in result || !result.clean) return false;
  fs.writeFileSync(path.join(root, file), result.text, "utf8");
  return git(root, ["add", "--", file]).ok;
};

/**
 * Register the driver in the repo's local git config and give the configured
 * changelog paths a `merge=` attribute. Running it again changes nothing.
 */
export const installChangelogDriver = (
  cwd: string,
): { root: string; paths: string[]; attributes: string; changed: string[] } | { error: string } => {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: "not inside a git work tree" };
  const root = fs.realpathSync(top.stdout.trim());
  const changed: string[] = [];
  const settings: Array<[string, string]> = [
    [`merge.${CHANGELOG_DRIVER}.name`, "Workit changelog: keep both Unreleased entries"],
    [`merge.${CHANGELOG_DRIVER}.driver`, CHANGELOG_DRIVER_COMMAND],
  ];
  for (const [key, value] of settings) {
    const current = git(root, ["config", "--local", "--get", key]);
    if (current.ok && current.stdout.trim() === value) continue;
    const set = git(root, ["config", "--local", key, value]);
    if (!set.ok) return { error: `git config ${key}: ${gitError(set)}` };
    changed.push(`git config ${key}`);
  }

  const { paths } = workspaceChangelog(root);
  const attributes = gitattributesPath(root);
  const existing = fs.existsSync(attributes) ? fs.readFileSync(attributes, "utf8") : "";
  const have = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields.slice(1).includes(`merge=${CHANGELOG_DRIVER}`))
      .map((fields) => fields[0]),
  );
  const missing = paths.filter((one) => !have.has(one));
  if (missing.length) {
    const lead = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(
      attributes,
      `${existing}${lead}${missing.map((one) => `${one} merge=${CHANGELOG_DRIVER}\n`).join("")}`,
      "utf8",
    );
    changed.push(".gitattributes");
  }
  return { root, paths, attributes, changed };
};
