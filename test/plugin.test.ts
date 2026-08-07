import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin from "../src/plugin";
import { WorkflowStateStore } from "../src/state";

const names = [
  "wf-init",
  "wf-status",
  "wf-verify",
  "wf-commit",
  "wf-pr",
  "wf-changelog",
  "wf-release-notes",
  "wf-docs-refresh",
  "wf-handoff",
  "wf-implement",
  "wf-meetings",
  "wf-issue-update",
];

describe("plugin registration", () => {
  test("registers exactly the twelve wf commands and one skill path", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toHaveLength(2);
    const normalize = (p: string) => p.split(path.sep).join("/");
    expect(normalize(config.skills.paths[0])).toEndWith("workflow-toolkit/skills");
    expect(normalize(config.skills.paths[1])).toEndWith("vendor/superpowers/skills");
  });

  test("registration is idempotent with a preexisting skill path", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const skillPath = path.resolve(import.meta.dir, "../skills");
    const config: Record<string, any> = { skills: { paths: [skillPath] } };

    await hooks.config?.(config);
    await hooks.config?.(config);

    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toEqual([
      skillPath,
      path.resolve(import.meta.dir, "../vendor/superpowers/skills"),
    ]);
  });
  test("registers native bash deny rules for worktree creation", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = {
      permission: { bash: { "git status *": "allow" } },
    };

    await hooks.config?.(config);

    expect(config.permission.bash).toEqual({
      "git status *": "allow",
      "*git *worktree*": "deny",
    });
  });

  test("preserves global string-form permission while denying worktrees", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = { permission: "allow" };

    await hooks.config?.(config);

    expect(config.permission["*"]).toBe("allow");
    expect(config.permission.bash["*git *worktree*"]).toBe("deny");
  });

  test("preserves string-form bash permission as the default rule", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = { permission: { bash: "allow" } };

    await hooks.config?.(config);

    expect(config.permission.bash).toMatchObject({
      "*": "allow",
      "*git *worktree*": "deny",
    });
  });

  test("denies worktrees in agent-level permissions that override global rules", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = {
      permission: { bash: "allow" },
      agent: { build: { permission: { bash: { "git *": "allow" } } } },
    };

    await hooks.config?.(config);

    expect(config.agent.build.permission.bash["git *"]).toBe("allow");
    expect(config.agent.build.permission.bash["*git *worktree*"]).toBe("deny");
  });

  test("appends global and agent worktree denials after conflicting allows", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const conflicting = { "*git *worktree*": "allow", "*": "allow" };
    const config: Record<string, any> = {
      permission: { bash: { ...conflicting } },
      agent: { build: { permission: { bash: { ...conflicting } } } },
    };

    await hooks.config?.(config);

    expect(Object.entries(config.permission.bash).at(-1)).toEqual([
      "*git *worktree*",
      "deny",
    ]);
    expect(Object.entries(config.agent.build.permission.bash).at(-1)).toEqual([
      "*git *worktree*",
      "deny",
    ]);
  });

  test.serial(
    "all native tool schemas return the standard JSON envelope for safe fixtures",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-tools-"));
      const envKeys = [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "WORKFLOW_TOOLKIT_CONFIG",
        "WORKFLOW_YOUTRACK_CONFIG",
        "WORKFLOW_VCS_CONFIG",
        "PATH",
        "WF_CURL_SENTINEL",
      ] as const;
      const previousEnv = Object.fromEntries(
        envKeys.map((key) => [key, process.env[key]]),
      );
      try {
        spawnSync("git", ["init", "-q", "-b", "feature/fixture"], {
          cwd: root,
        });
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
        writeFileSync(
          path.join(ambientToolkit, "youtrack.json"),
          JSON.stringify({
            baseUrl: "https://youtrack.example.test",
            tokenFile: tokenPath,
          }),
        );
        writeFileSync(
          path.join(fakeBin, "curl"),
          [
            "#!/bin/sh",
            'printf called > "$WF_CURL_SENTINEL"',
            'printf \'{"id":"fake","login":"fake"}\'',
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
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
        const hooks = await plugin({
          directory: root,
          worktree: root,
          serverUrl: new URL("http://localhost"),
        } as never);
        const fixtures: Record<string, Record<string, unknown>> = {
          workflow_toolkit_init_status: {},
          workflow_toolkit_status: {},
          workflow_git_context: { paths: [] },
          workflow_verify: { dry_run: true },
          workflow_pr_context: {},
          workflow_changelog_context: {},
          workflow_release_notes_context: { range_or_tag: "HEAD" },
          workflow_docs_context: {},
          workflow_docs_validate: {
            spec_path: "missing-spec.md",
            plan_path: "missing-plan.md",
          },
          workflow_docs_branch: {},
          workflow_changelog_apply: { confirmed: false },
          workflow_branch_setup: { confirmed: false },
          workflow_commit: { confirmed: false, message: "test: fixture" },
          workflow_pr_create: { confirmed: false, title: "Fixture" },
          workflow_toolkit_init_apply: {
            confirmed: false,
            action: "youtrack_scaffold",
          },
          workflow_plan_tasks: { plan_path: "missing-plan.md" },
          workflow_resolve_branch: {
            spec_path: "missing-spec.md",
            plan_path: "missing-plan.md",
          },
          workflow_flow_status: { plan_path: "missing-plan.md" },
          workflow_docs_repo_link: { path: "missing", confirmed: false },
          workflow_docs_list: {},
          workflow_docs_promote: { slug: "x", confirmed: false },
          workflow_template_list: {},
          workflow_template_edit: { name: "issue-update", content: "x", confirmed: false },
          workflow_rule_list: {},
          workflow_rule_edit: { name: "x", description: "x", platforms: ["cursor"], body: "# X\\n", confirmed: false },
          workflow_spec_approve: {
            confirmed: false,
            spec_path: "missing-spec.md",
          },
          workflow_plan_approve: {
            confirmed: false,
            plan_path: "missing-plan.md",
          },
          workflow_plan_menu: {
            confirmed: false,
            plan_path: "missing-plan.md",
            choice: "inline",
          },
          workflow_sdd_context: { plan_path: "missing-plan.md" },
          workflow_sdd_task_brief: {
            confirmed: false,
            sdd_dir: "docs/fixture/sdd",
            task_id: 1,
            section_text: "Task",
          },
          workflow_sdd_review_package: {
            confirmed: false,
            sdd_dir: "docs/fixture/sdd",
            base_sha: "HEAD",
            head_sha: "HEAD",
          },
          workflow_sdd_append_progress: {
            confirmed: false,
            progress_path: "docs/fixture/sdd/progress.md",
            line: "Task 1: complete",
          },
          workflow_handoff_session: { message: "safe fixture --stay" },
          workflow_youtrack_verify_token: {},
          workflow_youtrack_parse_issue: { issue_ref: "TEST-1" },
          workflow_youtrack_context: { mode: "task", issue_id: "TEST-1" },
          workflow_youtrack_parse_duration: { text: "30m" },
          workflow_youtrack_draft: { issueId: "TEST-1", userNotes: "Fixture" },
          workflow_youtrack_log_time: {
            confirmed: false,
            issueId: "TEST-1",
            minutes: 30,
          },
          workflow_youtrack_post: {
            confirmed: false,
            issueId: "TEST-1",
            markdown: "Fixture",
          },
          workflow_present_ascii: {
            title: "Fixture",
            rows: [{ type: "header", label: "Title" }],
          },
          workflow_present_flow: {
            nodes: [{ id: "a", label: "Start" }],
            edges: [],
          },
        };

        const results: Record<string, Record<string, unknown>> = {};
        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
          Object.keys(fixtures).sort(),
        );
        for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
          const raw = await definition.execute(
            fixtures[name] as never,
            {
              directory: root,
              worktree: root,
              sessionID: "fixture-session",
            } as never,
          );
          const result = JSON.parse(raw as string);
          results[name] = result;
          expect(Object.keys(result).sort(), name).toEqual([
            "data",
            "error",
            "ok",
          ]);
        }
        expect(results.workflow_youtrack_verify_token).toEqual({
          ok: false,
          data: null,
          error: `ENOENT: no such file or directory, open '${path.join(root, "xdg-config/workflow-toolkit/youtrack.json")}'`,
        });
        expect(existsSync(curlSentinel)).toBe(false);
        expect(
          existsSync(path.join(root, ".cursor/plugins/local/workflow-toolkit")),
        ).toBe(false);
      } finally {
        for (const key of envKeys) {
          const value = previousEnv[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test("handoff uses the live client supplied by OpenCode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-handoff-"));
    const calls: string[] = [];
    try {
      mkdirSync(path.join(root, "docs", "x"), { recursive: true });
      mkdirSync(path.join(root, "docs", "x"), { recursive: true });
      writeFileSync(
        path.join(root, "docs/x/spec.md"),
        "# X\n\n**Branch:** `feature/x`\n",
      );
      writeFileSync(
        path.join(root, "docs/x/plan.md"),
        "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
      writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify({
        slug: "x",
        spec: { path: "docs/x/spec.md", status: "approved" },
        plan: { path: "docs/x/plan.md", status: "approved" },
        menu: { presented: true, chosen: "handoff" },
        updated_at: Date.now(),
      }));
      const client = {
        session: {
          async create() {
            calls.push("create");
            return { data: { id: "child-live" } };
          },
          async promptAsync() {
            calls.push("seed");
            return { data: undefined };
          },
        },
        tui: {
          async publish() {
            calls.push("publish");
            return { data: true };
          },
        },
      };
      const hooks = await plugin({
        client,
        directory: root,
        worktree: root,
        serverUrl: new URL("http://unreachable.invalid"),
      } as never);
      const raw = await hooks.tool?.workflow_handoff_session.execute(
        {
          message:
            "docs/x/spec.md docs/x/plan.md --stay",
        },
        { directory: root, worktree: root, sessionID: "parent" } as never,
      );

      expect(JSON.parse(raw as string)).toEqual({
        ok: true,
        data: { sessionID: "child-live", seeded: true, selected: false },
        error: null,
      });
      expect(calls).toEqual(["create", "seed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compaction includes only active workflow paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-"));
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(
      path.join(root, "docs/x/spec.md"),
      "# X\n",
    );
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n**Spec:** `docs/x/spec.md`\n### Task 1: One\n",
    );
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await hooks.tool?.workflow_plan_tasks.execute(
      { plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s1" } as never,
    );
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]?.(
      { sessionID: "s1" },
      output,
    );

    expect(output.context).toEqual([
      "Active workflow:\nSpec: docs/x/spec.md\nPlan: docs/x/plan.md\nSDD: docs/x/sdd",
    ]);
  });
});

test("compaction context includes active workflow paths only", () => {
  const state = new WorkflowStateStore();
  expect(state.compactionContext("missing")).toBeNull();
  state.set("s1", { spec: "a.md", plan: "b.md", sdd: "sdd/x" });
  expect(state.compactionContext("s1")).toContain("Spec: a.md");
  expect(state.compactionContext("s1")).toContain("SDD: sdd/x");
});

test("config registers vendored superpowers skills alongside toolkit skills", async () => {
  const hooks = await plugin({
    directory: "/repo", worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  const paths = config.skills.paths as string[];
  const normalized = paths.map((p) => p.split(path.sep).join("/"));
  expect(normalized.some((p) => p.endsWith("/skills"))).toBe(true);
  expect(normalized.some((p) => p.endsWith("/vendor/superpowers/skills"))).toBe(true);
});
