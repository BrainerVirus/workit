import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changelogGate,
  nonUserFacingType,
  unreleasedBullets,
} from "@/packages/workit-core/src/core/changelog-gate";

// The opt-in changelog gate `workit pr create` runs: a user-facing PR needs a
// bullet its branch adds under ## [Unreleased], compared with the PR base.

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

/** A repo on main (with `baseChangelog`, if any), then feature/x checked out with one more commit. */
const repo = (baseChangelog: string | null, branchChangelog?: string | null) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-changelog-gate-"));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.test");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(cwd, "a.txt"), "a\n");
  if (baseChangelog !== null) writeFileSync(path.join(cwd, "CHANGELOG.md"), baseChangelog);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "feature/x");
  writeFileSync(path.join(cwd, "b.txt"), "b\n");
  if (branchChangelog) writeFileSync(path.join(cwd, "CHANGELOG.md"), branchChangelog);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "change");
  return cwd;
};

const gate = (cwd: string, mode: "off" | "update" | "create", title = "feat: x", skip?: string) =>
  changelogGate({ cwd, mode, title, base: "main", skipReason: skip ?? null });

test("Given the gate is off, When a feat PR adds no entry, Then it passes untouched", () => {
  expect(gate(repo(RELEASED), "off")).toEqual({ status: "off" });
});

test("Given changelog create and no CHANGELOG.md, When a feat PR adds none, Then the entry is required with the apply command", () => {
  expect(gate(repo(null), "create")).toEqual({
    status: "missing",
    mode: "create",
    category: "Added",
    command: `workit changelog apply --entries '{"Added": ["<what users can now do>"]}'`,
  });
});

test("Given changelog update and no CHANGELOG.md, When a fix PR runs, Then there is nothing to update", () => {
  expect(gate(repo(null), "update", "fix: y")).toEqual({ status: "no-file", mode: "update" });
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

test("Given a base the checkout cannot resolve, When the gate runs, Then it does not block and says so", () => {
  const cwd = repo(RELEASED);
  expect(changelogGate({ cwd, mode: "update", title: "feat: x", base: "nope" })).toEqual({
    status: "base-unknown",
    mode: "update",
    base: "nope",
  });
});

test("Given a changelog text, When its Unreleased bullets are read, Then released sections are left out", () => {
  expect(unreleasedBullets(RELEASED)).toEqual(["Older unreleased thing"]);
  expect(unreleasedBullets("# Changelog\n\n## [Unreleased]\n\n* last line")).toEqual(["last line"]);
  expect(unreleasedBullets("# Changelog\n")).toEqual([]);
});
