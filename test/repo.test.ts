import { expect, test } from "bun:test";
import { createRepoTools } from "../src/tools/repo";

const calls: Array<{ root: string; script: string; args: string[] }> = [];
const outputs: Record<string, string> = {
  "init/status.sh": JSON.stringify({ ready: false, items: [{ id: "config", ok: true }] }),
  "init/toolkit-status.sh": JSON.stringify({ ready: true, next_step: "All checks passed" }),
  "verify-project.sh": "# Verification Context\n\n## test\ncommand: bun test\nstatus: pass\n\n# Summary\npassed: 1\nfailed: 0\nskipped: 0\n",
  "pr-ready-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: develop..HEAD\nbase_ref: develop\nmerge_base: abc123\ndiff_range: abc123..HEAD\nrange_mode: branch-exclusive\ngit_sync: current\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## PR Template\ntemplate_path: .github/pull_request_template.md\n\n## VCS Config\n{\"provider\":\"github\"}\n\n## Merged PR Style\n{\"titles\":[\"feat: example\"]}\n",
  "changelog-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Keep a Changelog Rules\n- Human readable\n\n## Existing CHANGELOG.md\n[Unreleased]\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n",
  "release-notes-context.sh": "# Context\n\n## Repository\nrequested: v1.0.0\nrange: v1.0.0..HEAD\n\n## Tags\nv1.0.0\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## Existing Release Files\nCHANGELOG.md\n",
  "docs-refresh-context.sh": "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Changed Files\nsrc/plugin.ts\n\n## Documentation Files\nREADME.md\n\n## README Preview\n# Toolkit\n\n## Package Scripts\n{\"test\":\"bun test\"}\n",
};

const runtime = {
  runScript: (root: string, script: string, args: string[]) => {
    calls.push({ root, script, args });
    return { exitCode: 0, stdout: outputs[script] ?? "", stderr: "", cwd: root };
  },
  git: (_root: string, _args: string[]) => ({ exitCode: 0, stdout: "", stderr: "", cwd: "/repo" }),
};

const execute = async (name: keyof ReturnType<typeof createRepoTools>, args: Record<string, unknown> = {}) => {
  const tools = createRepoTools(runtime);
  return JSON.parse(await tools[name].execute(args as never, { worktree: "/repo" } as never) as string);
};

test("repo tools expose native names without workspace override", () => {
  const tools = createRepoTools(runtime);
  expect(Object.keys(tools).sort()).toEqual([
    "workflow_changelog_context", "workflow_docs_context", "workflow_git_context",
    "workflow_pr_context", "workflow_release_notes_context", "workflow_toolkit_init_status",
    "workflow_toolkit_status", "workflow_verify",
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

test("script tools use ToolContext.worktree", async () => {
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
  const raw = await failing.workflow_docs_context.execute({}, { worktree: "/repo" } as never);
  expect(JSON.parse(raw as string)).toEqual({
    ok: false,
    data: { stdout: "partial", stderr: "broken", exitCode: 2 },
    error: "broken",
  });
});
