import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin from "../src/plugin";

const names = [
  "wf-init", "wf-status", "wf-verify", "wf-commit", "wf-pr",
  "wf-changelog", "wf-release-notes", "wf-docs-refresh",
  "wf-handoff", "wf-implement", "wf-meetings", "wf-issue-update",
];

describe("plugin registration", () => {
  test("registers exactly the twelve wf commands and one skill path", async () => {
    const hooks = await plugin({ worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toHaveLength(1);
    expect(config.skills.paths[0]).toEndWith("workflow-toolkit-opencode/skills");
  });

  test("registration is idempotent with a preexisting skill path", async () => {
    const hooks = await plugin({ worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
    const skillPath = path.resolve(import.meta.dir, "../skills");
    const config: Record<string, any> = { skills: { paths: [skillPath] } };

    await hooks.config?.(config);
    await hooks.config?.(config);

    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toEqual([skillPath]);
  });

  test.serial("all native tool schemas return the standard JSON envelope for safe fixtures", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-tools-"));
    const envKeys = [
      "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "WORKFLOW_TOOLKIT_CONFIG",
      "WORKFLOW_YOUTRACK_CONFIG", "WORKFLOW_VCS_CONFIG", "PATH", "WF_CURL_SENTINEL",
    ] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      spawnSync("git", ["init", "-q", "-b", "feature/fixture"], { cwd: root });
      writeFileSync(path.join(root, "README.md"), "# Fixture\n");
      const ambientHome = path.join(root, "ambient-home");
      const ambientConfig = path.join(root, "ambient-config");
      const ambientToolkit = path.join(ambientConfig, "workflow-toolkit");
      const tokenPath = path.join(ambientToolkit, "youtrack.token");
      const fakeBin = path.join(root, "fake-bin");
      const curlSentinel = path.join(root, "curl-called");
      mkdirSync(ambientHome);
      mkdirSync(ambientToolkit, { recursive: true });
      mkdirSync(fakeBin);
      writeFileSync(tokenPath, "real-user-token\n", { mode: 0o600 });
      writeFileSync(path.join(ambientToolkit, "youtrack.json"), JSON.stringify({
        baseUrl: "https://youtrack.example.test", tokenFile: tokenPath,
      }));
      writeFileSync(path.join(fakeBin, "curl"), [
        "#!/bin/sh", 'printf called > "$WF_CURL_SENTINEL"', 'printf \'{"id":"fake","login":"fake"}\'', "",
      ].join("\n"), { mode: 0o755 });
      Object.assign(process.env, {
        HOME: ambientHome,
        XDG_CONFIG_HOME: ambientConfig,
        XDG_DATA_HOME: path.join(root, "ambient-data"),
        WORKFLOW_TOOLKIT_CONFIG: ambientToolkit,
        WORKFLOW_YOUTRACK_CONFIG: path.join(ambientToolkit, "youtrack.json"),
        WORKFLOW_VCS_CONFIG: path.join(ambientToolkit, "vcs.json"),
        PATH: `${fakeBin}:${previousEnv.PATH ?? ""}`,
        WF_CURL_SENTINEL: curlSentinel,
      });
      const isolatedHome = path.join(root, "home");
      const isolatedConfig = path.join(root, "xdg-config");
      const isolatedData = path.join(root, "xdg-data");
      const isolatedToolkit = path.join(isolatedConfig, "workflow-toolkit");
      mkdirSync(isolatedHome);
      mkdirSync(isolatedConfig);
      mkdirSync(isolatedData);
      Object.assign(process.env, {
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_DATA_HOME: isolatedData,
        WORKFLOW_TOOLKIT_CONFIG: isolatedToolkit,
        WORKFLOW_YOUTRACK_CONFIG: path.join(isolatedToolkit, "youtrack.json"),
        WORKFLOW_VCS_CONFIG: path.join(isolatedToolkit, "vcs.json"),
      });
      const hooks = await plugin({ worktree: root, serverUrl: new URL("http://localhost") } as never);
      const fixtures: Record<string, Record<string, unknown>> = {
        workflow_toolkit_init_status: {},
        workflow_toolkit_status: {},
        workflow_git_context: { paths: [] },
        workflow_verify: { dry_run: true },
        workflow_pr_context: {},
        workflow_changelog_context: {},
        workflow_release_notes_context: { range_or_tag: "HEAD" },
        workflow_docs_context: {},
        workflow_changelog_apply: { confirmed: false },
        workflow_branch_setup: { confirmed: false },
        workflow_commit: { confirmed: false, message: "test: fixture" },
        workflow_pr_create: { confirmed: false, title: "Fixture" },
        workflow_toolkit_init_apply: { confirmed: false, action: "youtrack_scaffold" },
        workflow_plan_tasks: { plan_path: "missing-plan.md" },
        workflow_resolve_branch: { spec_path: "missing-spec.md", plan_path: "missing-plan.md" },
        workflow_sdd_context: { plan_path: "missing-plan.md" },
        workflow_sdd_task_brief: {
          confirmed: false, sdd_dir: "docs/superpowers/sdd/fixture", task_id: 1, section_text: "Task",
        },
        workflow_sdd_review_package: {
          confirmed: false, sdd_dir: "docs/superpowers/sdd/fixture", base_sha: "HEAD", head_sha: "HEAD",
        },
        workflow_sdd_append_progress: {
          confirmed: false, progress_path: "docs/superpowers/sdd/fixture/progress.md", line: "Task 1: complete",
        },
        workflow_handoff_session: { message: "safe fixture", stay: true },
        workflow_youtrack_verify_token: {},
        workflow_youtrack_parse_issue: { issue_ref: "TEST-1" },
        workflow_youtrack_context: { mode: "task", issue_id: "TEST-1" },
        workflow_youtrack_parse_duration: { text: "30m" },
        workflow_youtrack_draft: { issueId: "TEST-1", userNotes: "Fixture" },
        workflow_youtrack_log_time: { confirmed: false, issueId: "TEST-1", minutes: 30 },
        workflow_youtrack_post: { confirmed: false, issueId: "TEST-1", markdown: "Fixture" },
      };

      const results: Record<string, Record<string, unknown>> = {};
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(Object.keys(fixtures).sort());
      for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
        const raw = await definition.execute(fixtures[name] as never, {
          worktree: root, sessionID: "fixture-session",
        } as never);
        const result = JSON.parse(raw as string);
        results[name] = result;
        expect(Object.keys(result).sort(), name).toEqual(["data", "error", "ok"]);
      }
      expect(results.workflow_youtrack_verify_token).toEqual({
        ok: false, data: null, error: `ENOENT: no such file or directory, open '${path.join(root, "xdg-config/workflow-toolkit/youtrack.json")}'`,
      });
      expect(existsSync(curlSentinel)).toBe(false);
      expect(existsSync(path.join(root, ".cursor/plugins/local/workflow-toolkit"))).toBe(false);
    } finally {
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("compaction includes only active workflow paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-"));
    mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(path.join(root, "docs/superpowers/specs/x-design.md"), "# X\n");
    writeFileSync(
      path.join(root, "docs/superpowers/plans/x.md"),
      "# X\n**Spec:** `docs/superpowers/specs/x-design.md`\n### Task 1: One\n",
    );
    const hooks = await plugin({ worktree: root, serverUrl: new URL("http://localhost") } as never);
    await hooks.tool?.workflow_plan_tasks.execute(
      { plan_path: "docs/superpowers/plans/x.md" },
      { worktree: root, sessionID: "s1" } as never,
    );
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, output);

    expect(output.context).toEqual([
      "Active workflow:\nSpec: docs/superpowers/specs/x-design.md\nPlan: docs/superpowers/plans/x.md\nSDD: docs/superpowers/sdd/x",
    ]);
  });
});
