// CHANGELOG.md entries in GitHub release notes: the release's generateNotes and
// prepare commands (release.config.cjs) and the backfill of published releases,
// against a temp repo with real tags and a fake `gh`.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { backfillChangelogNotes, releaseNotes } from "@/scripts/backfill-release-notes";
import {
  GITHUB_BODY_LIMIT,
  MARKER_END,
  MARKER_START,
  changelogBlock,
  main,
  parseGroups,
  withChangelogBlock,
} from "@/scripts/roll-changelog";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

const HEAD = `# Changelog

Intro.

## [Unreleased]
`;
const TAIL = `## [0.1.0] - 2026-01-01

### Added

- Origin.

[Unreleased]: https://github.com/acme/widget/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/acme/widget/releases/tag/v0.1.0
`;
const ALPHA = "- Alpha: added before 2.10.0, rewrapped after it shipped.";
const ALPHA_REWRAPPED = "- Alpha: added before 2.10.0, rewrapped\n  after it shipped.";
const BETA = "- Beta: fixed before 2.11.0.";
const GAMMA = "- Gamma: added after 2.11.0.";

const changelog = (added: string[], fixed: string[]): string =>
  [
    HEAD,
    ...(added.length ? [`### Added\n\n${added.join("\n")}\n`] : []),
    ...(fixed.length ? [`### Fixed\n\n${fixed.join("\n")}\n`] : []),
    TAIL,
  ].join("\n");

/** Alpha ships in 2.10.0, Beta in 2.11.0; Alpha is rewrapped and Gamma added after. */
const HISTORY = [
  { text: changelog([ALPHA], []), tag: "workit-dev-v2.10.0", date: "2026-02-01" },
  { text: changelog([ALPHA], [BETA]), tag: "workit-dev-v2.11.0", date: "2026-03-01" },
  { text: changelog([GAMMA, ALPHA_REWRAPPED], [BETA]), date: "2026-03-05" },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeRepo(history: Array<{ text: string; tag?: string; date: string }>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-relnotes-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, ".gitconfig");
  writeFileSync(globalConfig, "");
  const cwd = path.join(root, "repo");
  const git = (args: string[], date = "2026-01-01"): string => {
    const run = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
        GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
      },
    });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout;
  };
  mkdirSync(cwd);
  git(["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(["config", key, value]);
  git(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  for (const step of history) {
    writeFileSync(path.join(cwd, "CHANGELOG.md"), step.text);
    git(["add", "CHANGELOG.md"]);
    git(["commit", "-q", "-m", "docs: changelog"], step.date);
    if (step.tag) git(["tag", step.tag], step.date);
  }
  const read = () => readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
  const exec = (cmd: string, args: string[]) => {
    if (cmd !== "git") throw new Error(`unexpected ${cmd}`);
    return git(args);
  };
  return { cwd, git, read, exec };
}

/** The roll-changelog command release.config.cjs runs for `step`, run in `cwd`. */
function releaseStep(cwd: string, step: "generateNotesCmd" | "prepareCmd", version: string) {
  const config = createRequire(import.meta.url)(path.join(REPO_ROOT, "release.config.cjs")) as {
    plugins: unknown[];
  };
  const entry = config.plugins.find(
    (p) => Array.isArray(p) && typeof (p[1] as Record<string, unknown>)?.[step] === "string",
  ) as [string, Record<string, string>];
  const [bin = "", script = "", ...args] = String(entry[1][step])
    .replace("${nextRelease.version}", version)
    .split(" ");
  const run = spawnSync(bin, [path.join(REPO_ROOT, script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.status !== 0) throw new Error(`${step}: ${run.stderr}`);
  return run.stdout.trim();
}

/** What @semantic-release/github receives: each generateNotes output, joined like semantic-release does. */
async function releaseBody(cwd: string, version: string): Promise<string> {
  const changelogNotes = releaseStep(cwd, "generateNotesCmd", version);
  const commitNotes = await releaseNotes(REPO_ROOT, {
    commits: [{ hash: "a".repeat(40), message: "feat(cli): add gamma (#12)" }],
    lastRelease: { gitTag: "workit-dev-v2.11.0" },
    nextRelease: { version, gitTag: `workit-dev-v${version}` },
    options: { repositoryUrl: "https://github.com/acme/widget" },
  });
  return [changelogNotes, commitNotes].filter(Boolean).join("\n\n");
}

const silent = { out: () => {}, err: () => {} };

test("Given entries added before 2.10.0, before 2.11.0 and after, When the roll splits [Unreleased], Then each lands under the first tag holding it and the later one stays", () => {
  const repo = makeRepo(HISTORY);
  expect(main([], { root: repo.cwd, exec: repo.exec, ...silent })).toBe(0);
  expect(repo.read()).toBe(`# Changelog

Intro.

## [Unreleased]

### Added

- Gamma: added after 2.11.0.

## [2.11.0] - 2026-03-01

### Fixed

- Beta: fixed before 2.11.0.

## [2.10.0] - 2026-02-01

### Added

- Alpha: added before 2.10.0, rewrapped
  after it shipped.

## [0.1.0] - 2026-01-01

### Added

- Origin.

[Unreleased]: https://github.com/acme/widget/compare/workit-dev-v2.11.0...HEAD
[2.11.0]: https://github.com/acme/widget/compare/workit-dev-v2.10.0...workit-dev-v2.11.0
[2.10.0]: https://github.com/acme/widget/releases/tag/workit-dev-v2.10.0
[0.1.0]: https://github.com/acme/widget/releases/tag/v0.1.0
`);
  const rolled = repo.read();
  main([], { root: repo.cwd, exec: repo.exec, ...silent });
  expect(repo.read()).toBe(rolled);
});

test("Given [Unreleased] entries and release 2.12.0, When the release's generateNotes and prepare commands run, Then CHANGELOG.md gets [2.12.0] with them, [Unreleased] is empty and the body starts with them before the PR-title list", async () => {
  const repo = makeRepo(HISTORY);
  const body = await releaseBody(repo.cwd, "2.12.0");
  expect(
    body.startsWith(`${MARKER_START}\n### Added\n\n${GAMMA}\n${MARKER_END}\n\n## [2.12.0](`),
  ).toBe(true);
  expect(body).toContain("### Features\n\n* **cli:** add gamma");
  expect(body).not.toContain("Alpha");

  releaseStep(repo.cwd, "prepareCmd", "2.12.0");
  const today = new Date().toISOString().slice(0, 10);
  const text = repo.read();
  expect(text).toContain(
    `## [Unreleased]\n\n## [2.12.0] - ${today}\n\n### Added\n\n${GAMMA}\n\n## [2.11.0]`,
  );
  expect(text).toContain(
    "[Unreleased]: https://github.com/acme/widget/compare/workit-dev-v2.12.0...HEAD\n" +
      "[2.12.0]: https://github.com/acme/widget/compare/workit-dev-v2.11.0...workit-dev-v2.12.0\n",
  );
});

test("Given a release with no [Unreleased] entries, Then the body is the PR-title list only and CHANGELOG.md is unchanged", async () => {
  const repo = makeRepo(HISTORY.slice(0, 2));
  main([], { root: repo.cwd, exec: repo.exec, ...silent });
  const rolled = repo.read();
  expect(rolled).toContain("## [Unreleased]\n\n## [2.11.0] - 2026-03-01");

  const body = await releaseBody(repo.cwd, "2.12.0");
  expect(body.startsWith("## [2.12.0](")).toBe(true);
  expect(body).not.toContain(MARKER_START);
  releaseStep(repo.cwd, "prepareCmd", "2.12.0");
  expect(repo.read()).toBe(rolled);
});

test("Given two [Unreleased] entries that start alike, Then each is matched on its whole text", () => {
  const shared = `- ${"Same start ".repeat(10)}`;
  const repo = makeRepo([
    { text: changelog([`${shared}shipped.`], []), tag: "workit-dev-v2.10.0", date: "2026-02-01" },
    { text: changelog([`${shared}shipped.`, `${shared}not yet.`], []), date: "2026-02-02" },
  ]);
  main([], { root: repo.cwd, exec: repo.exec, ...silent });
  const [unreleased = "", released = ""] = repo.read().split("## [2.10.0]");
  expect(unreleased).toContain("not yet.");
  expect(unreleased).not.toContain("shipped.");
  expect(released).toContain("shipped.");
});

test("Given entries longer than the cap, Then the block keeps those that fit and ends with the compare link", () => {
  const entries = Array.from({ length: 50 }, (_, i) => `- Entry ${i} ${"x".repeat(90)}`);
  const groups = parseGroups(["### Added", "", ...entries]);
  const more = "the full comparison [a...b](https://github.com/acme/widget/compare/a...b)";
  const block = changelogBlock(groups, { cap: 1000, more });
  expect(block.length).toBeLessThanOrEqual(1000);
  expect(block).toContain("- Entry 0 ");
  expect(block).not.toContain("- Entry 49 ");
  expect(block.endsWith(`not listed here; see ${more}._\n${MARKER_END}`)).toBe(true);
});

// --- backfill of published releases -------------------------------------------------

const PR_LIST = (version: string, previous: string) =>
  `## [${version}](https://github.com/acme/widget/compare/workit-dev-v${previous}...workit-dev-v${version}) (2026-03-01)\n\n### Features\n\n* a feature (#1)\n`;

/** `gh release view|edit` over an in-memory set of release bodies. */
function fakeGh(bodies: Record<string, string>, git: (cmd: string, args: string[]) => string) {
  const edits: string[] = [];
  const exec = (cmd: string, args: string[], input?: string): string => {
    if (cmd === "git") return git(cmd, args);
    const [, verb, tag = ""] = args;
    if (verb === "view") {
      if (!(tag in bodies)) throw new Error("release not found");
      return `${bodies[tag]}\n`;
    }
    if (verb === "edit") {
      edits.push(tag);
      bodies[tag] = input ?? "";
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { exec, edits };
}

test("Given the backfill run twice against a fake release API, Then the first puts each release's entries above its PR-title list and the second changes nothing", () => {
  const repo = makeRepo(HISTORY);
  const bodies = {
    "workit-dev-v2.10.0": PR_LIST("2.10.0", "2.9.0"),
    "workit-dev-v2.11.0": PR_LIST("2.11.0", "2.10.0"),
  };
  const gh = fakeGh(bodies, repo.exec);
  const first = backfillChangelogNotes({
    root: repo.cwd,
    apply: true,
    exec: gh.exec,
    log: () => {},
  });
  expect(first.map((c) => c.tag)).toEqual(["workit-dev-v2.10.0", "workit-dev-v2.11.0"]);
  expect(bodies["workit-dev-v2.11.0"]).toBe(
    `${MARKER_START}\n### Fixed\n\n${BETA}\n${MARKER_END}\n\n${PR_LIST("2.11.0", "2.10.0").trim()}`,
  );
  expect(bodies["workit-dev-v2.10.0"]).toContain(`### Added\n\n${ALPHA_REWRAPPED}\n${MARKER_END}`);

  const lines: string[] = [];
  const second = backfillChangelogNotes({
    root: repo.cwd,
    apply: true,
    exec: gh.exec,
    log: (l) => lines.push(l),
  });
  expect(second).toEqual([]);
  expect(gh.edits).toEqual(["workit-dev-v2.10.0", "workit-dev-v2.11.0"]);
  expect(lines).toContain("workit-dev-v2.11.0: unchanged (1 changelog entry)");
});

test("Given --dry-run, Then the backfill edits nothing and prints a per-release summary", () => {
  const repo = makeRepo(HISTORY);
  const bodies = {
    "workit-dev-v2.10.0": PR_LIST("2.10.0", "2.9.0"),
    "workit-dev-v2.11.0": PR_LIST("2.11.0", "2.10.0"),
  };
  const before = { ...bodies };
  const gh = fakeGh(bodies, repo.exec);
  const lines: string[] = [];
  const planned = backfillChangelogNotes({
    root: repo.cwd,
    exec: gh.exec,
    log: (l) => lines.push(l),
  });
  expect(gh.edits).toEqual([]);
  expect(bodies).toEqual(before);
  expect(planned).toHaveLength(2);
  expect(lines[0]).toStartWith("workit-dev-v2.10.0: would update, 1 changelog entry (body ");
  expect(lines[1]).toStartWith("workit-dev-v2.11.0: would update, 1 changelog entry (body ");
  expect(lines.at(-1)).toBe(
    "dry run: 2 release(s) to update, 0 unchanged; re-run with --apply to write them",
  );
  // The CHANGELOG.md in the checkout is only read.
  expect(repo.read()).toBe(HISTORY[2]?.text);
});

test("Given a body that would pass 125,000 characters, Then the backfill cuts the block with a compare link instead of being rejected", () => {
  const long = Array.from({ length: 40 }, (_, i) => `- Beta ${i}: ${"y".repeat(200)}`);
  const repo = makeRepo([
    { text: changelog([ALPHA], []), tag: "workit-dev-v2.10.0", date: "2026-02-01" },
    { text: changelog([ALPHA], long), tag: "workit-dev-v2.11.0", date: "2026-03-01" },
  ]);
  const bodies = {
    "workit-dev-v2.10.0": PR_LIST("2.10.0", "2.9.0"),
    "workit-dev-v2.11.0": `${PR_LIST("2.11.0", "2.10.0")}${"* a fix (#2)\n".repeat(9_400)}`,
  };
  const gh = fakeGh(bodies, repo.exec);
  backfillChangelogNotes({ root: repo.cwd, apply: true, exec: gh.exec, log: () => {} });
  const body = bodies["workit-dev-v2.11.0"];
  expect(body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
  expect(body).toContain("- Beta 0: ");
  expect(body).not.toContain("- Beta 39: ");
  expect(body).toContain(
    "see the full comparison [workit-dev-v2.10.0...workit-dev-v2.11.0](https://github.com/acme/widget/compare/workit-dev-v2.10.0...workit-dev-v2.11.0)._",
  );
  expect(body).toEndWith("* a fix (#2)");
});

test("A release body keeps one changelog block: replacing it drops the old one, an empty block removes it", () => {
  const block = `${MARKER_START}\n- new\n${MARKER_END}`;
  const old = `${MARKER_START}\n- old\n${MARKER_END}\n\n## [1.0.0]\n\n* a\n`;
  expect(withChangelogBlock(old, block)).toBe(`${block}\n\n## [1.0.0]\n\n* a`);
  expect(withChangelogBlock(old, "")).toBe("## [1.0.0]\n\n* a");
});
