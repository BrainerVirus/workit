import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolContext } from "@opencode-ai/plugin";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import { establishApprovedFlow } from "./flow-fixtures";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";
import {
  sddAppendAdvisory,
  sddAppendProgress,
  sddReviewPackage,
} from "../../packages/workit-core/src/core/sdd";

// The tools only read sessionID/directory/worktree from the context; the rest
// of ToolContext is stubbed so tests get a real typed object instead of `as never`.
const execContext = (root: string, sessionID = "s1"): ToolContext => ({
  sessionID,
  messageID: "m1",
  agent: "test",
  directory: root,
  worktree: root,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
});

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
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

test("plan parser returns only top-level Task sections and records state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] Step\n\n### Task 2: Two\n\n- [ ] Step\n",
  );
  const state = new WorkflowStateStore();
  const tools = createSddTools(state);
  const raw = await tools.workflow_plan_tasks.execute({ plan_path: "docs/x/plan.md" }, {
    directory: root,
    worktree: root,
    sessionID: "s1",
  } as never);
  const result = JSON.parse(raw as string);
  expect(result.data.tasks.map((task: any) => task.title)).toEqual(["One", "Two"]);
  expect(state.get("s1")).toEqual({
    spec: "docs/x/spec.md",
    plan: "docs/x/plan.md",
    sdd: "docs/x/sdd",
  });
});

test("plan parser honors an explicit contained spec path and returns its branch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-spec-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "exact"), { recursive: true });
  mkdirSync(path.join(root, "docs", "other"), { recursive: true });
  writeFileSync(path.join(root, "docs/exact/spec.md"), "# Exact\n**Branch:** `feature/exact`\n");
  writeFileSync(path.join(root, "docs/other/spec.md"), "# Other\n**Branch:** `feature/other`\n");
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n**Spec:** `docs/other/spec.md`\n**Branch:** `feature/other`\n\n### Task 1: One\n\n- [ ] Step\n",
  );
  const state = new WorkflowStateStore();
  const tools = createSddTools(state);
  const raw = await tools.workflow_plan_tasks.execute(
    {
      plan_path: "docs/x/plan.md",
      spec_path: "docs/exact/spec.md",
    },
    { directory: root, worktree: root, sessionID: "spec" } as never,
  );
  expect(JSON.parse(raw as string).data.branch).toBe("feature/exact");
  expect(state.get("spec")?.spec).toBe("docs/exact/spec.md");

  const outside = await createSddTools(new WorkflowStateStore()).workflow_plan_tasks.execute(
    {
      plan_path: "docs/x/plan.md",
      spec_path: "../outside.md",
    },
    { directory: root, worktree: root, sessionID: "outside" } as never,
  );
  expect(JSON.parse(outside as string).error).toContain("inside repository root");
});

test("SDD paths outside the repository are rejected", async () => {
  const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
    { plan_path: "../outside.md" },
    { directory: os.tmpdir(), worktree: os.tmpdir(), sessionID: "s1" } as never,
  );
  expect(JSON.parse(raw as string).error).toContain("inside repository root");
});

test("SDD context computes absent paths without creating repository files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-readonly-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] Step\n",
    );
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "readonly" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(existsSync(path.join(root, "docs/x/sdd"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDD context returns canonical paths and creates no nested slug level or empty progress ledger", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-canonical-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] Step\n",
    );
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "canonical" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(out.data.sdd_dir).toBe("docs/x/sdd");
    expect(out.data.progress_path).toBe("docs/x/sdd/progress.md");
    // Only the canonical path is ever named: no docs/<slug>/sdd/<slug>/.
    expect(existsSync(path.join(root, "docs/x/sdd"))).toBe(false);
    expect(existsSync(path.join(root, "docs/x/sdd/x"))).toBe(false);
    expect(existsSync(path.join(root, "docs/x/sdd/progress.md"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress.md appears only on the first confirmed append, never on context", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-lazy-"));
  const tools = createSddTools(new WorkflowStateStore());
  try {
    establishApprovedFlow(root, "x", new HostReceiptStore(), "s1");
    await tools.workflow_sdd_context.execute({ plan_path: "docs/x/plan.md" }, {
      directory: root,
      worktree: root,
      sessionID: "lazy",
    } as never);
    expect(existsSync(path.join(root, "docs/x/sdd/progress.md"))).toBe(false);
    const result = JSON.parse(
      (await tools.workflow_sdd_append_progress.execute(
        {
          confirmed: true,
          progress_path: "docs/x/sdd/progress.md",
          line: "Task 1: complete (commits abcdef0..1234567, tests pass)",
        },
        { directory: root, worktree: root } as never,
      )) as string,
    );
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, "docs/x/sdd/progress.md"))).toBe(true);
    expect(readFileSync(path.join(root, "docs/x/sdd/progress.md"), "utf8")).toContain("Task 1:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sdd context accepts a bare slug like the cursor host and returns canonical paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-slug-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { slug: "x" },
      { directory: root, worktree: root, sessionID: "slug" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(out.data.sdd_dir).toBe("docs/x/sdd");
    expect(out.data.progress_path).toBe("docs/x/sdd/progress.md");
    expect(existsSync(path.join(root, "docs/x/sdd"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDD tools expose standard schemas and guard writes", async () => {
  const tools = createSddTools(new WorkflowStateStore());
  expect(Object.keys(tools).sort()).toEqual(
    [
      "workflow_docs_branch",
      "workflow_docs_validate",
      "workflow_plan_tasks",
      "workflow_resolve_branch",
      "workflow_sdd_context",
      "workflow_sdd_task_brief",
      "workflow_sdd_review_package",
      "workflow_sdd_append_progress",
      "workflow_sdd_append_advisory",
    ].sort(),
  );
  for (const definition of Object.values(tools)) {
    expect("workspace_root" in definition.args).toBe(false);
  }
  for (const name of [
    "workflow_sdd_task_brief",
    "workflow_sdd_review_package",
    "workflow_sdd_append_progress",
    "workflow_sdd_append_advisory",
  ] as const) {
    const raw = await tools[name].execute(
      { confirmed: false } as never,
      { directory: "/repo", worktree: "/repo" } as never,
    );
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
  }
});

test("confirmed SDD writes use repository-relative paths and standard results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-write-"));
  const tools = createSddTools(new WorkflowStateStore());
  establishApprovedFlow(root, "x", new HostReceiptStore(), "s1");
  const brief = JSON.parse(
    (await tools.workflow_sdd_task_brief.execute(
      {
        confirmed: true,
        sdd_dir: "docs/x/sdd",
        task_id: 2,
        section_text: "- [ ] Implement it\n",
      },
      { directory: root, worktree: root } as never,
    )) as string,
  );
  expect(brief.data.brief_path).toBe("docs/x/sdd/task-2-brief.md");
  expect(readFileSync(path.join(root, brief.data.brief_path), "utf8")).toContain("Implement it");

  const progress = JSON.parse(
    (await tools.workflow_sdd_append_progress.execute(
      {
        confirmed: true,
        progress_path: "docs/x/sdd/progress.md",
        line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
      },
      { directory: root, worktree: root } as never,
    )) as string,
  );
  expect(progress).toEqual({
    ok: true,
    data: {
      line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
      progress_path: "docs/x/sdd/progress.md",
    },
    error: null,
  });
});

test("branch resolution returns repository and plan facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-branch-"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs/spec.md"), "# Spec\n**Branch:** `feature/fixture`\n");
  writeFileSync(path.join(root, "docs/plan.md"), "# Plan\n");
  expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status).toBe(0);
  spawnSync("git", ["config", "user.name", "Workflow Test"], { cwd: root });
  spawnSync("git", ["config", "user.email", "workflow@example.test"], { cwd: root });
  spawnSync("git", ["add", "docs"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  const raw = await createSddTools(new WorkflowStateStore()).workflow_resolve_branch.execute(
    {
      spec_path: "docs/spec.md",
      plan_path: "docs/plan.md",
    },
    { directory: root, worktree: root } as never,
  );
  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: {
      branch: "feature/fixture",
      source: "spec",
      current_branch: "main",
      dirty: false,
      needs_checkout: true,
    },
    error: null,
  });
});

test("confirmed review package writes its diff inside the repository", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-review-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  establishApprovedFlow(root, "review", new HostReceiptStore(), "s1");
  expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
  git(["config", "user.name", "Workflow Test"]);
  git(["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "file.txt"), "one\n");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(path.join(root, "file.txt"), "one\ntwo\n");
  git(["commit", "-q", "-am", "head"]);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute(
    {
      confirmed: true,
      sdd_dir: "docs/review/sdd",
      base_sha: base,
      head_sha: head,
    },
    { directory: root, worktree: root } as never,
  );
  const result = JSON.parse(raw as string);
  expect(result.ok).toBe(true);
  expect(result.data.diff_path).toBe(
    `docs/review/sdd/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`,
  );
  expect(readFileSync(path.join(root, result.data.diff_path), "utf8")).toContain("+two");
});

test("review package rejects unsafe revisions and quote-bearing paths cannot execute code", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-injection-"));
  const sentinel = path.join(root, "sentinel");
  try {
    const tools = createSddTools(new WorkflowStateStore());
    const raw = await tools.workflow_sdd_review_package.execute(
      {
        confirmed: true,
        sdd_dir: "docs/quote/sdd'$(touch sentinel)",
        base_sha: "--output=outside",
        head_sha: "HEAD'; touch sentinel; #",
      },
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).error).toContain("invalid Git revision");
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(path.dirname(root), "outside"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review package safely writes to a quote-bearing contained path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-quoted-path-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    establishApprovedFlow(root, "review", new HostReceiptStore(), "s1");
    git(["init", "-q", "-b", "feature/review"]);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(path.join(root, "file.txt"), "two\n");
    git(["commit", "-q", "-am", "head"]);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute(
      {
        confirmed: true,
        sdd_dir: "docs/review/sdd'quoted",
        base_sha: base,
        head_sha: head,
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, result.data.diff_path))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddReviewPackage rejects an empty base..head range instead of writing an empty diff", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-emptyrange-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    const result = sddReviewPackage({
      sdd_dir: "docs/review/sdd",
      base_sha: base,
      head_sha: base,
      workspace_root: root,
    });
    expect(result.error).toBeTruthy();
    const base7 = base.slice(0, 7);
    expect(existsSync(path.join(root, `docs/review/sdd/review-${base7}..${base7}.diff`))).toBe(
      false,
    );
    expect(existsSync(path.join(root, "docs/review/sdd"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddAppendProgress rejects a progress line with identical commit shas", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-samesha-"));
  const result = sddAppendProgress({
    progress_path: "docs/x/sdd/progress.md",
    line: "Task 1: complete (commits abcdef0123456789..abcdef0123456789, tests pass)",
    workspace_root: root,
  });
  expect(result.error).toBeTruthy();
  expect(existsSync(path.join(root, "docs/x/sdd/progress.md"))).toBe(false);
});

test("sddReviewPackage rejects an empty base..head range through the OpenCode tool wrapper", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-emptyrange-parity-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    establishApprovedFlow(root, "review", new HostReceiptStore(), "s1");
    expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute(
      {
        confirmed: true,
        sdd_dir: "docs/review/sdd",
        base_sha: base,
        head_sha: base,
      },
      execContext(root),
    );
    const result = JSON.parse(raw as string);
    expect(result.error).toBeTruthy();
    const base7 = base.slice(0, 7);
    expect(existsSync(path.join(root, `docs/review/sdd/review-${base7}..${base7}.diff`))).toBe(
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddReviewPackage rejects distinct shas whose trees diff to nothing and leaves no directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-emptydiff-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    // An empty commit reuses the parent's tree: distinct shas, empty `git diff`.
    git(["commit", "-q", "--allow-empty", "-m", "empty"]);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    expect(head).not.toBe(base);
    const result = sddReviewPackage({
      sdd_dir: "docs/review/sdd",
      base_sha: base,
      head_sha: head,
      workspace_root: root,
    });
    expect(result.error).toContain("empty commit range");
    expect(result.code).toBe("empty_commit_range");
    const base7 = base.slice(0, 7);
    const head7 = head.slice(0, 7);
    expect(existsSync(path.join(root, `docs/review/sdd/review-${base7}..${head7}.diff`))).toBe(
      false,
    );
    expect(existsSync(path.join(root, "docs/review/sdd"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddReviewPackage rejects an empty diff through the OpenCode tool wrapper", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-emptydiff-parity-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    establishApprovedFlow(root, "review", new HostReceiptStore(), "s1");
    expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["commit", "-q", "--allow-empty", "-m", "empty"]);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute(
      {
        confirmed: true,
        sdd_dir: "docs/review/sdd",
        base_sha: base,
        head_sha: head,
      },
      execContext(root),
    );
    const result = JSON.parse(raw as string);
    // The OpenCode wrapper normalizes through `fail()`, which keeps the error
    // string but drops the structured code; the CLI surface carries the code.
    expect(result.error).toContain("empty commit range");
    expect(result.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddReviewPackage still writes the diff for a real base..head range", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-realrange-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n");
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(path.join(root, "file.txt"), "one\ntwo\n");
    git(["commit", "-q", "-am", "head"]);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const result = sddReviewPackage({
      sdd_dir: "docs/review/sdd",
      base_sha: base,
      head_sha: head,
      workspace_root: root,
    });
    expect(result.error).toBeFalsy();
    const diff = result as { diff_path: string };
    expect(readFileSync(path.join(root, diff.diff_path), "utf8")).toContain("+two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Task 3: advisory persistence (CA-10/CA-11) ---

test("sddAppendAdvisory rejects invalid task ids with advisory_task_invalid and writes nothing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-adv-task-"));
  try {
    const base = { advisories_path: "docs/x/sdd/advisories.md", text: "ok", workspace_root: root };
    for (const task_id of [
      0,
      -1,
      -3,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      "1",
      null,
      undefined,
    ]) {
      const result = sddAppendAdvisory({ ...base, task_id });
      expect((result as { code?: string }).code, String(task_id)).toBe("advisory_task_invalid");
    }
    expect(existsSync(path.join(root, "docs"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddAppendAdvisory rejects invalid text with advisory_text_invalid and writes nothing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-adv-text-"));
  try {
    const base = { advisories_path: "docs/x/sdd/advisories.md", task_id: 1, workspace_root: root };
    for (const text of ["", "   ", "\t", "a".repeat(1001), "line1\nline2", "carriage\rreturn"]) {
      const result = sddAppendAdvisory({ ...base, text });
      expect((result as { code?: string }).code, JSON.stringify(text).slice(0, 20)).toBe(
        "advisory_text_invalid",
      );
    }
    expect(existsSync(path.join(root, "docs"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddAppendAdvisory rejects noncanonical paths and directory targets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-adv-path-"));
  try {
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd", "advisories.md"), { recursive: true });
    for (const advisories_path of [
      "docs/x/sdd/notes.md",
      "docs/x/advisories.md",
      "../outside/advisories.md",
      "/etc/advisories.md",
      "docs/x/sdd/advisories.md/extra",
    ]) {
      const result = sddAppendAdvisory({
        advisories_path,
        task_id: 1,
        text: "ok",
        workspace_root: root,
      });
      expect((result as { code?: string }).code, advisories_path).toBe("advisory_path_invalid");
    }
    // A directory at the canonical target is a target error, not a path error.
    const dir = sddAppendAdvisory({
      advisories_path: "docs/x/sdd/advisories.md",
      task_id: 1,
      text: "ok",
      workspace_root: root,
    });
    expect((dir as { code?: string }).code).toBe("advisory_target_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sddAppendAdvisory appends exactly '- Task N: <normalized>' and collapses horizontal space", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-adv-write-"));
  try {
    const advisories = "docs/x/sdd/advisories.md";
    const first = sddAppendAdvisory({
      advisories_path: advisories,
      task_id: 3,
      text: "  minor\tstyle   nit  ",
      workspace_root: root,
    });
    expect(first).toEqual({ ok: true, advisory: "minor style nit", advisories_path: advisories });
    const second = sddAppendAdvisory({
      advisories_path: advisories,
      task_id: 4,
      text: "next",
      workspace_root: root,
    });
    expect(second).toEqual({ ok: true, advisory: "next", advisories_path: advisories });
    expect(readFileSync(path.join(root, advisories), "utf8")).toBe(
      "- Task 3: minor style nit\n- Task 4: next\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the OpenCode advisory wrapper preserves the core payload and validation codes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-adv-wrap-"));
  try {
    establishApprovedFlow(root, "x", new HostReceiptStore(), "s1");
    const tools = createSddTools(new WorkflowStateStore());
    const ok = JSON.parse(
      (await tools.workflow_sdd_append_advisory.execute(
        {
          confirmed: true,
          advisories_path: "docs/x/sdd/advisories.md",
          task_id: 2,
          text: "wrapped\t value",
        },
        { directory: root, worktree: root } as never,
      )) as string,
    );
    expect(ok).toEqual({
      ok: true,
      data: { advisory: "wrapped value", advisories_path: "docs/x/sdd/advisories.md" },
      error: null,
    });
    expect(readFileSync(path.join(root, "docs/x/sdd/advisories.md"), "utf8")).toBe(
      "- Task 2: wrapped value\n",
    );

    const badTask = JSON.parse(
      (await tools.workflow_sdd_append_advisory.execute(
        {
          confirmed: true,
          advisories_path: "docs/x/sdd/advisories.md",
          task_id: 1.5,
          text: "ok",
        },
        { directory: root, worktree: root } as never,
      )) as string,
    );
    expect(badTask.ok).toBe(false);
    expect(badTask.error).toContain("positive safe integer");

    const unconfirmed = JSON.parse(
      (await tools.workflow_sdd_append_advisory.execute(
        { confirmed: false, advisories_path: "docs/x/sdd/advisories.md", task_id: 1, text: "ok" },
        { directory: root, worktree: root } as never,
      )) as string,
    );
    expect(unconfirmed.error).toBe("confirmed: true required");
    expect(readFileSync(path.join(root, "docs/x/sdd/advisories.md"), "utf8")).toBe(
      "- Task 2: wrapped value\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
