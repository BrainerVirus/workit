import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin from "../../packages/workit-opencode/src/plugin";
import { createRepoTools } from "../../packages/workit-core/src/tools/repo";
import { createSddTools } from "../../packages/workit-core/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";

const repository = (branch: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-smoke-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(git(["init", "-q", "-b", branch]).status).toBe(0);
  git(["config", "user.name", "Workflow Smoke"]);
  git(["config", "user.email", "workflow-smoke@example.test"]);
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  git(["add", "README.md"]);
  expect(git(["commit", "-q", "-m", "test: fixture"]).status).toBe(0);
  return { root, git };
};

test("feature branch staged file exposes context and can be committed", async () => {
  const { root, git } = repository("feature/test");
  try {
    writeFileSync(path.join(root, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    const tools = createRepoTools();
    const context = JSON.parse(
      (await tools.workflow_git_context.execute({}, {
        directory: root,
        worktree: root,
      } as never)) as string,
    );
    expect(context.ok).toBe(true);
    expect(context.data.branch).toBe("feature/test");
    expect(context.data.staged).toContain("staged.txt");

    const committed = JSON.parse(
      (await tools.workflow_commit.execute({ confirmed: true, message: "test: staged fixture" }, {
        directory: root,
        worktree: root,
      } as never)) as string,
    );
    expect(committed.ok).toBe(true);
    expect(git(["status", "--short"]).stdout).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main branch rejects workflow commits", async () => {
  const { root, git } = repository("main");
  try {
    writeFileSync(path.join(root, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    const raw = await createRepoTools().workflow_commit.execute(
      { confirmed: true, message: "test: must reject" },
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).error).toBe("cannot commit on protected branch main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rich changelog apply preserves custom Markdown and releases", async () => {
  const { root } = repository("feature/test");
  try {
    const changelog = path.join(root, "CHANGELOG.md");
    writeFileSync(
      changelog,
      `# Changelog

## [Unreleased]

<!-- keep comment -->

### Added

- Existing
  - nested detail

### Project Notes

Keep custom heading.

## [1.0.0] - 2026-01-01

### Fixed

- Historical fix
`,
    );
    const raw = await createRepoTools().workflow_changelog_apply.execute(
      {
        confirmed: true,
        entries: { Added: ["New item"] },
      },
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
    const output = readFileSync(changelog, "utf8");
    for (const preserved of [
      "<!-- keep comment -->",
      "  - nested detail",
      "### Project Notes",
      "Keep custom heading.",
      "## [1.0.0] - 2026-01-01",
      "- Historical fix",
      "- New item",
    ])
      expect(output).toContain(preserved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDD context reports completed and pending tasks from the ledger", async () => {
  const { root } = repository("feature/test");
  try {
    mkdirSync(path.join(root, "docs", "smoke"), { recursive: true });
    mkdirSync(path.join(root, "docs", "smoke"), { recursive: true });
    mkdirSync(path.join(root, "docs/smoke/sdd"), { recursive: true });
    writeFileSync(
      path.join(root, "docs/smoke/spec.md"),
      "# Smoke\n\n**Branch:** `feature/smoke`\n",
    );
    writeFileSync(
      path.join(root, "docs/smoke/plan.md"),
      [
        "# Smoke",
        "**Spec:** `docs/smoke/spec.md`",
        "**Branch:** `feature/smoke`",
        "",
        "### Task 1: One",
        "",
        "- [ ] **Step 1:** Work",
        "",
        "### Task 2: Two",
        "",
        "- [ ] **Step 1:** Work",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "docs/smoke/sdd/progress.md"),
      "Task 1: complete (commits abcdef0..1234567, tests pass)\n",
    );
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: "docs/smoke/plan.md" },
      { directory: root, worktree: root, sessionID: "smoke" } as never,
    );
    const todos = JSON.parse(raw as string).data.todos;
    expect(todos.map(({ id, status }: { id: string; status: string }) => ({ id, status }))).toEqual(
      [
        { id: "task-1", status: "completed" },
        { id: "task-2", status: "pending" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin registers without a Cursor runtime path", async () => {
  const { root } = repository("feature/test");
  try {
    expect(existsSync(path.join(root, ".cursor/plugins/local/workflow-toolkit"))).toBe(false);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command)).toHaveLength(12);
    expect(config.skills.paths).toEqual([
      path.resolve(import.meta.dir, "../../packages/workit-core/skills"),
      path.resolve(import.meta.dir, "../../packages/workit-core/vendor/superpowers/skills"),
    ]);
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
