import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../src/tools/repo";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const repoWithDevelop = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-branch-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "develop"]);
  git(root, ["branch", "main"]);
  git(root, ["checkout", "-q", "main"]);
  return { root, remote };
};

test("workflow_docs_branch keeps current feature branch", async () => {
  const { root, remote } = repoWithDevelop();
  git(root, ["checkout", "-q", "-b", "feature/current"]);
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_branch.execute(
      {},
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("keep");
    expect(result.data.branch).toBe("feature/current");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("workflow_docs_branch proposes create_from_develop on main", async () => {
  const { root, remote } = repoWithDevelop();
  mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
  const plan = "docs/superpowers/plans/2026-08-04-gates.md";
  writeFileSync(path.join(root, plan), "# Plan\n");
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_branch.execute(
      { plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("create_from_develop");
    expect(result.data.branch).toBe("feature/gates");
    expect(result.data.current_branch).toBe("main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup creates feature branch from develop when starting on main", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    const raw = await createRepoTools().workflow_branch_setup.execute({
      confirmed: true,
      target_branch: "feature/x",
      stash: "no",
    }, { directory: root, worktree: root } as never);
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("feature/x");
    const mergeBase = git(root, ["merge-base", "feature/x", "develop"]).stdout.trim();
    const developHead = git(root, ["rev-parse", "develop"]).stdout.trim();
    expect(mergeBase).toBe(developHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup errors when origin develop is missing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-no-develop-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "README.md"), "base\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "base"]);
    const raw = await createRepoTools().workflow_branch_setup.execute({
      confirmed: true,
      target_branch: "feature/x",
      stash: "no",
    }, { directory: root, worktree: root } as never);
    expect(JSON.parse(raw as string).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
