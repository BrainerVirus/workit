// CHANGELOG.md entries in GitHub release notes: the release's generateNotes and
// prepare commands (release.config.cjs, `workit changelog release` from source)
// and the backfill of published releases, against a temp repo with real tags
// and a fake `gh`. The roll itself is core's (test/workit-core/changelog-roll.test.ts).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { runChangelogRoll } from "@/packages/workit-core/src/core/changelog-roll";
import {
  GITHUB_BODY_LIMIT,
  backfillChangelogNotes,
  releaseNotes,
} from "@/scripts/backfill-release-notes";
import { stripsWorkitKey } from "@/test/shared/helpers/env";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

const START = (version: string) => `<!-- workit:changelog workit-dev-v${version} -->`;
const END = "<!-- /workit:changelog -->";

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

/** The command release.config.cjs runs for `step`, run in `cwd` with a throwaway HOME. */
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
  const home = path.join(cwd, "..", ".home");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!stripsWorkitKey(key) && !key.startsWith("XDG_")) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".state"),
    XDG_DATA_HOME: path.join(home, ".data"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GIT_CONFIG_GLOBAL: path.join(cwd, "..", ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const run = spawnSync(bin, [path.join(REPO_ROOT, script), ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  if (run.status !== 0) throw new Error(`${step}: ${run.stderr}`);
  return run.stdout;
}

/** What @semantic-release/github receives: each generateNotes output, joined like semantic-release does. */
async function releaseBody(cwd: string, version: string): Promise<string> {
  const changelogNotes = releaseStep(cwd, "generateNotesCmd", version).trim();
  const commitNotes = await releaseNotes(REPO_ROOT, {
    commits: [{ hash: "a".repeat(40), message: "feat(cli): add gamma (#12)" }],
    lastRelease: { gitTag: "workit-dev-v2.11.0" },
    nextRelease: { version, gitTag: `workit-dev-v${version}` },
    options: { repositoryUrl: "https://github.com/acme/widget" },
  });
  return [changelogNotes, commitNotes].filter(Boolean).join("\n\n");
}

test("Given [Unreleased] entries and release 2.12.0, When the release's generateNotes and prepare commands run, Then CHANGELOG.md gets [2.12.0] with them, [Unreleased] is empty and the body starts with them before the PR-title list", async () => {
  const repo = makeRepo(HISTORY);
  const body = await releaseBody(repo.cwd, "2.12.0");
  expect(body.startsWith(`${START("2.12.0")}\n### Added\n\n${GAMMA}\n${END}\n\n## [2.12.0](`)).toBe(
    true,
  );
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
  runChangelogRoll({ cwd: repo.cwd, tagPrefix: "workit-dev-v", write: true, exec: repo.exec });
  const rolled = repo.read();
  expect(rolled).toContain("## [Unreleased]\n\n## [2.11.0] - 2026-03-01");

  const body = await releaseBody(repo.cwd, "2.12.0");
  expect(body.startsWith("## [2.12.0](")).toBe(true);
  expect(body).not.toContain("workit:changelog");
  releaseStep(repo.cwd, "prepareCmd", "2.12.0");
  expect(repo.read()).toBe(rolled);
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
    // Cut by the release script before `workit changelog release`: a legacy block.
    "workit-dev-v2.10.0": `<!-- workit:changelog:start -->\n- stale\n<!-- workit:changelog:end -->\n\n${PR_LIST("2.10.0", "2.9.0")}`,
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
    `${START("2.11.0")}\n### Fixed\n\n${BETA}\n${END}\n\n${PR_LIST("2.11.0", "2.10.0").trim()}`,
  );
  expect(bodies["workit-dev-v2.10.0"]).toBe(
    `${START("2.10.0")}\n### Added\n\n${ALPHA_REWRAPPED}\n${END}\n\n${PR_LIST("2.10.0", "2.9.0").trim()}`,
  );

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

test("Given `--changelog --dry-run` on the command line, Then it prints the summary and never calls gh release edit", () => {
  const repo = makeRepo(HISTORY);
  const bin = path.join(repo.cwd, "..", "bin");
  mkdirSync(bin);
  const edits = path.join(repo.cwd, "..", "edits.log");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\nif [ "$2" = view ]; then printf '## [x]\\n\\n* a (#1)\\n'; exit 0; fi\necho "$@" >> "${edits}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const run = spawnSync(
    "bun",
    [path.join(REPO_ROOT, "scripts/backfill-release-notes.ts"), "--changelog", "--dry-run"],
    {
      cwd: repo.cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(
    "workit-dev-v2.10.0: would update, 1 changelog entry (body 16 -> 160 chars)",
  );
  expect(run.stdout).toContain("dry run: 2 release(s) to update, 0 unchanged");
  expect(() => readFileSync(edits, "utf8")).toThrow();
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

// --- dry-run parity with the retired scripts/roll-changelog.ts ----------------------

const LEGACY_START = "<!-- workit:changelog:start -->";
const LEGACY_END = "<!-- workit:changelog:end -->";
const ENTRIES = Array.from(
  { length: 400 },
  (_, i) => `- Entry ${i}: ${"z".repeat(40 + ((i * 37) % 90))}\n  continued ${i}.`,
);
const NO_LINKS = (text: string) => text.replace(/\n\[Unreleased\]:[^]*$/, "");
const PARITY: Record<string, { history: Array<{ text: string; tag?: string }>; sha256: string }> = {
  // sha256 of `bun scripts/roll-changelog.ts --notes 2.12.0` on each fixture,
  // recorded before the script was deleted (#889).
  entries: {
    history: [
      { text: changelog([ALPHA], []), tag: "workit-dev-v2.10.0" },
      { text: changelog([ALPHA], [BETA]), tag: "workit-dev-v2.11.0" },
      { text: changelog([GAMMA, ALPHA_REWRAPPED], [BETA, "- Delta: two\n  lines."]) },
    ],
    sha256: "fdbed2d5676910b35e846c913777afc20e985792034b2c52dd3a7fae791e6407",
  },
  "no compare links": {
    history: [
      { text: NO_LINKS(changelog([ALPHA], [])), tag: "workit-dev-v2.11.0" },
      { text: NO_LINKS(changelog([GAMMA, ALPHA], [])) },
    ],
    sha256: "6d6b07da74e2a49d09c7a9785e900ff016b67376683a2c87973116ac59937b92",
  },
  "cut at 24,000 characters": {
    history: [
      { text: changelog([ALPHA], []), tag: "workit-dev-v2.11.0" },
      {
        text: changelog([GAMMA, ...ENTRIES.slice(0, 200), ALPHA], ENTRIES.slice(200)),
      },
    ],
    sha256: "321bf2bb3a20442cac44df769b33dffc0638797c030d1013f92ab2943c96892f",
  },
  "first release, cut": {
    history: [{ text: changelog(ENTRIES.slice(0, 300), []) }],
    sha256: "8d5d0e4486f0fb0d1a99b7d792b22fd188d716f7a7cd43189f9250d24e233036",
  },
};

for (const [name, fixture] of Object.entries(PARITY))
  test(`Given ${name}, When the release's generateNotesCmd runs, Then its notes are byte-identical to the old script's once the marker lines are mapped back`, () => {
    const repo = makeRepo(fixture.history.map((step) => ({ ...step, date: "2026-02-03" })));
    const notes = releaseStep(repo.cwd, "generateNotesCmd", "2.12.0");
    const lines = notes.split("\n");
    expect(lines[0]).toBe(START("2.12.0"));
    expect(lines.at(-2)).toBe(END);
    const legacy = [LEGACY_START, ...lines.slice(1, -2), LEGACY_END, ""].join("\n");
    expect(createHash("sha256").update(legacy).digest("hex")).toBe(fixture.sha256);
    expect(notes.length).toBeLessThanOrEqual(24_001);
  });

test("Given no entries for the release, When generateNotesCmd runs, Then it prints nothing, like the old script", () => {
  const repo = makeRepo(HISTORY.slice(0, 2));
  expect(releaseStep(repo.cwd, "generateNotesCmd", "2.12.0")).toBe("");
});
