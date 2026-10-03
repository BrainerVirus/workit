import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "@/packages/workit-opencode/src/tools/repo";
import {
  normalizeLegacyResult,
  type RepoRuntime,
} from "@/packages/workit-core/src/core/repo-tools";
import { initStatusData, initApplyData } from "@/packages/workit-core/src/core/init";
import { PLUGIN_ROOT } from "@/packages/workit-core/src/core/scripts";

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

type RuntimeCalls = {
  git: Array<{ root: string; args: string[] }>;
  verifyProject: Array<{ root: string; dryRun: boolean }>;
  prContext: Array<{ root: string; range?: string }>;
  changelogContext: Array<{ root: string; range?: string }>;
  docsContext: Array<{ root: string; range?: string }>;
  releaseContext: Array<{ root: string; range: string }>;
  initApply: Array<{ root: string; action: string; env: Record<string, string> }>;
};
const calls: RuntimeCalls = {
  git: [],
  verifyProject: [],
  prContext: [],
  changelogContext: [],
  docsContext: [],
  releaseContext: [],
  initApply: [],
};
const totalCalls = () => Object.values(calls).reduce((n, bucket) => n + bucket.length, 0);
const resetCalls = () => {
  for (const bucket of Object.values(calls)) bucket.length = 0;
};
const outputs: Record<string, string> = {
  "init/status.sh": JSON.stringify({ ready: false, items: [{ id: "config", ok: true }] }),
  "init/toolkit-status.sh": JSON.stringify({ ready: true, next_step: "All checks passed" }),
  "verify-project.sh":
    "# Verification Context\n\n## test\ncommand: bun test\nstatus: pass\n\n# Summary\npassed: 1\nfailed: 0\nskipped: 0\n",
  "pr-ready-context.sh":
    '# Context\n\n## Repository\nbranch: feature/native-tools\nrange: develop..HEAD\nbase_ref: develop\nmerge_base: abc123\ndiff_range: abc123..HEAD\nrange_mode: branch-exclusive\ngit_sync: current\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## PR Template\ntemplate_path: .github/pull_request_template.md\n\n## VCS Config\n{"provider":"github"}\n\n## Merged PR Style\n{"titles":["feat: example"]}\n',
  "changelog-context.sh":
    "# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Keep a Changelog Rules\n- Human readable\n\n## Existing CHANGELOG.md\n[Unreleased]\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n",
  "release-notes-context.sh":
    "# Context\n\n## Repository\nrequested: v1.0.0\nrange: v1.0.0..HEAD\n\n## Tags\nv1.0.0\n\n## Commits\nabc feat: tools\n\n## Diff Stat\n2 files changed\n\n## Changed Files\nsrc/tools/repo.ts\n\n## Existing Release Files\nCHANGELOG.md\n",
  "docs-refresh-context.sh":
    '# Context\n\n## Repository\nbranch: feature/native-tools\nrange: HEAD~1..HEAD\n\n## Changed Files\nsrc/plugin.ts\n\n## Documentation Files\nREADME.md\n\n## README Preview\n# Toolkit\n\n## Package Scripts\n{"test":"bun test"}\n',
  "branch/setup-branch.sh": JSON.stringify({ ok: true, branch: "feature/native-tools" }),
  "init/apply.sh": JSON.stringify({ ok: true, action: "youtrack_json" }),
};

const runtime: RepoRuntime = {
  git: (root: string, args: string[]) => {
    calls.git.push({ root, args });
    return {
      exitCode: 0,
      stdout: args[0] === "branch" ? "feature/native-tools\n" : "committed\n",
      stderr: "",
      cwd: root,
    };
  },
  verifyProject: (root: string, dryRun: boolean) => {
    calls.verifyProject.push({ root, dryRun });
    return { exitCode: 0, stdout: outputs["verify-project.sh"], stderr: "", cwd: root };
  },
  prContext: (root: string, range?: string) => {
    calls.prContext.push({ root, range });
    return { exitCode: 0, stdout: outputs["pr-ready-context.sh"], stderr: "", cwd: root };
  },
  changelogContext: (root: string, range?: string) => {
    calls.changelogContext.push({ root, range });
    return { exitCode: 0, stdout: outputs["changelog-context.sh"], stderr: "", cwd: root };
  },
  docsContext: (root: string, range?: string) => {
    calls.docsContext.push({ root, range });
    return { exitCode: 0, stdout: outputs["docs-refresh-context.sh"], stderr: "", cwd: root };
  },
  releaseContext: (root: string, range: string) => {
    calls.releaseContext.push({ root, range });
    return { exitCode: 0, stdout: outputs["release-notes-context.sh"], stderr: "", cwd: root };
  },
  initApply: (root: string, action: string, env: Record<string, string>) => {
    calls.initApply.push({ root, action, env });
    return { exitCode: 0, stdout: outputs["init/apply.sh"], stderr: "", cwd: root };
  },
  initStatus: (root: string) => ({
    exitCode: 0,
    stdout: outputs["init/status.sh"],
    stderr: "",
    cwd: root,
  }),
  toolkitStatus: (root: string) => ({
    exitCode: 0,
    stdout: outputs["init/toolkit-status.sh"],
    stderr: "",
    cwd: root,
  }),
};

const execute = async (
  name: keyof ReturnType<typeof createRepoTools>,
  args: Record<string, unknown> = {},
) => {
  const tools = createRepoTools(runtime);
  return JSON.parse(
    (await tools[name].execute(
      args as never,
      { directory: "/repo", worktree: "/repo" } as never,
    )) as string,
  );
};

test(
  "repo tools expose native names without workspace override",
  () => {
    const tools = createRepoTools(runtime);
    expect(Object.keys(tools).toSorted()).toEqual(
      [
        "workit_changelog_context",
        "workit_docs_context",
        "workit_git_context",
        "workit_pr_context",
        "workit_release_notes_context",
        "workit_init_status",
        "workit_status",
        "workit_verify",
        "workit_init_apply",
      ].toSorted(),
    );
    for (const definition of Object.values(tools)) {
      expect("workspace_root" in definition.args).toBe(false);
    }
  },
  { timeout: 60_000 },
);

test(
  "release notes rejects a missing range before running a script",
  async () => {
    resetCalls();
    expect(await execute("workit_release_notes_context", { range_or_tag: "" })).toEqual({
      ok: false,
      data: null,
      error: "release tag or range required",
    });
    expect(totalCalls()).toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "revision context rejects option-like inputs before scripts run",
  async () => {
    resetCalls();
    for (const [name, args] of [
      ["workit_pr_context", { range: "--output=/tmp/owned" }],
      ["workit_changelog_context", { range: "-p" }],
      ["workit_release_notes_context", { range_or_tag: "--help" }],
    ] as const) {
      const result = await execute(name, args);
      expect(result.error).toContain("invalid Git revision");
    }
    expect(totalCalls()).toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "revision context resolves revisions and cannot create option-selected files",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-revision-"));
    const outside = path.join(path.dirname(root), `wf-owned-${path.basename(root)}`);
    try {
      spawnSync("git", ["init", "-q", "-b", "feature/range"], { cwd: root });
      const raw = await createRepoTools().workit_changelog_context.execute(
        { range: `--output=${outside}` },
        { directory: root, worktree: root } as never,
      );
      expect(JSON.parse(raw as string).error).toContain("invalid Git revision");
      expect(existsSync(outside)).toBe(false);
      const missing = await createRepoTools().workit_changelog_context.execute(
        { range: "does-not-exist" },
        { directory: root, worktree: root } as never,
      );
      expect(JSON.parse(missing as string).error).toContain("invalid Git revision");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "script tools use ToolContext.directory",
  async () => {
    resetCalls();
    await execute("workit_verify", { dry_run: true });
    expect(calls.verifyProject).toEqual([{ root: "/repo", dryRun: true }]);
  },
  { timeout: 60_000 },
);

test(
  "verification output is structured",
  async () => {
    expect(await execute("workit_verify")).toEqual({
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
  },
  { timeout: 60_000 },
);

test(
  "repository context scripts return named fields",
  async () => {
    const pr = await execute("workit_pr_context");
    expect(pr.data).toMatchObject({
      branch: "feature/native-tools",
      range: "develop..HEAD",
      commits: "abc feat: tools",
      files: "src/tools/repo.ts",
      pr_template: "template_path: .github/pull_request_template.md",
      vcs_config: { provider: "github" },
      merged_pr_style: { titles: ["feat: example"] },
    });

    const changelog = await execute("workit_changelog_context");
    expect(changelog.data).toMatchObject({
      branch: "feature/native-tools",
      range: "HEAD~1..HEAD",
      changelog_excerpt: "[Unreleased]",
      rules: "- Human readable",
      commits: "abc feat: tools",
      files: "src/tools/repo.ts",
    });

    const release = await execute("workit_release_notes_context", { range_or_tag: "v1.0.0" });
    expect(release.data).toMatchObject({
      requested: "v1.0.0",
      range: "v1.0.0..HEAD",
      tags: "v1.0.0",
      commits: "abc feat: tools",
      files: "src/tools/repo.ts",
      release_files: "CHANGELOG.md",
    });

    const docs = await execute("workit_docs_context");
    expect(docs.data).toMatchObject({
      branch: "feature/native-tools",
      range: "HEAD~1..HEAD",
      changed_files: "src/plugin.ts",
      files: "README.md",
      readme_preview: "# Toolkit",
      package_scripts: '{"test":"bun test"}',
    });
  },
  { timeout: 60_000 },
);

test(
  "status scripts decode JSON into the Result data field",
  async () => {
    expect((await execute("workit_init_status")).data).toEqual({
      ready: false,
      items: [{ id: "config", ok: true }],
      exitCode: 0,
    });
    expect((await execute("workit_status")).data).toEqual({
      ready: true,
      next_step: "All checks passed",
      exitCode: 0,
    });
  },
  { timeout: 60_000 },
);

test(
  "script failures keep diagnostics in a failed Result",
  async () => {
    const failing = createRepoTools({
      ...runtime,
      docsContext: (root: string) => ({
        exitCode: 2,
        stdout: "partial",
        stderr: "broken",
        cwd: root,
      }),
    });
    const raw = await failing.workit_docs_context.execute({}, {
      directory: "/repo",
      worktree: "/repo",
    } as never);
    expect(JSON.parse(raw as string)).toEqual({
      ok: false,
      data: { stdout: "partial", stderr: "broken", exitCode: 2 },
      error: "broken",
    });
  },
  { timeout: 60_000 },
);

test(
  "init_apply rejects missing confirmation before any resolution",
  async () => {
    resetCalls();
    const tools = createRepoTools(runtime);
    const raw = await tools.workit_init_apply.execute(
      { confirmed: false } as never,
      { directory: "/repo", worktree: "/repo" } as never,
    );
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
    expect(totalCalls()).toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "PR context is read-only even with a remote and upstream",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-pr-readonly-"));
    const remote = mkdtempSync(path.join(os.tmpdir(), "wf-pr-remote-"));
    const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    try {
      git(remote, ["init", "-q", "--bare"]);
      git(root, ["init", "-q", "-b", "develop"]);
      git(root, ["config", "user.name", "Workflow Test"]);
      git(root, ["config", "user.email", "workflow@example.test"]);
      writeFileSync(path.join(root, "tracked.txt"), "base\n");
      git(root, ["add", "tracked.txt"]);
      git(root, ["commit", "-q", "-m", "base"]);
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["push", "-q", "-u", "origin", "develop"]);
      git(root, ["checkout", "-q", "-b", "feature/read-only"]);
      writeFileSync(path.join(root, "tracked.txt"), "base\nfeature\n");
      git(root, ["commit", "-q", "-am", "feature"]);
      git(root, ["push", "-q", "-u", "origin", "feature/read-only"]);
      writeFileSync(path.join(root, "tracked.txt"), "base\nfeature\nunstaged\n");
      writeFileSync(path.join(root, "untracked.txt"), "keep\n");
      const remoteCalled = path.join(root, "remote-called");
      const uploadPack = path.join(root, "upload-pack.sh");
      writeFileSync(uploadPack, `#!/bin/sh\ntouch '${remoteCalled}'\nexec git-upload-pack "$@"\n`, {
        mode: 0o755,
      });
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
      const raw = await createRepoTools().workit_pr_context.execute({}, {
        directory: root,
        worktree: root,
      } as never);
      expect(JSON.parse(raw as string).ok).toBe(true);
      expect(snapshot()).toEqual(before);
      expect(existsSync(remoteCalled)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "legacy ok false values normalize to failures",
  async () => {
    expect(normalizeLegacyResult({ ok: false })).toEqual({
      ok: false,
      data: null,
      error: "legacy operation reported failure",
    });
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-false-"));
    try {
      const raw = await createRepoTools({
        ...runtime,
        initApply: (cwd: string) => ({
          exitCode: 0,
          stdout: JSON.stringify({ ok: false }),
          stderr: "",
          cwd,
        }),
      }).workit_init_apply.execute({ confirmed: true, action: "youtrack_scaffold" }, {
        directory: root,
        worktree: root,
      } as never);
      expect(JSON.parse(raw as string)).toEqual({
        ok: false,
        data: { stdout: JSON.stringify({ ok: false }), stderr: "", exitCode: 0 },
        error: "legacy operation reported failure",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "changelog implementation is package-owned",
  () => {
    const expectedRoot = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core");
    const port = path.join(PLUGIN_ROOT, "src", "core", "changelog.ts");
    expect(PLUGIN_ROOT).toBe(expectedRoot);
    expect(port.startsWith(`${PLUGIN_ROOT}${path.sep}`)).toBe(true);
    expect(port).not.toContain(".cursor/plugins");
    expect(existsSync(port)).toBe(true);
  },
  { timeout: 60_000 },
);

test(
  "OpenCode init omits obsolete MCP dependency installation",
  () => {
    const action = createRepoTools(runtime).workit_init_apply.args.action;
    expect(action.safeParse("npm_install").success).toBe(false);

    const config = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-init-"));
    try {
      const status = initStatusData(config);
      expect((status.items as Array<{ id: string }>).some((item) => item.id === "mcp_deps")).toBe(
        false,
      );

      const apply = initApplyData("npm_install", {
        ...process.env,
        WORKFLOW_TOOLKIT_CONFIG: config,
      });
      expect(String(apply.error)).toContain("unknown action npm_install");
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "init_apply config locale validation matches core LOCALE_RE (es-419 in, es_cl out)",
  async () => {
    const previousToolkit = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-locale-"));
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    try {
      const tools = createRepoTools();
      const context = { directory: dir, worktree: dir } as never;

      const accepted = JSON.parse(
        (await tools.workit_init_apply.execute(
          { confirmed: true, action: "config", locale: "es-419" },
          context,
        )) as string,
      );
      expect(accepted.ok).toBe(true);
      expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"))).toMatchObject({
        locale: "es-419",
      });

      const rejected = JSON.parse(
        (await tools.workit_init_apply.execute(
          { confirmed: true, action: "config", locale: "es_cl" },
          context,
        )) as string,
      );
      expect(rejected.ok).toBe(false);
      expect(String(rejected.error)).toContain("invalid locale");
    } finally {
      if (previousToolkit === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousToolkit;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
