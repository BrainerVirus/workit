// #889: `workit doctor` warns (`changelog_released`) when CHANGELOG.md's
// [Unreleased] holds entries a release tag already shipped, naming how many,
// the oldest release and `workit changelog roll`; a repo without tags, a
// shallow clone or one without a changelog gets no row. Temp repos, an empty
// global git config and a throwaway HOME.
import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { stripsWorkitKey } from "@/test/shared/helpers/env";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

setDefaultTimeout(60_000);

const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-changelog-released-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const globalConfig = path.join(scratch, ".gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", globalConfig],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["WORKIT_CONFIG", path.join(scratch, "config")],
  ] as const) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const changelog = (entries: string[]): string =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${entries.join("\n")}\n`;
const ONE = "- One: shipped in 1.0.0.";
const TWO = "- Two: shipped in 1.1.0.";
const FRESH = "- Fresh: not released yet.";

let count = 0;
/** A repo whose CHANGELOG.md held each step's entries at its tag, then `now` uncommitted. */
function repo(
  steps: Array<{ entries: string[]; tag: string; text?: string }>,
  now: string | null,
): string {
  const base = path.join(scratch, `case-${count++}`);
  const dir = path.join(base, "repo");
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "core.hooksPath", path.join(base, "no-hooks"));
  writeFileSync(path.join(dir, "README.md"), "# r\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  for (const step of steps) {
    writeFileSync(path.join(dir, "CHANGELOG.md"), step.text ?? changelog(step.entries));
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "docs: changelog");
    git("tag", step.tag);
  }
  if (now !== null) writeFileSync(path.join(dir, "CHANGELOG.md"), now);
  return dir;
}

const check = (dir: string) => {
  const base = path.dirname(dir);
  return runDoctor({
    host: "cli",
    cwd: dir,
    home: base,
    configDir: path.join(base, "config"),
    stateDir: path.join(base, "state"),
    env: { PATH: process.env.PATH ?? "", WORKIT_CONFIG: path.join(base, "config") },
  }).checks.find((c) => c.id === "changelog_released");
};

const SHIPPED = [
  { entries: [ONE], tag: "v1.0.0" },
  { entries: [ONE, TWO], tag: "v1.1.0" },
];

test("Given two [Unreleased] entries v1.0.0 and v1.1.0 already shipped, When doctor runs, Then changelog_released warns with the count, the oldest tag and the roll command", () => {
  const found = check(repo(SHIPPED, changelog([FRESH, ONE, TWO])));
  expect(found).toEqual({
    id: "changelog_released",
    status: "warn",
    detail: "2 [Unreleased] entries already shipped (oldest in v1.0.0)",
    fix: "workit changelog roll",
  });
});

test("Given old v14 tags beside workit-dev-v2 tags and 2.x headings, When doctor runs with no prefix configured, Then it infers workit-dev-v and warns about the entries those tags shipped", () => {
  const released = (entries: string[]) =>
    `${changelog(entries)}\n## [2.0.0] - 2026-01-01\n\n### Added\n\n- Zero.\n`;
  const dir = repo(
    [
      { entries: [], tag: "v14.0.0", text: "# Changelog\n\n## [14.0.0]\n\n- Old scope.\n" },
      { entries: [], tag: "v2.1.0", text: "# Changelog\n\n## [2.1.0]\n\n- Old scope 2.1.\n" },
      { entries: [], tag: "workit-dev-v2.0.0", text: released([]) },
      { entries: [], tag: "workit-dev-v2.1.0", text: released([ONE]) },
      { entries: [], tag: "workit-dev-v2.2.0", text: released([ONE, TWO]) },
    ],
    `${changelog([FRESH, ONE, TWO])}\n## [2.1.0] - 2026-01-02\n\n### Added\n\n- Earlier.\n\n## [2.0.0] - 2026-01-01\n\n### Added\n\n- Zero.\n`,
  );
  expect(check(dir)).toMatchObject({
    status: "warn",
    detail: "2 [Unreleased] entries already shipped (oldest in workit-dev-v2.1.0)",
  });
});

test("Given only unreleased entries, When doctor runs, Then changelog_released passes", () => {
  expect(check(repo(SHIPPED, changelog([FRESH])))?.status).toBe("pass");
});

test("Given a repo without release tags, When doctor runs, Then there is no changelog_released row", () => {
  const dir = repo([], changelog([FRESH, ONE]));
  expect(check(dir)).toBeUndefined();
});

test("Given a shallow clone, When doctor runs, Then there is no changelog_released row", () => {
  const dir = repo(SHIPPED, changelog([ONE]));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout;
  // What `git clone --depth 1` leaves: the cut-off commits listed in .git/shallow.
  writeFileSync(path.join(dir, ".git", "shallow"), head);
  expect(check(dir)).toBeUndefined();
});

test("Given no CHANGELOG.md, When doctor runs, Then there is no changelog_released row", () => {
  const dir = repo(SHIPPED, null);
  rmSync(path.join(dir, "CHANGELOG.md"));
  expect(check(dir)).toBeUndefined();
});

test("Given shipped entries, When `workit doctor --json` runs, Then its checks hold the changelog_released warning with the count", () => {
  const dir = repo(SHIPPED, changelog([ONE, TWO]));
  const home = path.join(path.dirname(dir), ".home");
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
    WORKIT_CONFIG: path.join(home, ".config", "workit"),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const run = spawnSync(
    "bun",
    [path.join(REPO_ROOT, "packages/workit-cli/src/main.ts"), "doctor", "--json"],
    { cwd: dir, encoding: "utf8", env, timeout: 60_000 },
  );
  const report = JSON.parse(run.stdout) as {
    checks: Array<{ id: string; status: string; detail: string; fix?: string }>;
  };
  expect(report.checks.find((c) => c.id === "changelog_released")).toEqual({
    id: "changelog_released",
    status: "warn",
    detail: "2 [Unreleased] entries already shipped (oldest in v1.0.0)",
    fix: "workit changelog roll",
  });
});
