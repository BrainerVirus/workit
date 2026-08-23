import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
// Mirrors the isolation pattern of test/workit-core/branch-policy.test.ts.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-branch-test-config-"));
  writeFileSync(
    path.join(isolatedConfig, "config.json"),
    JSON.stringify(
      {
        locale: "en",
        localeOptions: ["en"],
        timezone: "UTC",
        branchPolicy: {
          preset: "gitflow",
          allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
          protected: ["main", "develop", "master", "prod", "production"],
        },
      },
      null,
      2,
    ),
  );
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const repoOnMain = ({ withDevelop }: { withDevelop: boolean }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-hardening-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-branch-hardening-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  if (withDevelop) {
    git(root, ["branch", "develop"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["branch", "-D", "develop"]);
  }
  return { root, remote };
};

const dirtyTree = (root: string) => {
  writeFileSync(path.join(root, "README.md"), "wip change\n");
  writeFileSync(path.join(root, "notes.md"), "untracked doc\n");
};

test("failed base resolution after stash leaves tree intact (no stranded stash)", async () => {
  // CA-02 regression: origin lacks develop, so base resolution must fail
  // BEFORE any mutation — never after the stash push has already emptied the
  // tree (the late failure that stranded a stash and lost visible work).
  const { root, remote } = repoOnMain({ withDevelop: false });
  try {
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("origin/develop missing");
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("wip change\n");
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("policy/base resolution runs before any stash push", async () => {
  // CA-01 regression: base resolution succeeds here but a later step fails
  // after the stash push (local branch `bugfix` blocks creating `refs/heads/
  // bugfix/x`), so the error path must pop the stash back before returning —
  // the tree ends up exactly as it was left, with no stranded stash entry.
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    git(root, ["branch", "bugfix"]);
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("wip change\n");
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
