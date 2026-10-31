import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changelogGate,
  nonUserFacingType,
  resolveChangelogPaths,
  unreleasedBullets,
} from "@/packages/workit-core/src/core/changelog-gate";

// The opt-in changelog gate `workit pr create` runs: a user-facing PR needs a
// bullet its branch adds under ## [Unreleased], compared with the PR base.

// Each repo() spawns about a dozen git processes; one slow spawn on a Windows runner can pass 15 s.
if (process.platform === "win32") setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const RELEASED = `# Changelog

## [Unreleased]

### Added

- Older unreleased thing

## [1.0.0] - 2026-01-01

### Added

- First release
`;

/**
 * A repo on main (with `baseChangelog`, if any, at `file`), then feature/x
 * checked out with one more commit.
 */
const repo = (
  baseChangelog: string | null,
  branchChangelog?: string | null,
  file = "CHANGELOG.md",
) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-changelog-gate-"));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.test");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(cwd, "a.txt"), "a\n");
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  if (baseChangelog !== null) writeFileSync(path.join(cwd, file), baseChangelog);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  // A bare origin the gate fetches the base from, as a real checkout has.
  git(cwd, "init", "-q", "--bare", path.join(cwd, ".origin.git"));
  git(cwd, "remote", "add", "origin", path.join(cwd, ".origin.git"));
  git(cwd, "push", "-q", "origin", "main");
  git(cwd, "switch", "-q", "-c", "feature/x");
  writeFileSync(path.join(cwd, "b.txt"), "b\n");
  if (branchChangelog) writeFileSync(path.join(cwd, file), branchChangelog);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "change");
  return cwd;
};

const withEntry = (text: string) =>
  text.replace("- Older unreleased thing\n", "- Older unreleased thing\n- You can now x\n");

const gate = (cwd: string, mode: "off" | "update" | "create", title = "feat: x", skip?: string) =>
  changelogGate({ cwd, mode, title, base: "main", skipReason: skip ?? null });

test("Given the gate is off, When a feat PR adds no entry, Then it passes untouched", () => {
  expect(gate(repo(RELEASED), "off")).toEqual({ status: "off" });
});

test("Given changelog create and no CHANGELOG.md, When a feat PR adds none, Then the entry is required with the apply command", () => {
  expect(gate(repo(null), "create")).toEqual({
    status: "missing",
    mode: "create",
    file: "CHANGELOG.md",
    category: "Added",
    command: `workit changelog apply --entries '{"Added": ["<what users can now do>"]}'`,
    candidates: [],
    looked: ["CHANGELOG.md"],
  });
});

test("Given changelog update and no CHANGELOG.md, When a fix PR runs, Then there is nothing to update", () => {
  expect(gate(repo(null), "update", "fix: y")).toEqual({
    status: "no-file",
    mode: "update",
    paths: ["CHANGELOG.md"],
    candidates: [],
  });
});

test("Given an existing CHANGELOG.md, When the branch only keeps the Unreleased entries it inherited, Then a fix PR still needs its own", () => {
  const result = gate(repo(RELEASED), "update", "fix(cli): y");
  expect(result.status).toBe("missing");
  expect(result).toMatchObject({ category: "Fixed" });
});

test("Given the branch adds a bullet under Unreleased, When the gate runs, Then it passes and names the new bullet only", () => {
  const added = RELEASED.replace(
    "- Older unreleased thing\n",
    "- Older unreleased thing\n- You can now skip the gate with a reason\n",
  );
  expect(gate(repo(RELEASED, added), "update")).toEqual({
    status: "has-entry",
    mode: "update",
    file: "CHANGELOG.md",
    added: ["You can now skip the gate with a reason"],
  });
});

test("Given the branch adds a bullet only to a released section, When the gate runs, Then it is not an Unreleased entry", () => {
  const released = RELEASED.replace("- First release\n", "- First release\n- Sneaked in\n");
  expect(gate(repo(RELEASED, released), "create").status).toBe("missing");
});

test("Given changelog create, When the branch creates CHANGELOG.md with an Unreleased bullet, Then it passes", () => {
  const created = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Brand new\n";
  expect(gate(repo(null, created), "create")).toEqual({
    status: "has-entry",
    mode: "create",
    file: "CHANGELOG.md",
    added: ["Brand new"],
  });
});

test("Given a non-user-facing title, When the gate is on, Then it passes without an entry", () => {
  for (const title of ["chore: x", "test(core): x", "docs: x", "ci: x", "build: x", "style: x"])
    expect(gate(repo(RELEASED), "create", title).status, title).toBe("not-user-facing");
});

test("Given a breaking chore or a non-conventional title, When the gate is on, Then it counts as user-facing", () => {
  expect(nonUserFacingType("chore!: drop node 20")).toBeNull();
  expect(nonUserFacingType("Update things")).toBeNull();
  expect(nonUserFacingType("refactor: x")).toBeNull();
  expect(nonUserFacingType("docs(readme): x")).toBe("docs");
});

test("Given --no-changelog with a reason, When the gate is on, Then it passes and carries the reason", () => {
  expect(gate(repo(RELEASED), "create", "feat: x", "internal flag only")).toEqual({
    status: "skipped",
    mode: "create",
    reason: "internal flag only",
  });
});

test("Given a base neither the remote nor the checkout has, When the gate runs, Then it reports base-unknown with the fetch error, so pr create blocks", () => {
  const cwd = repo(RELEASED);
  expect(changelogGate({ cwd, mode: "update", title: "feat: x", base: "nope" })).toMatchObject({
    status: "base-unknown",
    mode: "update",
    base: "nope",
    remote: "origin",
  });
});

test("Given a stale local base, When the base remote has moved and added bullets the branch merged in, Then the gate fetches the base first and counts only the branch's own bullet", () => {
  const upstream = repo(RELEASED);
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-changelog-clone-"));
  dirs.push(cwd);
  git(cwd, "clone", "-q", "-b", "main", upstream, ".");
  git(cwd, "config", "user.email", "t@example.test");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  // Upstream main gains a bullet after the clone; the clone's origin/main is now stale.
  git(upstream, "switch", "-q", "main");
  writeFileSync(path.join(upstream, "CHANGELOG.md"), withEntry(RELEASED));
  git(upstream, "commit", "-qam", "upstream entry");
  // The branch merges upstream main by hand (fetching into FETCH_HEAD only), adding no bullet of its own.
  git(cwd, "switch", "-q", "-c", "feature/y");
  git(cwd, "pull", "-q", "--no-rebase", "--no-edit", upstream, "main");
  const result = changelogGate({
    cwd,
    mode: "update",
    title: "feat: y",
    base: "main",
    baseRemote: "origin",
  });
  expect(result.status).toBe("missing");
});

test("Given changelog update and a branch that deletes the changelog, When the gate runs, Then it is refused, not treated as nothing to update", () => {
  const cwd = repo(RELEASED);
  git(cwd, "rm", "-q", "CHANGELOG.md");
  git(cwd, "commit", "-qm", "drop changelog");
  expect(gate(cwd, "update")).toMatchObject({ status: "missing", file: "CHANGELOG.md" });
});

test("Given a changelog text, When its Unreleased bullets are read, Then released sections are left out", () => {
  expect(unreleasedBullets(RELEASED)).toEqual(["Older unreleased thing"]);
  expect(unreleasedBullets("# Changelog\n\n## [Unreleased]\n\n* last line")).toEqual(["last line"]);
  expect(unreleasedBullets("# Changelog\n")).toEqual([]);
});

test("Given changelogPath docs/CHANGELOG.md, When the branch adds an entry there, Then it passes; without one, the apply command names --path", () => {
  const paths = ["docs/CHANGELOG.md"];
  const run = (cwd: string) =>
    changelogGate({
      cwd,
      mode: "update",
      title: "feat: x",
      base: "main",
      paths,
      pathConfigured: true,
    });
  expect(run(repo(RELEASED, withEntry(RELEASED), "docs/CHANGELOG.md"))).toMatchObject({
    status: "has-entry",
    file: "docs/CHANGELOG.md",
  });
  expect(run(repo(RELEASED, null, "docs/CHANGELOG.md"))).toMatchObject({
    status: "missing",
    file: "docs/CHANGELOG.md",
    command: `workit changelog apply --entries '{"Added": ["<what users can now do>"]}' --path docs/CHANGELOG.md`,
  });
});

test("Given a monorepo list of changelogs, When the branch adds an entry to any one of them, Then it passes", () => {
  const cwd = repo(RELEASED, withEntry(RELEASED), "packages/b/CHANGELOG.md");
  const result = changelogGate({
    cwd,
    mode: "update",
    title: "fix: y",
    base: "main",
    paths: ["packages/a/CHANGELOG.md", "packages/b/CHANGELOG.md"],
    pathConfigured: true,
  });
  expect(result).toMatchObject({ status: "has-entry", file: "packages/b/CHANGELOG.md" });
});

test("Given no changelogPath and no root CHANGELOG.md, When the repo keeps one elsewhere, Then the result names it so the setting can point there", () => {
  const cwd = repo(RELEASED, null, "docs/CHANGELOG.md");
  expect(gate(cwd, "update")).toMatchObject({
    status: "no-file",
    candidates: ["docs/CHANGELOG.md"],
  });
  expect(gate(cwd, "create")).toMatchObject({
    status: "missing",
    file: "CHANGELOG.md",
    candidates: ["docs/CHANGELOG.md"],
  });
});

const globOnly = (cwd: string, mode: "update" | "create") =>
  changelogGate({
    cwd,
    mode,
    title: "feat: x",
    base: "main",
    paths: ["projects/*/CHANGELOG.md"],
    pathConfigured: true,
  });

test("Given a glob-only changelogPath that matches no file and no root CHANGELOG.md, When the gate runs, Then create requires the root file and update has nothing to update", () => {
  const cwd = repo(null);
  expect(globOnly(cwd, "create")).toMatchObject({ status: "missing", file: "CHANGELOG.md" });
  expect(globOnly(cwd, "update")).toMatchObject({ status: "no-file" });
});

test("Given a glob-only changelogPath that matches no file, When the branch adds an entry to the root CHANGELOG.md, Then the root entry counts", () => {
  const cwd = repo(RELEASED, withEntry(RELEASED));
  expect(globOnly(cwd, "update")).toMatchObject({ status: "has-entry", file: "CHANGELOG.md" });
  expect(resolveChangelogPaths(cwd, ["projects/*/CHANGELOG.md"])).toEqual(["CHANGELOG.md"]);
});

test("Given the base cannot be fetched but an older local copy resolves, When the gate runs, Then it compares with that copy and says the fetch failed", () => {
  const cwd = repo(RELEASED, withEntry(RELEASED));
  git(cwd, "remote", "remove", "origin");
  const result = gate(cwd, "update");
  expect(result.status).toBe("has-entry");
  expect(result).toHaveProperty("staleBase", expect.stringMatching(/\S/u));
  // With the remote back, the fetch succeeds and the note goes away.
  const fresh = repo(RELEASED, withEntry(RELEASED));
  expect(gate(fresh, "update")).not.toHaveProperty("staleBase");
});

/**
 * A monorepo on main with a root index changelog (no Unreleased) and
 * per-package changelogs under projects/, then feature/x writing `files`.
 */
const monorepo = (files: Record<string, string>) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-changelog-mono-"));
  dirs.push(cwd);
  const origin = mkdtempSync(path.join(os.tmpdir(), "wk-changelog-mono-origin-"));
  dirs.push(origin);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.test");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(
    path.join(cwd, "CHANGELOG.md"),
    "# Changelog\n\nSee each package's CHANGELOG.md.\n",
  );
  writeFileSync(path.join(cwd, "b.txt"), "b\n");
  for (const name of ["a", "b"]) {
    mkdirSync(path.join(cwd, "projects", name), { recursive: true });
    writeFileSync(path.join(cwd, "projects", name, "CHANGELOG.md"), RELEASED);
    writeFileSync(path.join(cwd, "projects", name, "index.ts"), "export {};\n");
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(origin, "init", "-q", "--bare");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-q", "origin", "main");
  git(cwd, "switch", "-q", "-c", "feature/x");
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "packages change");
  return cwd;
};

const globGate = (cwd: string, paths = ["projects/*/CHANGELOG.md"]) =>
  changelogGate({
    cwd,
    mode: "update",
    title: "feat: x",
    base: "main",
    paths,
    pathConfigured: true,
  });

test("Given changelogPath projects/*/CHANGELOG.md and a root index without Unreleased, When the branch adds an entry to projects/a, Then it passes and names projects/a/CHANGELOG.md", () => {
  const cwd = monorepo({
    "projects/a/index.ts": "export const a = 1;\n",
    "projects/a/CHANGELOG.md": withEntry(RELEASED),
  });
  expect(globGate(cwd)).toEqual({
    status: "has-entry",
    mode: "update",
    file: "projects/a/CHANGELOG.md",
    added: ["You can now x"],
  });
});

test("Given per-package changelogs, When the diff touches projects/a and projects/b but only projects/a gains an entry, Then it is missing and names projects/b/CHANGELOG.md", () => {
  const cwd = monorepo({
    "projects/a/index.ts": "export const a = 1;\n",
    "projects/b/index.ts": "export const b = 1;\n",
    "projects/a/CHANGELOG.md": withEntry(RELEASED),
  });
  expect(globGate(cwd)).toMatchObject({
    status: "missing",
    file: "projects/b/CHANGELOG.md",
    lacking: ["projects/b/CHANGELOG.md"],
    command: `workit changelog apply --entries '{"Added": ["<what users can now do>"]}' --path projects/b/CHANGELOG.md`,
  });
});

test("Given per-package changelogs, When both touched packages gain an entry, Then it passes and lists both files", () => {
  const cwd = monorepo({
    "projects/a/CHANGELOG.md": withEntry(RELEASED),
    "projects/b/CHANGELOG.md": withEntry(RELEASED),
  });
  expect(globGate(cwd)).toMatchObject({
    status: "has-entry",
    files: ["projects/a/CHANGELOG.md", "projects/b/CHANGELOG.md"],
  });
});

test("Given per-package changelogs, When the diff touches no package and adds no entry, Then it is missing and names every file it read", () => {
  const cwd = monorepo({ "b.txt": "changed\n" });
  const result = globGate(cwd, ["CHANGELOG.md", "projects/*/CHANGELOG.md"]);
  expect(result).toMatchObject({
    status: "missing",
    file: "CHANGELOG.md",
    looked: ["CHANGELOG.md", "projects/a/CHANGELOG.md", "projects/b/CHANGELOG.md"],
  });
  expect(result).not.toHaveProperty("lacking");
});

test("Given a ** glob, When the changelog paths resolve, Then each matched tracked file is listed once, and globs matching nothing mean the root file", () => {
  const cwd = monorepo({});
  expect(resolveChangelogPaths(cwd, ["**/CHANGELOG.md", "projects/a/CHANGELOG.md"])).toEqual([
    "CHANGELOG.md",
    "projects/a/CHANGELOG.md",
    "projects/b/CHANGELOG.md",
  ]);
  expect(resolveChangelogPaths(cwd, ["projects/?/CHANGELOG.md"])).toHaveLength(2);
  expect(resolveChangelogPaths(cwd, ["projects/*.md"])).toEqual(["CHANGELOG.md"]);
});
