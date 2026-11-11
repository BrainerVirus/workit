import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFanout } from "@/packages/workit-core/src/fanout-check";
import type { FanoutFile, Slice } from "@/packages/workit-core/src/fanout";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit fanout check` scope (#791): the lead writes each slice's changelog
// entry, so the workspace changelog paths are never out of a slice's scope.

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-changelog-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (cwd: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  }
};

const repo = () => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-fanout-cl-")));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "commit.gpgsign", "false");
  write(cwd, {
    "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n",
    "src/api/a.ts": "a\n",
    "src/ui/b.ts": "b\n",
  });
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  return cwd;
};

/** A slice commit, then the lead's changelog commit on the same branch. */
const branch = (
  cwd: string,
  name: string,
  work: Record<string, string>,
  lead: Record<string, string>,
) => {
  git(cwd, "switch", "-q", "-c", name, "main");
  write(cwd, work);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", `feat: ${name}`);
  if (Object.keys(lead).length) {
    write(cwd, lead);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "docs: changelog entry");
  }
  git(cwd, "switch", "-q", "main");
};

const slice = (id: string, scope: string[]): Slice => ({
  id,
  branch: `feature/${id}`,
  base: "main",
  worktree: "",
  tier: "standard",
  reason: "parallel",
  dependsOn: [],
  scope,
  owns: [],
  goal: `ship ${id}`,
  acceptance: [],
  verify: [],
  forbidden: [],
  context: null,
  timebox: null,
  issues: [],
  hash: id,
  hashSince: "2026-01-01T00:00:00.000Z",
});

const plan = (slices: Slice[]): FanoutFile => ({
  v: 1,
  name: "wave",
  trunk: "main",
  fanIn: "prs",
  shared: [],
  slices,
  leadSession: null,
  formerLeads: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const check = (cwd: string, slices: Slice[]) => {
  const result = checkFanout(cwd, plan(slices), { trunkRef: "main" });
  if (!result.ok) throw new Error(result.error);
  return Object.fromEntries(result.data.slices.map((one) => [one.id, one]));
};

test("Given a lead changelog commit on a slice, When fanout check runs, Then CHANGELOG.md is not out of scope and the slice is ready", () => {
  const cwd = repo();
  branch(
    cwd,
    "feature/api",
    { "src/api/a.ts": "a2\n" },
    {
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- api\n\n",
    },
  );
  branch(cwd, "feature/ui", { "src/ui/b.ts": "b2\n" }, {});
  const byId = check(cwd, [slice("api", ["src/api/**"]), slice("ui", ["src/ui/**"])]);
  expect(byId.api).toMatchObject({ status: "ready", changed: 2, outOfScope: [] });
  expect(byId.api.reasons).toEqual([]);
});

test("Given a configured changelogPath glob, When a slice carries a package changelog entry, Then that file is in scope while another stray file is still reported", () => {
  const cwd = repo();
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "app", glob: `${cwd}/**`, changelogPath: "packages/*/CHANGELOG.md" }],
    }),
  );
  branch(
    cwd,
    "feature/api",
    { "src/api/a.ts": "a2\n", "README.md": "stray\n" },
    {
      "packages/api/CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- api\n",
    },
  );
  const byId = check(cwd, [slice("api", ["src/api/**"])]);
  expect(byId.api).toMatchObject({ status: "blocked", outOfScope: ["README.md"] });
});
