import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as pluginModule from "../../packages/workit-opencode/src/plugin";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";

const plugin = pluginModule.default;

const names = [
  "wk-init",
  "wk-status",
  "wk-verify",
  "wk-commit",
  "wk-pr",
  "wk-changelog",
  "wk-release-notes",
  "wk-docs-refresh",
  "wk-handoff",
  "wk-implement",
  "wk-meetings",
  "wk-issue-update",
];

test("the plugin module only exports the default OpenCode plugin", () => {
  expect(Object.keys(pluginModule)).toEqual(["default"]);
});

import {
  COORDINATOR_RECOVERY_TEXT,
  COORDINATOR_SHELL_DENIED_TEXT,
  HostReceiptStore,
  prepareFlowState,
  readEffectiveFlowState,
  recordMenuChoice,
  transitionExecution,
  transitionPlan,
  transitionSpec,
  createOpenCodeEvidence,
} from "../../packages/workit-core/src/core/flow-state";

const PLUGIN_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const PLUGIN_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const flowFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-flow-"));
  const slug = "plug-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), PLUGIN_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), PLUGIN_PLAN(slug));
  return { root, slug };
};

// Real host-observed receipt path: the plugin's tool.execute.after hook records
// the answered native question for the session, and workflow_spec_approve
// consumes the session's MOST RECENT receipt (no evidence argument exists
// anywhere in the tool schema). Correlation is by session + freshness + one-use
// + negative-answer rejection, not by an execution window (FINDING 2).
test("the plugin records a real question result as a one-use receipt and the approval tool consumes it", async () => {
  const { root, slug } = flowFixture();
  try {
    const client = {
      session: { get: async () => ({ data: {} }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const spec = `docs/${slug}/spec.md`;
    await hooks.tool?.workflow_flow_status.execute({ plan_path: `docs/${slug}/plan.md` }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);

    // No receipt yet: approval fails with the host-observed-receipt error.
    const before = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    expect(JSON.parse(before as string).ok).toBe(false);

    // The user answers the native question; the after-hook records the
    // receipt, and the approval tool consumes the most recent one.
    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "s1", callID: "call-1", args: {} },
      {
        title: "Asked 1 question",
        output: "User has answered your questions",
        metadata: { answers: [["Approve spec"]] },
      },
    );
    const after = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    const result = JSON.parse(after as string);
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("approved");

    // Replay fails: the receipt was consumed exactly once.
    const replay = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    expect(JSON.parse(replay as string).ok).toBe(false);

    // The single receipt consumed the whole draft -> approved transition: a
    // fresh answer on an already-approved spec cannot advance further and the
    // receipt IS spent (consume-before-transition).
    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "s1", callID: "call-2", args: {} },
      {
        title: "Asked 1 question",
        output: "User has answered your questions",
        metadata: { answers: [["Approve spec"]] },
      },
    );
    const second = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    const secondResult = JSON.parse(second as string);
    expect(secondResult.ok).toBe(false);
    expect(secondResult.data?.code).toBe("flow_already_approved");

    // A forged multi-select answer produces no receipt (single-select only).
    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "s1", callID: "call-3", args: {} },
      {
        title: "Asked 1 question",
        output: "User has answered your questions",
        metadata: { answers: [["A", "B"]] },
      },
    );
    const noReceipt = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    expect(JSON.parse(noReceipt as string).ok).toBe(false);

    // A negative answer can never be laundered into an approval: it is
    // rejected and spent (FINDING 3).
    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "s1", callID: "call-4", args: {} },
      {
        title: "Asked 1 question",
        output: "User has answered your questions",
        metadata: { answers: [["No"]] },
      },
    );
    const negative = await hooks.tool?.workflow_spec_approve.execute({ spec_path: spec }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    const negativeResult = JSON.parse(negative as string);
    expect(negativeResult.ok).toBe(false);
    expect(negativeResult.data?.code).toBe("receipt_rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const establishSubagentDriven = (root: string, slug: string) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const store = new HostReceiptStore();
  const ev = (label: string) => {
    store.record("root", `call-${label}`, label);
    const consumed = store.consume("root");
    if (!consumed.ok) throw new Error(consumed.error);
    return createOpenCodeEvidence(consumed.receipt);
  };
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  for (const step of [
    transitionSpec(root, slug, spec, ev("Approve")),
    transitionPlan(root, slug, plan, ev("Approve")),
  ])
    if (!step.ok) throw new Error(step.error);
  const menu = recordMenuChoice(root, slug, plan, "subagent-driven", ev("subagent-driven"));
  if (!menu.ok) throw new Error(menu.error);
};

test("tool.execute.before denies root-session write tools and mutating shell while subagent-driven is active", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);

    for (const tool of ["write", "edit", "apply_patch", "patch", "workflow_commit"]) {
      const output = { args: {} };
      let thrown: Error | undefined;
      try {
        await hooks["tool.execute.before"]?.(
          { tool, sessionID: "root-session", callID: `c-${tool}` },
          output,
        );
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown, tool).toBeDefined();
      expect(thrown?.message, tool).toContain(COORDINATOR_RECOVERY_TEXT);
    }

    const mutating = { args: { command: "git push origin main" } };
    let shellError: Error | undefined;
    try {
      await hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "root-session", callID: "c-bash" },
        mutating,
      );
    } catch (error) {
      shellError = error as Error;
    }
    expect(shellError).toBeDefined();
    expect(shellError?.message).toContain(COORDINATOR_SHELL_DENIED_TEXT);

    // The bounded allowlist keeps read/test/review commands working.
    for (const command of [
      "cat spec.md",
      "git status",
      "bun run check",
      "bun test test/x.test.ts",
    ]) {
      const allowed = { args: { command } };
      await expect(
        hooks["tool.execute.before"]?.(
          { tool: "bash", sessionID: "root-session", callID: "c-allow" },
          allowed,
        ),
      ).resolves.toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.execute.before never intercepts delegated child sessions", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    const client = {
      session: {
        get: async () => ({ data: { parentID: "root-session", directory: root } }),
      },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const output = { args: { command: "rm -rf docs" } };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "child-session", callID: "c-1" },
        output,
      ),
    ).resolves.toBeUndefined();
    const write = { args: {} };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "child-session", callID: "c-2" },
        write,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.execute.before leaves the root session alone when no subagent-driven plan is active", async () => {
  const { root } = flowFixture();
  try {
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const output = { args: { command: "rm -rf docs" } };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "root-session", callID: "c-1" },
        output,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const cliLifecycleEvidence = () => ({ host: "cli", attested: false, confirmation: "flag" }) as const;

test("tool.execute.before leaves the root session usable once the plan is paused", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    expect(
      transitionExecution(root, slug, `docs/${slug}/plan.md`, "pause", cliLifecycleEvidence()).ok,
    ).toBe(true);
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const write = { args: {} };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "root-session", callID: "c-paused" },
        write,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.execute.before leaves the root session usable once the plan is completed", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs", slug, "sdd", "progress.md"), "Task 1: complete\n");
    writeFileSync(path.join(root, "CHANGELOG.md"), "## [Unreleased]\n\n- fixture\n");
    expect(
      transitionExecution(
        root,
        slug,
        `docs/${slug}/plan.md`,
        "complete",
        cliLifecycleEvidence(),
        undefined,
        { verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: root }) },
      ).ok,
    ).toBe(true);
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const write = { args: {} };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "root-session", callID: "c-completed" },
        write,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.execute.before leaves the root session usable for an active inline flow", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    // Record an active INLINE menu choice instead of the subagent-driven one.
    const store = new HostReceiptStore();
    const menu = recordMenuChoice(
      root,
      slug,
      `docs/${slug}/plan.md`,
      "inline",
      createOpenCodeEvidence(
        (() => {
          store.record("root", "call-inline", "inline");
          const consumed = store.consume("root");
          if (!consumed.ok) throw new Error(consumed.error);
          return consumed.receipt;
        })(),
      ),
    );
    expect(menu.ok).toBe(true);
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const write = { args: {} };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "root-session", callID: "c-inline" },
        write,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.execute.before leaves the root session usable for a stale (drift-reset) subagent-driven flow", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    // Editing the approved plan introduces approval drift: the effective read
    // reconciles it and resets execution to pending, so the rail is off.
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      PLUGIN_PLAN(slug).replace("do it", "do it now"),
    );
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const write = { args: {} };
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "root-session", callID: "c-stale" },
        write,
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plugin records lifecycle answers as one-use receipts consumed by the lifecycle tools", async () => {
  const { root, slug } = flowFixture();
  try {
    establishSubagentDriven(root, slug);
    const client = {
      session: { get: async () => ({ data: { directory: root } }) },
    };
    const hooks = await plugin({
      client,
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const plan = `docs/${slug}/plan.md`;

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "root", callID: "call-pause", args: {} },
      {
        title: "Pause the plan?",
        output: "User has answered your questions",
        metadata: { answers: [["Pause plan"]] },
      },
    );
    const paused = await hooks.tool?.workflow_plan_pause.execute({ plan_path: plan }, {
      directory: root,
      worktree: root,
      sessionID: "root",
    } as never);
    const pausedResult = JSON.parse(paused as string);
    expect(pausedResult.ok).toBe(true);
    expect(pausedResult.data.execution.status).toBe("paused");

    // Replay fails: the pause receipt was spent exactly once.
    const replay = await hooks.tool?.workflow_plan_pause.execute({ plan_path: plan }, {
      directory: root,
      worktree: root,
      sessionID: "root",
    } as never);
    expect(JSON.parse(replay as string).ok).toBe(false);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "root", callID: "call-resume", args: {} },
      {
        title: "Resume the plan?",
        output: "User has answered your questions",
        metadata: { answers: [["Resume plan"]] },
      },
    );
    const resumed = await hooks.tool?.workflow_plan_resume.execute({ plan_path: plan }, {
      directory: root,
      worktree: root,
      sessionID: "root",
    } as never);
    const resumedResult = JSON.parse(resumed as string);
    expect(resumedResult.ok).toBe(true);
    expect(resumedResult.data.execution.status).toBe("active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin registration", () => {
  test("registers exactly the twelve wk commands and one skill path", async () => {
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
    expect(normalize(config.skills.paths[0])).toEndWith("assets/skills");
    expect(normalize(config.skills.paths[1])).toEndWith("assets/vendor/superpowers/skills");
  });

  test("registration is idempotent with a preexisting skill path", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const skillPath = path.resolve(import.meta.dir, "../../packages/workit-opencode/assets/skills");
    const config: Record<string, any> = { skills: { paths: [skillPath] } };

    await hooks.config?.(config);
    await hooks.config?.(config);

    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toEqual([
      skillPath,
      path.resolve(
        import.meta.dir,
        "../../packages/workit-opencode/assets/vendor/superpowers/skills",
      ),
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

    expect(Object.entries(config.permission.bash).at(-1)).toEqual(["*git *worktree*", "deny"]);
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
      const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
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
          workflow_doctor: {},
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
          workflow_docs_layout: { slug: "fixture-layout" },
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
          workflow_rule_edit: {
            name: "x",
            description: "x",
            platforms: ["cursor"],
            body: "# X\\n",
            confirmed: false,
          },
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
          workflow_plan_pause: { plan_path: "missing-plan.md" },
          workflow_plan_resume: { plan_path: "missing-plan.md" },
          workflow_plan_complete: { plan_path: "missing-plan.md" },
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
        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(Object.keys(fixtures).sort());
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
          expect(Object.keys(result).sort(), name).toEqual(["data", "error", "ok"]);
        }
        expect(results.workflow_youtrack_verify_token).toEqual({
          ok: false,
          data: null,
          error:
            "workflow config missing: youtrack_json, youtrack_token. Run `npx workit init` or `/wk-init` to configure.",
        });
        expect(existsSync(curlSentinel)).toBe(false);
        expect(existsSync(path.join(root, ".cursor/plugins/local/workit"))).toBe(false);
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
      writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
      writeFileSync(
        path.join(root, "docs/x/plan.md"),
        "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
      const flowJson = {
        slug: "x",
        activated: true,
        spec: {
          path: "docs/x/spec.md",
          status: "approved",
          evidence: null,
          approved_digest: createHash("sha256")
            .update(readFileSync(path.join(root, "docs/x/spec.md")))
            .digest("hex"),
        },
        plan: {
          path: "docs/x/plan.md",
          status: "approved",
          evidence: null,
          approved_digest: createHash("sha256")
            .update(readFileSync(path.join(root, "docs/x/plan.md")))
            .digest("hex"),
        },
        menu: { presented: true, chosen: "handoff", evidence: null },
        execution: { status: "pending", mode: null, evidence: null },
        handoff_destination: false,
        updated_at: Date.now(),
      };
      writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify(flowJson, null, 2) + "\n");
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
          message: "docs/x/spec.md docs/x/plan.md --stay",
        },
        { directory: root, worktree: root, sessionID: "parent" } as never,
      );

      expect(JSON.parse(raw as string)).toEqual({
        ok: true,
        data: { sessionID: "child-live", seeded: true, selected: false },
        error: null,
      });
      expect(calls).toEqual(["create", "seed"]);
      // Destination marking happens after a successful seed: the flow is now
      // a marked handoff destination with the source menu choice reset.
      const effective = readEffectiveFlowState(root, "x");
      expect(effective.ok).toBe(true);
      if (effective.ok) {
        expect(effective.state.handoff_destination).toBe(true);
        expect(effective.state.menu).toEqual({ presented: false, chosen: "", evidence: null });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compaction includes only active workflow paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-"));
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n**Spec:** `docs/x/spec.md`\n### Task 1: One\n",
    );
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await hooks.tool?.workflow_plan_tasks.execute({ plan_path: "docs/x/plan.md" }, {
      directory: root,
      worktree: root,
      sessionID: "s1",
    } as never);
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, output);

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
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  const paths = config.skills.paths as string[];
  const normalized = paths.map((p) => p.split(path.sep).join("/"));
  expect(normalized.some((p) => p.endsWith("/skills"))).toBe(true);
  expect(normalized.some((p) => p.endsWith("/vendor/superpowers/skills"))).toBe(true);
});
