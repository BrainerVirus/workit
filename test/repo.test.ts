import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools, normalizeLegacyResult } from "../packages/workit/src/tools/repo";
import { PLUGIN_ROOT } from "../packages/workit/src/core/scripts";

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
  writeFileSync(path.join(isolatedConfig, "config.json"), JSON.stringify({
    locale: "en",
    localeOptions: ["en"],
    timezone: "UTC",
    branchPolicy: {
      preset: "gitflow",
      allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
      protected: ["main", "develop", "master", "prod", "production"],
    },
  }, null, 2));
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const calls: Array<{ root: string; script: string; args: string[]; env?: Record<string, string> }> = [];
const gitCalls: Array<{ root: string; args: string[] }> = [];
const outputs: Record<string, string> = {
  "init/status.sh": JSON.stringify({ ready: false, items: [{ id: "config", ok: true }] }),
  "init/toolkit-status.sh": JSON.stringify({ ready: true, next_step: "All checks passed" }),
  "verify-project.sh": "# Verification Context\n\n## test\ncommand: bun test\nstatus: pass\n\n# Summary\npassed: 1\nfailed: 0\nskipped: 0\n",
  "pr-ready-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: develop..HEAD\nbase_ref: develop\nmerge_base: abc123\ndiff_range: abc123..HEAD\nrange_mode: branch-exclusive\ngit_sync: current\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## PR Template\ntemplate_path: .github/pull_request_template.md\n\n## VCS Config\n{\"provider\":\"github\"}\n\n## Merged PR Style\n{\"titles\":[\"feat: example\"]}\n",
  "changelog-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Keep a Changelog Rules\n- Human readable\n\n## Existing CHANGELOG.md\n[Unreleased]\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n",
  "release-notes-context.sh": "# Context\n\n## Repository\nrequested: v1.0.0\nrange: v1.0.0..HEAD\n\n## Tags\nv1.0.0\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## Existing Release Files\nCHANGELOG.md\n",
  "docs-refresh-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Changed Files\nsrc/plugin.ts\n\n## Documentation Files\nREADME.md\n\n## README Preview\n# Toolkit\n\n## Package Scripts\n{\"test\":\"bun test\"}\n",
  "branch/setup-branch.sh": JSON.stringify({ ok: true, branch: "feature/native-tools" }),
  "pr-create.sh": JSON.stringify({ ok: true, provider: "github", output: "https://example.test/pr/1" }),
  "init/apply.sh": JSON.stringify({ ok: true, action: "youtrack_json" }),
};

const runtime = {
  runScript: (root: string, script: string, args: string[], env?: Record<string, string>) => {
    calls.push({ root, script, args, ...(env ? { env } : {}) });
    return { exitCode: 0, stdout: outputs[script] ?? "", stderr: "", cwd: root };
  },
  git: (root: string, args: string[]) => {
    gitCalls.push({ root, args });
    return { exitCode: 0, stdout: args[0] === "branch" ? "feature/native-tools\n" : "committed\n", stderr: "", cwd: root };
  },
};

const execute = async (name: keyof ReturnType<typeof createRepoTools>, args: Record<string, unknown> = {}) => {
  const tools = createRepoTools(runtime);
  return JSON.parse(await tools[name].execute(args as never, { directory: "/repo", worktree: "/repo"} as never) as string);
};

test("repo tools expose native names without workspace override", () => {
  const tools = createRepoTools(runtime);
  expect(Object.keys(tools).sort()).toEqual([
    "workflow_changelog_context", "workflow_docs_context", "workflow_git_context",
    "workflow_pr_context", "workflow_release_notes_context", "workflow_toolkit_init_status",
    "workflow_toolkit_status", "workflow_verify", "workflow_changelog_apply",
    "workflow_branch_setup", "workflow_commit", "workflow_pr_create", "workflow_toolkit_init_apply",
  ].sort());
  for (const definition of Object.values(tools)) {
    expect("workspace_root" in definition.args).toBe(false);
  }
});

test("release notes rejects a missing range before running a script", async () => {
  calls.length = 0;
  expect(await execute("workflow_release_notes_context", { range_or_tag: "" })).toEqual({
    ok: false, data: null, error: "release tag or range required",
  });
  expect(calls).toHaveLength(0);
});

test("revision context rejects option-like inputs before scripts run", async () => {
  calls.length = 0;
  for (const [name, args] of [
    ["workflow_pr_context", { range: "--output=/tmp/owned" }],
    ["workflow_changelog_context", { range: "-p" }],
    ["workflow_release_notes_context", { range_or_tag: "--help" }],
  ] as const) {
    const result = await execute(name, args);
    expect(result.error).toContain("invalid Git revision");
  }
  expect(calls).toHaveLength(0);
});

test("revision context resolves revisions and cannot create option-selected files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-revision-"));
  const outside = path.join(path.dirname(root), `wf-owned-${path.basename(root)}`);
  try {
    spawnSync("git", ["init", "-q", "-b", "feature/range"], { cwd: root });
    const raw = await createRepoTools().workflow_changelog_context.execute(
      { range: `--output=${outside}` }, { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).error).toContain("invalid Git revision");
    expect(existsSync(outside)).toBe(false);
    const missing = await createRepoTools().workflow_changelog_context.execute(
      { range: "does-not-exist" }, { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(missing as string).error).toContain("invalid Git revision");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

test("script tools use ToolContext.directory", async () => {
  calls.length = 0;
  await execute("workflow_verify", { dry_run: true });
  expect(calls).toEqual([{ root: "/repo", script: "verify-project.sh", args: ["--dry-run"] }]);
});

test("verification output is structured", async () => {
  expect(await execute("workflow_verify")).toEqual({
    ok: true,
    data: {
      passed: 1,
      failed: 0,
      skipped: 0,
      commands: [{ label: "test", command: "bun test", status: "pass" }],
      exitCode: 0,
    },
    error: null,
  });
});

test("repository context scripts return named fields", async () => {
  const pr = await execute("workflow_pr_context");
  expect(pr.data).toMatchObject({
    branch: "feature/native-tools", range: "develop..HEAD", commits: "abc feat: tools",
    files: "src/tools/repo.ts", pr_template: "template_path: .github/pull_request_template.md",
    vcs_config: { provider: "github" }, merged_pr_style: { titles: ["feat: example"] },
  });

  const changelog = await execute("workflow_changelog_context");
  expect(changelog.data).toMatchObject({
    branch: "feature/native-tools", range: "HEAD~1..HEAD", changelog_excerpt: "[Unreleased]",
    rules: "- Human readable", commits: "abc feat: tools", files: "src/tools/repo.ts",
  });

  const release = await execute("workflow_release_notes_context", { range_or_tag: "v1.0.0" });
  expect(release.data).toMatchObject({
    requested: "v1.0.0", range: "v1.0.0..HEAD", tags: "v1.0.0",
    commits: "abc feat: tools", files: "src/tools/repo.ts", release_files: "CHANGELOG.md",
  });

  const docs = await execute("workflow_docs_context");
  expect(docs.data).toMatchObject({
    branch: "feature/native-tools", range: "HEAD~1..HEAD", changed_files: "src/plugin.ts",
    files: "README.md", readme_preview: "# Toolkit", package_scripts: "{\"test\":\"bun test\"}",
  });
});

test("status scripts decode JSON into the Result data field", async () => {
  expect((await execute("workflow_toolkit_init_status")).data).toEqual({
    ready: false, items: [{ id: "config", ok: true }], exitCode: 0,
  });
  expect((await execute("workflow_toolkit_status")).data).toEqual({
    ready: true, next_step: "All checks passed", exitCode: 0,
  });
});

test("script failures keep diagnostics in a failed Result", async () => {
  const failing = createRepoTools({
    ...runtime,
    runScript: (root: string) => ({ exitCode: 2, stdout: "partial", stderr: "broken", cwd: root }),
  });
  const raw = await failing.workflow_docs_context.execute({}, { directory: "/repo", worktree: "/repo"} as never);
  expect(JSON.parse(raw as string)).toEqual({
    ok: false,
    data: { stdout: "partial", stderr: "broken", exitCode: 2 },
    error: "broken",
  });
});

test("mutations reject missing confirmation", async () => {
  calls.length = 0;
  gitCalls.length = 0;
  const tools = createRepoTools(runtime);
  for (const name of [
    "workflow_changelog_apply", "workflow_branch_setup", "workflow_commit",
    "workflow_pr_create", "workflow_toolkit_init_apply",
  ] as const) {
    const raw = await tools[name].execute({ confirmed: false } as never, { directory: "/repo", worktree: "/repo"} as never);
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
  }
  expect(calls).toHaveLength(0);
  expect(gitCalls).toHaveLength(0);
});

test("commit blocks protected branches", async () => {
  const protectedRuntime = {
    ...runtime,
    git: (_root: string, args: string[]) => args[0] === "branch"
      ? { exitCode: 0, stdout: "main\n", stderr: "", cwd: "/repo" }
      : { exitCode: 0, stdout: "", stderr: "", cwd: "/repo" },
  };
  const raw = await createRepoTools(protectedRuntime).workflow_commit.execute(
    { confirmed: true, message: "fix: no" }, { directory: "/repo", worktree: "/repo"} as never,
  );
  expect(JSON.parse(raw as string).error).toContain("protected branch main");
});

test("commit accepts only feature or bugfix branches and never stages files", async () => {
  gitCalls.length = 0;
  const result = await execute("workflow_commit", { confirmed: true, message: "feat: native mutation" });
  expect(result).toEqual({
    ok: true, data: { stdout: "committed", exitCode: 0 }, error: null,
  });
  expect(gitCalls).toEqual([
    { root: "/repo", args: ["branch", "--show-current"] },
    { root: "/repo", args: ["commit", "-m", "feat: native mutation"] },
  ]);

  const raw = await createRepoTools({
    ...runtime,
    git: (root: string, args: string[]) => ({
      exitCode: 0, stdout: args[0] === "branch" ? "chore/random\n" : "", stderr: "", cwd: root,
    }),
  }).workflow_commit.execute(
    { confirmed: true, message: "chore: no" }, { directory: "/repo", worktree: "/repo"} as never,
  );
  const rejected = JSON.parse(raw as string);
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain("requires an allowed branch");

  const emptySuffix = await createRepoTools({
    ...runtime,
    git: (root: string, args: string[]) => ({
      exitCode: 0, stdout: args[0] === "branch" ? "feature/\n" : "", stderr: "", cwd: root,
    }),
  }).workflow_commit.execute(
    { confirmed: true, message: "fix: no empty suffix" }, { directory: "/repo", worktree: "/repo"} as never,
  );
  expect(JSON.parse(emptySuffix as string).error).toContain("requires an allowed branch");
});

test("PR creation rejects protected and unsupported branches before external work", async () => {
  for (const branch of ["main", "master", "develop", "prod", "feature/"]) {
    let externalCalls = 0;
    const guarded = createRepoTools({
      ...runtime,
      git: (root, args) => ({ exitCode: 0, stdout: args[0] === "branch" ? `${branch}\n` : "", stderr: "", cwd: root }),
      runScript: (root) => {
        externalCalls++;
        return { exitCode: 0, stdout: "{}", stderr: "", cwd: root };
      },
    });
    const raw = await guarded.workflow_pr_create.execute(
      { confirmed: true, title: "No" }, { directory: "/repo", worktree: "/repo" } as never,
    );
    expect(JSON.parse(raw as string).error).toContain("requires an allowed branch");
    expect(externalCalls).toBe(0);
  }
});

test("PR context is read-only even with a remote and upstream", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-pr-readonly-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-pr-remote-"));
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(remote, ["init", "-q", "--bare"]);
    git(root, ["init", "-q", "-b", "develop"]);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]); git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", remote]); git(root, ["push", "-q", "-u", "origin", "develop"]);
    git(root, ["checkout", "-q", "-b", "feature/read-only"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\nfeature\n");
    git(root, ["commit", "-q", "-am", "feature"]); git(root, ["push", "-q", "-u", "origin", "feature/read-only"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\nfeature\nunstaged\n");
    writeFileSync(path.join(root, "untracked.txt"), "keep\n");
    const remoteCalled = path.join(root, "remote-called");
    const uploadPack = path.join(root, "upload-pack.sh");
    writeFileSync(uploadPack, `#!/bin/sh\ntouch '${remoteCalled}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
    git(root, ["config", "remote.origin.uploadpack", uploadPack]);
    const snapshot = () => ({
      head: git(root, ["rev-parse", "HEAD"]).stdout,
      refs: git(root, ["show-ref"]).stdout,
      index: readFileSync(path.join(root, ".git/index")).toString("base64"),
      status: git(root, ["status", "--porcelain=v1"]).stdout,
      tracked: readFileSync(path.join(root, "tracked.txt"), "utf8"),
      untracked: readFileSync(path.join(root, "untracked.txt"), "utf8"),
    });
    const before = snapshot();
    const raw = await createRepoTools().workflow_pr_context.execute({}, { directory: root, worktree: root } as never);
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(existsSync(remoteCalled)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup requires develop remote before creating from main", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-branch-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-branch-remote-"));
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(remote, ["init", "-q", "--bare"]);
    expect(git(root, ["init", "-q", "-b", "develop"]).status).toBe(0);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "README.md"), "base\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "-u", "origin", "develop"]);
    git(root, ["branch", "main"]);
    git(root, ["checkout", "-q", "main"]);
    const raw = await createRepoTools().workflow_branch_setup.execute({
      confirmed: true, target_branch: "feature/x", stash: "no",
    }, { directory: root, worktree: root} as never);
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("feature/x");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("reapply stash dispatches without a target branch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-reapply-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
    const raw = await createRepoTools().workflow_branch_setup.execute({
      confirmed: true, action: "reapply_stash",
    }, { directory: root, worktree: root} as never);
    const result = JSON.parse(raw as string);
    expect(result.error).toContain("no stash_ref");
    expect(result.error).not.toContain("target branch required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch setup treats quote-bearing manifest paths as data", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-quote-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
    const injected = "docs/sdd/x'); __import__('pathlib').Path('sentinel').write_text('owned'); #";
    const raw = await createRepoTools().workflow_branch_setup.execute({
      confirmed: true, action: "reapply_stash", sdd_dir: injected,
    }, { directory: root, worktree: root } as never);
    expect(JSON.parse(raw as string).error).toContain("no stash_ref");
    expect(existsSync(path.join(root, "sentinel"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confirmed script mutations use package scripts, argument arrays, and scoped environment", async () => {
  calls.length = 0;
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-scripts-"));
  expect(await execute("workflow_pr_create", {
    confirmed: true, title: "Native tools", body: "Ready", draft: true, target_branch: "develop",
  })).toEqual({
    ok: true,
    data: { provider: "github", output: "https://example.test/pr/1", exitCode: 0 },
    error: null,
  });
  expect(await execute("workflow_toolkit_init_apply", {
    confirmed: true, action: "youtrack_json", base_url: "https://youtrack.example.test",
  })).toEqual({ ok: true, data: { action: "youtrack_json", exitCode: 0 }, error: null });

  expect(calls).toEqual([
    {
      root: "/repo", script: "pr-create.sh", args: [], env: {
        WF_PR_TITLE: "Native tools", WF_PR_BODY: "Ready", WF_PR_CONFIRMED: "true",
        WF_PR_DRAFT: "true", WF_PR_TARGET: "develop",
      },
    },
    {
      root: "/repo", script: "init/apply.sh", args: ["youtrack_json", "true"],
      env: { WORKFLOW_YT_BASE_URL: "https://youtrack.example.test" },
    },
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("mutation scripts normalize legacy errors into a failed Result", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-error-"));
  const raw = await createRepoTools({
    ...runtime,
    runScript: (root: string) => ({
      exitCode: 1, stdout: JSON.stringify({ error: "legacy failure" }), stderr: "", cwd: root,
    }),
  }).workflow_pr_create.execute(
    { confirmed: true, title: "Broken" }, { directory: root, worktree: root} as never,
  );
  expect(JSON.parse(raw as string)).toEqual({
    ok: false,
    data: { stdout: JSON.stringify({ error: "legacy failure" }), stderr: "", exitCode: 1 },
    error: "legacy failure",
  });
  rmSync(root, { recursive: true, force: true });
});

test("legacy ok false values normalize to failures", async () => {
  expect(normalizeLegacyResult({ ok: false })).toEqual({
    ok: false, data: null, error: "legacy operation reported failure",
  });
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-false-"));
  try {
    const raw = await createRepoTools({
      ...runtime,
      runScript: (cwd: string) => ({
        exitCode: 0, stdout: JSON.stringify({ ok: false }), stderr: "", cwd,
      }),
    }).workflow_toolkit_init_apply.execute(
      { confirmed: true, action: "youtrack_scaffold" }, { directory: root, worktree: root} as never,
    );
    expect(JSON.parse(raw as string)).toEqual({
      ok: false,
      data: { stdout: JSON.stringify({ ok: false }), stderr: "", exitCode: 0 },
      error: "legacy operation reported failure",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutation paths cannot escape ToolContext.directory", async () => {
  calls.length = 0;
  const parent = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-boundary-"));
  try {
    const root = path.join(parent, "repo");
    const outside = path.join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const branchRaw = await createRepoTools(runtime).workflow_branch_setup.execute({
      confirmed: true, target_branch: "feature/native-tools", sdd_dir: "../outside",
    }, { directory: root, worktree: root} as never);
    expect(JSON.parse(branchRaw as string).error).toBe("path must stay inside repository root");
    expect(calls).toHaveLength(0);

    writeFileSync(path.join(outside, "CHANGELOG.md"), "# Outside\n");
    symlinkSync(path.join(outside, "CHANGELOG.md"), path.join(root, "CHANGELOG.md"));
    const changelogRaw = await createRepoTools(runtime).workflow_changelog_apply.execute({
      confirmed: true, entries: { Fixed: ["must stay inside"] },
    }, { directory: root, worktree: root} as never);
    expect(JSON.parse(changelogRaw as string).error).toBe("path must stay inside repository root");
    expect(readFileSync(path.join(outside, "CHANGELOG.md"), "utf8")).toBe("# Outside\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("changelog script path is package-owned", () => {
  const expectedRoot = path.resolve(import.meta.dir, "..", "packages", "workit");
  const script = path.join(PLUGIN_ROOT, "scripts/changelog/apply-unreleased.py");
  expect(PLUGIN_ROOT).toBe(expectedRoot);
  expect(script.startsWith(`${PLUGIN_ROOT}${path.sep}`)).toBe(true);
  expect(script).not.toContain(".cursor/plugins");
  expect(existsSync(script)).toBe(true);
});

test("changelog preserves rich Markdown while consolidating categories", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-"));
  try {
    const changelog = path.join(root, "CHANGELOG.md");
    writeFileSync(changelog, `# Changelog

## [Unreleased]

<!-- keep this comment -->

### Added

- Existing feature
  - nested detail
  continuation text

### Notes

Keep this custom section.

### Added

- Existing feature
- Second feature
  with continuation

## [1.0.0] - 2026-01-01

### Added

- Historical feature
`);
    const raw = await createRepoTools(runtime).workflow_changelog_apply.execute({
      confirmed: true, entries: { Added: ["New feature", "Existing feature"] },
    }, { directory: root, worktree: root} as never);
    expect(JSON.parse(raw as string).ok).toBe(true);
    const output = readFileSync(changelog, "utf8");
    const unreleased = output.split("## [1.0.0]")[0];
    expect((unreleased.match(/^### Added$/gm) ?? []).length).toBe(1);
    expect((unreleased.match(/^- Existing feature$/gm) ?? []).length).toBe(1);
    expect((unreleased.match(/^- New feature$/gm) ?? []).length).toBe(1);
    for (const preserved of [
      "<!-- keep this comment -->", "  - nested detail", "  continuation text", "### Notes",
      "Keep this custom section.", "  with continuation", "## [1.0.0] - 2026-01-01", "- Historical feature",
    ]) expect(output).toContain(preserved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed changelog apply without entries fails without editing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-empty-changelog-"));
  try {
    const changelog = path.join(root, "CHANGELOG.md");
    const before = "# Changelog\n\n## [Unreleased]\n";
    writeFileSync(changelog, before);
    const raw = await createRepoTools(runtime).workflow_changelog_apply.execute({
      confirmed: true,
    }, { directory: root, worktree: root} as never);
    expect(JSON.parse(raw as string)).toEqual({
      ok: false, data: null, error: "entries required unless normalize_only",
    });
    expect(readFileSync(changelog, "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changelog apply accepts a symlink-spelled ToolContext directory", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-linked-root-"));
  try {
    const root = path.join(parent, "repo");
    const linkedRoot = path.join(parent, "repo-link");
    mkdirSync(root);
    symlinkSync(root, linkedRoot);
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    const raw = await createRepoTools(runtime).workflow_changelog_apply.execute({
      confirmed: true, entries: { Fixed: ["Canonical root"] },
    }, { directory: linkedRoot, worktree: linkedRoot} as never);
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("- Canonical root");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("OpenCode init omits obsolete MCP dependency installation", () => {
  const action = createRepoTools(runtime).workflow_toolkit_init_apply.args.action;
  expect(action.safeParse("npm_install").success).toBe(false);

  const config = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-init-"));
  try {
    const status = spawnSync("bash", [path.join(PLUGIN_ROOT, "scripts/init/status.sh")], {
      encoding: "utf8", env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG: config },
    });
    expect(status.status).toBe(0);
    const data = JSON.parse(status.stdout);
    expect(data.items.some((item: { id: string }) => item.id === "mcp_deps")).toBe(false);

    const apply = spawnSync("bash", [path.join(PLUGIN_ROOT, "scripts/init/apply.sh"), "npm_install", "true"], {
      encoding: "utf8", env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG: config },
    });
    expect(apply.status).not.toBe(0);
    expect(apply.stderr).toContain("unknown action npm_install");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});
