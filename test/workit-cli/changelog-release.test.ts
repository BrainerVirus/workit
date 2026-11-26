// `workit changelog roll` and `workit changelog release <version>` against
// temp repos with real tags: a release moves [Unreleased] into its section and
// writes its notes, a rerun is byte-identical, an empty [Unreleased] releases
// nothing, and a doubled entry is refused. WORKIT_CONFIG is a temp dir and the
// global git config is empty, so the default tag prefix is the repo's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/changelog";
import { stripsWorkitKey } from "@/test/shared/helpers/env";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

const CLI = path.join(REPO_ROOT, "packages/workit-cli/src/main.ts");

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  const config = mkdtempSync(path.join(os.tmpdir(), "wk-clrel-config-"));
  dirs.push(config);
  const globalConfig = path.join(config, ".gitconfig");
  writeFileSync(globalConfig, "");
  for (const [key, value] of [
    ["WORKIT_CONFIG", config],
    ["GIT_CONFIG_GLOBAL", globalConfig],
    ["GIT_CONFIG_NOSYSTEM", "1"],
  ] as const) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const changelog = (unreleased: string, released = "") => `# Changelog

## [Unreleased]
${unreleased ? `\n${unreleased}` : ""}
${released}## [1.0.0] - 2026-01-01

### Added

- First release.
`;
const FIXED = "### Fixed\n\n- The retry loop keeps its timeout.\n- Logs name the failed step.\n";

function repo(steps: Array<{ text: string; tag?: string }>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-clrel-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        GIT_AUTHOR_DATE: "2026-02-03T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-02-03T12:00:00Z",
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", path.join(dir, ".no-hooks")],
  ])
    git("config", key, value);
  for (const step of steps) {
    writeFileSync(path.join(dir, "CHANGELOG.md"), step.text);
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "docs: changelog");
    if (step.tag) git("tag", step.tag);
  }
  return {
    dir,
    git,
    read: (file = "CHANGELOG.md") => readFileSync(path.join(dir, file), "utf8"),
  };
}

const io = (cwd: string, json = false): Io & { out: string; err: string } => {
  const state = { out: "", err: "" };
  return Object.assign(state, {
    json,
    cwd,
    env: process.env,
    stdout: (text: string) => void (state.out += text),
    stderr: (text: string) => void (state.err += text),
  });
};

const RELEASED = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-11-25

### Fixed

- The retry loop keeps its timeout.
- Logs name the failed step.

## [1.0.0] - 2026-01-01

### Added

- First release.
`;

test("Given [Unreleased] with 2 Fixed entries and tag v1.0.0 holding neither, When release 1.1.0 runs, Then [1.1.0] holds both, [Unreleased] keeps only its heading and the notes file has them", async () => {
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: changelog(FIXED) }]);
  const args = ["release", "1.1.0", "--date", "2026-11-25", "--notes-out", "n.md"];
  const first = io(r.dir);
  expect(await run(args, first)).toBe(0);
  expect(r.read()).toBe(RELEASED);
  expect(r.read("n.md")).toBe(FIXED);
  expect(first.out).toBe("CHANGELOG.md: moved 2 entries -> [1.1.0]\nnotes: n.md\n");

  // A rerun (a retried CI job) changes nothing and reads the notes back.
  writeFileSync(path.join(r.dir, "n.md"), "stale");
  const second = io(r.dir);
  expect(await run(args, second)).toBe(0);
  expect(r.read()).toBe(RELEASED);
  expect(r.read("n.md")).toBe(FIXED);
  expect(second.out).toContain("[1.1.0] is already released");
});

test("Given an empty [Unreleased], When release 1.2.0 runs, Then the file is unchanged, no [1.2.0] heading appears and the notes are empty", async () => {
  const r = repo([{ text: RELEASED, tag: "v1.1.0" }]);
  const out = io(r.dir);
  expect(await run(["release", "1.2.0", "--notes-out", "n.md"], out)).toBe(0);
  expect(r.read()).toBe(RELEASED);
  expect(r.read("n.md")).toBe("");
  expect(out.out).toContain("[Unreleased] is empty; nothing to release");
});

test("Given an entry v1.0.0's changelog holds still under [Unreleased], When roll runs, Then it moves under [1.0.0] dated by the tag and the untagged entry stays", async () => {
  const shipped = "### Added\n\n- Shipped in 1.0.0.\n";
  const r = repo([
    {
      text: changelog(shipped).replace(
        "## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n",
        "",
      ),
      tag: "v1.0.0",
    },
    {
      text: `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Shipped in 1.0.0.\n- Not released yet.\n`,
    },
  ]);
  const out = io(r.dir);
  expect(await run(["roll"], out)).toBe(0);
  expect(r.read()).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Not released yet.\n\n## [1.0.0] - 2026-02-03\n\n### Added\n\n- Shipped in 1.0.0.\n",
  );
  expect(out.out).toBe("CHANGELOG.md: moved 1 entry -> [1.0.0]\n");
});

test("Given an [Unreleased] entry also under its version's section, When roll runs, Then it exits 1, writes nothing and names the line", async () => {
  const doubled = changelog("### Added\n\n- First release.\n");
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: doubled }]);
  const out = io(r.dir);
  expect(await run(["roll"], out)).toBe(1);
  expect(r.read()).toBe(doubled);
  expect(out.err).toContain("CHANGELOG.md: not rolled.");
  expect(out.err).toContain("CHANGELOG.md:7 is already under [1.0.0]");
  // release refuses the same way, notes file included.
  expect(await run(["release", "1.1.0", "--notes-out", "n.md"], io(r.dir))).toBe(1);
  expect(existsSync(path.join(r.dir, "n.md"))).toBe(false);
});

test("Given a tagless clone, When roll runs, Then it exits 0 with nothing to roll", async () => {
  const text = changelog(FIXED);
  const r = repo([{ text }]);
  const out = io(r.dir);
  expect(await run(["roll"], out)).toBe(0);
  expect(r.read()).toBe(text);
  expect(out.out).toBe("CHANGELOG.md: no [Unreleased] entry has shipped; nothing to roll\n");
});

test("Given a gitflow version-tag prefix, When roll runs without --tag-prefix, Then the repo's prefix picks the tags", async () => {
  const shipped = "### Fixed\n\n- Shipped as rel-2.0.0.\n";
  const r = repo([{ text: changelog(shipped), tag: "rel-2.0.0" }]);
  r.git("config", "gitflow.prefix.versiontag", "rel-");
  expect(await run(["roll"], io(r.dir))).toBe(0);
  expect(r.read()).toContain(
    "## [Unreleased]\n\n## [2.0.0] - 2026-02-03\n\n### Fixed\n\n- Shipped as rel-2.0.0.\n",
  );
});

test("Given --preview or --no-write, Then nothing is written and the would-be result is reported", async () => {
  const shipped = "### Fixed\n\n- Already shipped.\n";
  const text = changelog(shipped);
  const r = repo([{ text, tag: "v1.0.0" }]);
  const preview = io(r.dir, true);
  expect(await run(["roll", "--preview"], preview)).toBe(0);
  const data = JSON.parse(preview.out).data;
  expect(data).toMatchObject({
    written: false,
    changed: true,
    moved: [{ version: "1.0.0", entries: 1 }],
  });
  expect(data.after).toContain(
    "## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n\n### Fixed\n\n- Already shipped.\n",
  );
  expect(r.read()).toBe(text);

  const notes = io(r.dir);
  expect(await run(["release", "1.1.0", "--no-write", "--notes-out", "-"], notes)).toBe(0);
  expect(notes.out).toBe("");
  expect(notes.err).toContain("would move 1 entry -> [1.0.0]");
  expect(r.read()).toBe(text);
});

test("Given a changelog with no [Unreleased] section, When roll or release runs, Then it says the section is missing, exits 0 and writes nothing", async () => {
  const text = "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n";
  const r = repo([{ text, tag: "v1.0.0" }]);
  const roll = io(r.dir);
  expect(await run(["roll"], roll)).toBe(0);
  expect(roll.out).toBe("CHANGELOG.md: no [Unreleased] section; nothing to roll\n");
  const release = io(r.dir);
  expect(await run(["release", "1.1.0", "--notes-out", "-"], release)).toBe(0);
  expect(release.out).toBe("");
  expect(release.err).toContain("CHANGELOG.md: no [Unreleased] section; nothing to release");
  expect(release.err).not.toContain("is empty");
  expect(r.read()).toBe(text);
  const json = io(r.dir, true);
  expect(await run(["release", "1.1.0", "--no-write"], json)).toBe(0);
  expect(JSON.parse(json.out).data).toMatchObject({ unreleased: false, written: false });
});

test("Given --notes-format github, Then the notes sit between the release tag's workit:changelog markers; a bad format exits 2", async () => {
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: changelog(FIXED) }]);
  const out = io(r.dir);
  const args = ["release", "1.1.0", "--no-write", "--notes-out", "-", "--notes-format", "github"];
  expect(await run(args, out)).toBe(0);
  expect(out.out).toBe(
    `<!-- workit:changelog v1.1.0 -->\n${FIXED.trim()}\n<!-- /workit:changelog -->\n`,
  );
  expect(await run(["release", "1.1.0", "--notes-format", "html"], io(r.dir))).toBe(2);
  expect(r.read()).toBe(changelog(FIXED));
});

test("Given --notes-out -, Then the notes alone go to stdout", async () => {
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: changelog(FIXED) }]);
  const out = io(r.dir);
  expect(await run(["release", "1.1.0", "--date", "2026-11-25", "--notes-out", "-"], out)).toBe(0);
  expect(out.out).toBe(FIXED);
  expect(out.err).toContain("moved 2 entries -> [1.1.0]");
});

test("Given a bad version, date or a stray argument, Then release exits 2 and writes nothing", async () => {
  const text = changelog(FIXED);
  const r = repo([{ text }]);
  for (const args of [
    ["release", "v1.1.0"],
    ["release", "1.1"],
    ["release", "1.1.0", "--date", "2026-02-30"],
    ["release", "1.1.0", "--date", "25-11-2026"],
    ["release", "1.1.0", "1.2.0"],
    ["release"],
    ["roll", "extra"],
  ]) {
    expect(await run(args, io(r.dir)), args.join(" ")).toBe(2);
    expect(r.read()).toBe(text);
  }
  expect(await run(["release", "1.1.0", "--notes-out", "-"], io(r.dir, true))).toBe(2);
});

test("Given a tagless changelog in a package directory, When release runs with --path from the root, Then that file is released with a warning to fetch the tags", async () => {
  const r = repo([]);
  const out = io(r.dir);
  mkdirSync(path.join(r.dir, "pkg"));
  writeFileSync(path.join(r.dir, "pkg", "CHANGELOG.md"), changelog(FIXED));
  expect(
    await run(
      [
        "release",
        "1.1.0",
        "--date",
        "2026-11-25",
        "--path",
        "pkg/CHANGELOG.md",
        "--tag-prefix",
        "pkg-v",
      ],
      out,
    ),
  ).toBe(0);
  expect(r.read("pkg/CHANGELOG.md")).toBe(RELEASED);
  expect(out.err).toContain("workit: warning: no pkg-v<x.y.z> tags here");
  expect(out.err).toContain("fetch-depth: 0");
});

test("Given the installed command line, When `changelog release` runs in a pipeline shell, Then it releases with exit 0 and a bad version exits 2", () => {
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: changelog(FIXED) }]);
  const home = path.join(r.dir, ".home");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const [key, value] of Object.entries(process.env))
    if (!stripsWorkitKey(key) && !key.startsWith("XDG_")) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
  const cli = (...args: string[]) =>
    spawnSync("bun", [CLI, "changelog", ...args], {
      cwd: r.dir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
  const done = cli("release", "1.1.0", "--date", "2026-11-25", "--notes-out", "n.md");
  expect(done.status, done.stderr).toBe(0);
  expect(r.read()).toBe(RELEASED);
  expect(r.read("n.md")).toBe(FIXED);
  expect(cli("release", "1.1").status).toBe(2);
});

// `changelog apply` rolls first: the shipped entries move with the new one.
const SHIPPED_TAGGED = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Shipped in 1.0.0.\n`;
const SHIPPED_ON_MAIN = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Shipped in 1.0.0.\n- Not released yet.\n`;
const ADD_FIXED = ["apply", "--entries", '{"Fixed": ["The new fix."]}'];

test("Given one shipped and one unreleased entry, When apply adds an entry, Then the shipped one moves under [1.0.0], the others stay in [Unreleased] and the output counts the move", async () => {
  const r = repo([{ text: SHIPPED_TAGGED, tag: "v1.0.0" }, { text: SHIPPED_ON_MAIN }]);
  const out = io(r.dir);
  expect(await run(ADD_FIXED, out)).toBe(0);
  expect(r.read()).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Not released yet.\n\n### Fixed\n\n- The new fix.\n\n## [1.0.0] - 2026-02-03\n\n### Added\n\n- Shipped in 1.0.0.\n",
  );
  expect(out.out).toContain("(moved 1 shipped entry from [Unreleased] into [1.0.0])");
  expect(out.err).toBe("");
  const json = io(r.dir, true);
  r.git("checkout", "--", "CHANGELOG.md");
  expect(await run([...ADD_FIXED, "--preview"], json)).toBe(0);
  expect(JSON.parse(json.out).data.rolled).toEqual({
    moved: [{ version: "1.0.0", entries: 1 }],
    entries: 1,
  });
  expect(r.read()).toBe(SHIPPED_ON_MAIN);
});

test("Given no release tags, or a shallow clone, When apply adds an entry, Then nothing moves and nothing warns", async () => {
  const tagless = repo([{ text: SHIPPED_ON_MAIN }]);
  const out = io(tagless.dir);
  expect(await run(ADD_FIXED, out)).toBe(0);
  expect(tagless.read()).toBe(`${SHIPPED_ON_MAIN}### Fixed\n\n- The new fix.\n`);
  expect(out.out).toBe(`changelog updated: ${realpathSync(tagless.dir)}/CHANGELOG.md\n`);
  expect(out.err).toBe("");

  const tagged = repo([{ text: SHIPPED_TAGGED, tag: "v1.0.0" }, { text: SHIPPED_ON_MAIN }]);
  const shallow = mkdtempSync(path.join(os.tmpdir(), "wk-clrel-shallow-"));
  dirs.push(shallow);
  const cloned = spawnSync(
    "git",
    ["clone", "-q", "--depth", "1", `file://${tagged.dir}`, shallow],
    { encoding: "utf8" },
  );
  expect(cloned.status).toBe(0);
  const shallowOut = io(shallow);
  expect(await run(ADD_FIXED, shallowOut)).toBe(0);
  expect(readFileSync(path.join(shallow, "CHANGELOG.md"), "utf8")).toContain(
    "## [Unreleased]\n\n### Added\n\n- Shipped in 1.0.0.\n- Not released yet.\n",
  );
  expect(shallowOut.err).toBe("");
});

test("Given an [Unreleased] entry also under its release, When apply adds an entry, Then it warns with the fix and still adds the entry", async () => {
  const doubled = changelog("### Added\n\n- First release.\n");
  const r = repo([{ text: changelog(""), tag: "v1.0.0" }, { text: doubled }]);
  const out = io(r.dir);
  expect(await run(ADD_FIXED, out)).toBe(0);
  expect(r.read()).toContain(
    "## [Unreleased]\n\n### Added\n\n- First release.\n\n### Fixed\n\n- The new fix.\n",
  );
  expect(out.err).toContain(
    "workit: warning: CHANGELOG.md: the shipped [Unreleased] entries were not moved",
  );
  expect(out.err).toContain("Run workit changelog roll");
  expect(out.out).not.toContain("moved");
});

test.skipIf(process.platform === "win32")(
  "Given a CRLF changelog with mode 0640 and a shipped entry, When apply adds an entry, Then it is replaced by a rename that keeps the mode and CRLF and leaves no temp file",
  async () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const r = repo([
      { text: crlf(SHIPPED_TAGGED), tag: "v1.0.0" },
      { text: crlf(SHIPPED_ON_MAIN) },
    ]);
    const file = path.join(r.dir, "CHANGELOG.md");
    chmodSync(file, 0o640);
    const inode = statSync(file).ino;
    expect(await run(ADD_FIXED, io(r.dir))).toBe(0);
    expect(r.read()).toBe(
      crlf(
        "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Not released yet.\n\n### Fixed\n\n- The new fix.\n\n## [1.0.0] - 2026-02-03\n\n### Added\n\n- Shipped in 1.0.0.\n",
      ),
    );
    expect(statSync(file).mode & 0o777).toBe(0o640);
    // A new inode: the file was renamed into place, never truncated and rewritten.
    expect(statSync(file).ino).not.toBe(inode);
    expect(readdirSync(r.dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "Given CHANGELOG.md is a symlink, or a new changelog under a symlinked directory, When apply adds an entry, Then the real file is written and the links stay",
  async () => {
    const r = repo([{ text: SHIPPED_ON_MAIN }]);
    const real = path.join(r.dir, "docs-CHANGELOG.md");
    writeFileSync(real, SHIPPED_ON_MAIN);
    rmSync(path.join(r.dir, "CHANGELOG.md"));
    symlinkSync("docs-CHANGELOG.md", path.join(r.dir, "CHANGELOG.md"));
    expect(await run(ADD_FIXED, io(r.dir))).toBe(0);
    expect(readFileSync(real, "utf8")).toBe(`${SHIPPED_ON_MAIN}### Fixed\n\n- The new fix.\n`);

    mkdirSync(path.join(r.dir, "real-docs"));
    symlinkSync("real-docs", path.join(r.dir, "docs"));
    expect(await run([...ADD_FIXED, "--path", "docs/notes/CHANGELOG.md"], io(r.dir))).toBe(0);
    expect(readFileSync(path.join(r.dir, "real-docs/notes/CHANGELOG.md"), "utf8")).toContain(
      "## [Unreleased]\n\n### Fixed\n\n- The new fix.\n",
    );
  },
);
