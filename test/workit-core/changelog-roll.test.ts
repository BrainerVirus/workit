// The changelog roll in core (`workit changelog roll|release`): entries move
// to the first tag whose changelog holds them, a release takes the rest, and a
// result that would double or drop text is never written. Temp repos with real
// tags and an empty global git config.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Exec,
  parseGroups,
  releaseBlock,
  runChangelogRoll,
  tagSnapshots,
  versionNotes,
} from "@/packages/workit-core/src/core/changelog-roll";
import { mergeReleaseBody } from "@/packages/workit-core/src/core/release-tag";

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
  { text: changelog([ALPHA], []), tag: "v2.10.0", date: "2026-02-01" },
  { text: changelog([ALPHA], [BETA]), tag: "v2.11.0", date: "2026-03-01" },
  { text: changelog([GAMMA, ALPHA_REWRAPPED], [BETA]), date: "2026-03-05" },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeRepo(
  history: Array<{ text: string; tag?: string; date: string }>,
  file = "CHANGELOG.md",
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-clroll-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, ".gitconfig");
  writeFileSync(globalConfig, "");
  const cwd = path.join(root, "repo");
  const git = (args: string[], date = "2026-01-01"): void => {
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
  };
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(["config", key, value]);
  for (const step of history) {
    writeFileSync(path.join(cwd, file), step.text);
    git(["add", file]);
    git(["commit", "-q", "-m", "docs: changelog"], step.date);
    if (step.tag) git(["tag", step.tag], step.date);
  }
  const read = () => readFileSync(path.join(cwd, file), "utf8");
  return { cwd, read };
}

const ROLLED = `# Changelog

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

[Unreleased]: https://github.com/acme/widget/compare/v2.11.0...HEAD
[2.11.0]: https://github.com/acme/widget/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/acme/widget/releases/tag/v2.10.0
[0.1.0]: https://github.com/acme/widget/releases/tag/v0.1.0
`;

test("Given entries added before 2.10.0, before 2.11.0 and after, When rolled, Then each lands under the first tag holding it, the later one stays, and a second roll changes nothing", () => {
  const repo = makeRepo(HISTORY);
  const first = runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  expect(first.ok && first.moved).toEqual([
    { version: "2.11.0", entries: 1 },
    { version: "2.10.0", entries: 1 },
  ]);
  expect(repo.read()).toBe(ROLLED);
  const second = runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  expect(second.ok && second.changed).toBe(false);
  expect(repo.read()).toBe(ROLLED);
});

test("Given tags under another prefix, When rolled with the repo's prefix, Then their links use it and tags of other prefixes are ignored", () => {
  const repo = makeRepo([
    { text: changelog([ALPHA], []), tag: "pkg-v1.0.0", date: "2026-02-01" },
    { text: changelog([ALPHA, GAMMA], []), tag: "v9.0.0", date: "2026-02-02" },
    { text: changelog([ALPHA, GAMMA, BETA], []), date: "2026-02-03" },
  ]);
  runChangelogRoll({ cwd: repo.cwd, tagPrefix: "pkg-v", write: true });
  const text = repo.read();
  expect(text).toContain(
    `## [Unreleased]\n\n### Added\n\n${GAMMA}\n${BETA}\n\n## [1.0.0] - 2026-02-01\n\n### Added\n\n${ALPHA}\n`,
  );
  expect(text).toContain(
    "[Unreleased]: https://github.com/acme/widget/compare/pkg-v1.0.0...HEAD\n[1.0.0]: https://github.com/acme/widget/releases/tag/pkg-v1.0.0\n",
  );
});

test("Given two [Unreleased] entries that start alike, Then each is matched on its whole text", () => {
  const shared = `- ${"Same start ".repeat(10)}`;
  const repo = makeRepo([
    { text: changelog([`${shared}shipped.`], []), tag: "v2.10.0", date: "2026-02-01" },
    { text: changelog([`${shared}shipped.`, `${shared}not yet.`], []), date: "2026-02-02" },
  ]);
  runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  const [unreleased = "", released = ""] = repo.read().split("## [2.10.0]");
  expect(unreleased).toContain("not yet.");
  expect(unreleased).not.toContain("shipped.");
  expect(released).toContain("shipped.");
});

test("Given a release of the rest, Then the new section holds them, the notes are its groups, and without write nothing changes on disk", () => {
  const repo = makeRepo(HISTORY);
  const before = repo.read();
  const dry = runChangelogRoll({
    cwd: repo.cwd,
    tagPrefix: "v",
    write: false,
    release: { version: "2.12.0", date: "2026-04-01" },
  });
  expect(dry.ok && dry.written).toBe(false);
  expect(repo.read()).toBe(before);
  expect(dry.ok && dry.notes).toBe(`### Added\n\n${GAMMA}\n`);

  const done = runChangelogRoll({
    cwd: repo.cwd,
    tagPrefix: "v",
    write: true,
    release: { version: "2.12.0", date: "2026-04-01" },
  });
  expect(done.ok && done.written).toBe(true);
  const text = repo.read();
  expect(text).toContain(
    `## [Unreleased]\n\n## [2.12.0] - 2026-04-01\n\n### Added\n\n${GAMMA}\n\n## [2.11.0] - 2026-03-01`,
  );
  expect(text).toContain(
    "[Unreleased]: https://github.com/acme/widget/compare/v2.12.0...HEAD\n[2.12.0]: https://github.com/acme/widget/compare/v2.11.0...v2.12.0\n",
  );
  expect(versionNotes(text, "2.10.0")).toBe(`### Added\n\n${ALPHA_REWRAPPED}\n`);
  expect(versionNotes(text, "9.9.9")).toBe("");
});

test("Given an [Unreleased] entry its release's section already holds, When rolled, Then it is refused with the line named and nothing is written", () => {
  const released = changelog([], [BETA]).replace(
    TAIL,
    `## [2.11.0] - 2026-03-01\n\n### Fixed\n\n${BETA}\n\n${TAIL}`,
  );
  const repo = makeRepo([
    { text: changelog([], [BETA]), tag: "v2.11.0", date: "2026-03-01" },
    { text: released, date: "2026-03-02" },
  ]);
  const run = runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  expect(run.ok).toBe(false);
  expect(!run.ok && run.lines).toEqual(["  CHANGELOG.md:9 is already under [2.11.0]"]);
  expect(repo.read()).toBe(released);
});

test("Given a changelog below the repo root, When rolled from the root with its path, Then the tags' copies of that path decide", () => {
  const file = path.join("packages", "a", "CHANGELOG.md");
  const repo = makeRepo(HISTORY, file);
  const run = runChangelogRoll({ cwd: repo.cwd, path: file, tagPrefix: "v", write: true });
  expect(run.ok && run.tags).toBe(2);
  expect(repo.read()).toBe(ROLLED);
});

test("Given a CRLF changelog, When rolled, Then the written file keeps CRLF line endings", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const repo = makeRepo(HISTORY.map((step) => ({ ...step, text: crlf(step.text) })));
  runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  expect(repo.read()).toBe(crlf(ROLLED));
});

test("Given no changelog file, Then the run fails as not found", () => {
  const repo = makeRepo([]);
  const run = runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
  expect(run).toMatchObject({ ok: false, code: "not_found", path: "CHANGELOG.md" });
});

test.skipIf(process.platform === "win32")(
  "Given a CRLF changelog with mode 0640, When rolled, Then it is replaced by a rename that keeps the mode and CRLF and leaves no temp file",
  () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const repo = makeRepo(HISTORY.map((step) => ({ ...step, text: crlf(step.text) })));
    const file = path.join(repo.cwd, "CHANGELOG.md");
    chmodSync(file, 0o640);
    const inode = statSync(file).ino;
    runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
    expect(repo.read()).toBe(crlf(ROLLED));
    expect(statSync(file).mode & 0o777).toBe(0o640);
    // A new inode: the file was renamed into place, never truncated and rewritten.
    expect(statSync(file).ino).not.toBe(inode);
    expect(readdirSync(repo.cwd).filter((name) => name.includes(".tmp"))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "Given CHANGELOG.md is a symlink, When rolled, Then the file it points at is rewritten and the link stays",
  () => {
    const repo = makeRepo(HISTORY);
    const real = path.join(repo.cwd, "docs-CHANGELOG.md");
    writeFileSync(real, repo.read());
    rmSync(path.join(repo.cwd, "CHANGELOG.md"));
    symlinkSync("docs-CHANGELOG.md", path.join(repo.cwd, "CHANGELOG.md"));
    const run = runChangelogRoll({ cwd: repo.cwd, tagPrefix: "v", write: true });
    expect(run.ok && run.written).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(ROLLED);
  },
);

test("Given a changelog with no [Unreleased] section, Then the run reports it missing and writes nothing", () => {
  const text = TAIL;
  const repo = makeRepo([{ text, tag: "v0.1.0", date: "2026-01-01" }]);
  const run = runChangelogRoll({
    cwd: repo.cwd,
    tagPrefix: "v",
    write: true,
    release: { version: "0.2.0", date: "2026-02-01" },
  });
  expect(run).toMatchObject({ ok: true, unreleased: false, changed: false, written: false });
  expect(repo.read()).toBe(text);
});

test("Given a tag prefix with glob characters, Then for-each-ref gets them escaped and only that literal prefix's tags count", () => {
  const seen: string[][] = [];
  const exec: Exec = (_cmd, args) => {
    seen.push(args);
    return args[0] === "for-each-ref"
      ? "rel*v1.0.0\t2026-01-01\nrelXv1.1.0\t2026-01-02\n"
      : "# Changelog\n";
  };
  const snapshots = tagSnapshots(exec, "rel*v");
  expect(seen[0]?.at(-1)).toBe("refs/tags/rel\\*v*");
  expect(snapshots.map((s) => s.tag)).toEqual(["rel*v1.0.0"]);
  tagSnapshots(exec, "a?b[c]\\");
  expect(seen.at(-1)?.at(-1)).toBe("refs/tags/a\\?b\\[c]\\\\*");
});

test("Given --notes-format github, Then the notes are the release's groups between its tag's markers", () => {
  const repo = makeRepo(HISTORY);
  const run = runChangelogRoll({
    cwd: repo.cwd,
    tagPrefix: "v",
    write: false,
    release: { version: "2.12.0", date: "2026-03-06" },
    notesFormat: "github",
  });
  expect(run.ok && run.notes).toBe(
    `<!-- workit:changelog v2.12.0 -->\n### Added\n\n${GAMMA}\n<!-- /workit:changelog -->\n`,
  );
});

test("Given entries longer than the cap, Then the release block keeps those that fit and ends with the compare link", () => {
  const entries = Array.from({ length: 50 }, (_, i) => `- Entry ${i} ${"x".repeat(90)}`);
  const groups = parseGroups(["### Added", "", ...entries]);
  const more = "the full comparison [a...b](https://github.com/acme/widget/compare/a...b)";
  const block = releaseBlock(groups, { tag: "v1.0.0", cap: 1000, more });
  expect(block.length).toBeLessThanOrEqual(1000);
  expect(block).toStartWith("<!-- workit:changelog v1.0.0 -->\n### Added\n\n- Entry 0 ");
  expect(block).not.toContain("- Entry 49 ");
  expect(block).toEndWith(`not listed here; see ${more}._\n<!-- /workit:changelog -->`);
  // No room even for the closing line: no block rather than an oversized body.
  expect(releaseBlock(groups, { tag: "v1.0.0", cap: 100, more })).toBe("");
});

// --- release bodies: one block, legacy markers included ------------------------------

const NEW = "<!-- workit:changelog v1.2.3 -->\n- new\n<!-- /workit:changelog -->";
const LEGACY = "<!-- workit:changelog:start -->\n- old\n<!-- workit:changelog:end -->";
const merged = (body: string, block = NEW): string => {
  const result = mergeReleaseBody(body, "v1.2.3", block);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

test("Given a body with a legacy block, When merged, Then the new block takes its place and a second merge changes nothing", () => {
  const body = `${LEGACY}\n\n## [1.2.3]\n\n* a`;
  const once = merged(body);
  expect(once).toBe(`${NEW}\n\n## [1.2.3]\n\n* a`);
  expect(merged(once)).toBe(once);
});

test("Given a body with both a legacy and a current block, When merged, Then exactly one block is left, at the first one's place", () => {
  const once = merged(`${LEGACY}\n\n## [1.2.3]\n\n${NEW.replace("new", "older")}\n\n* a`);
  expect(once).toBe(`${NEW}\n\n## [1.2.3]\n\n* a`);
  expect(once.split("workit:changelog").length - 1).toBe(2);
  expect(merged(once)).toBe(once);
});

test("Given an empty block, When merged, Then every old block is removed", () => {
  expect(merged(`${LEGACY}\n\n## [1.2.3]\n\n* a\n`, "")).toBe("## [1.2.3]\n\n* a");
});

test("Given a legacy start marker without its end, When merged, Then it is refused naming the legacy end marker", () => {
  const result = mergeReleaseBody("<!-- workit:changelog:start -->\n- old\n\n* a", "v1.2.3", NEW);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toContain("release_body_unterminated");
  expect(!result.ok && result.unblock).toContain("<!-- workit:changelog:end -->");
});
