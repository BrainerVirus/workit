import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runScript } from "../../src/core/scripts";
import { parseSections, parseKeyValueLines } from "../../src/core/parse-sections";
import { parseVerifyOutput } from "../../src/core/verify-parse";
import { gitContext } from "../../src/core/git";
import { parsePlanTasks, resolveHandoffBranch } from "../../src/core/plan-tasks";
import { buildHandoffPrompt } from "../../src/tools/handoff";
import { readFlowState, transitionSpec, transitionPlan, recordMenuChoice, slugFromPath } from "../../src/core/flow-state";
import { initStatus, initApply, toolkitStatus } from "../../src/core/init";
import { resolveBranch, branchSetup } from "../../src/core/branch";
import { docsValidate } from "../../src/core/docs-validate";
import { docsBranch } from "../../src/core/branch";
import {
  sddContext,
  sddTaskBrief,
  sddReviewPackage,
  sddAppendProgress,
} from "../../src/core/sdd";
import {
  verifyYouTrackToken,
  context as youtrackContext,
  parseIssueRef as youtrackParseIssueRef,
  parseDuration as youtrackParseDuration,
  logTime as youtrackLogTime,
  buildDraft as youtrackBuildDraft,
  postUpdate as youtrackPostUpdate,
} from "../../src/core/youtrack";
import { asciiWireframe, flowDiagram } from "../../src/core/present";
import { withWorkspace } from "../../src/core/repo-tool";
import {
  changelogApply,
  changelogUnreleasedStats,
} from "../../src/core/changelog";

const workspaceRootSchema = z
  .string()
  .optional()
  .describe(
    "Git repository root. Defaults to the Cursor workspace folder (${workspaceFolder}).",
  );

const server = new McpServer({
  name: "workflow-toolkit",
  version: "0.3.19",
});

function extractPlanPath(prompt) {
  const match = prompt.match(/\*\*Plan:\*\* (.+)/);
  return match?.[1]?.trim() ?? null;
}

function extractSpecPath(prompt) {
  const match = prompt.match(/\*\*Spec:\*\* (.+)/);
  return match?.[1]?.trim() ?? null;
}

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

server.registerTool(
  "workflow_verify",
  {
    description:
      "Run project validation scripts (verify-project.sh). Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      dry_run: z.boolean().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ dry_run, workspace_root }) => {
    const args = dry_run ? ["--dry-run"] : [];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "verify-project.sh",
      args,
      workspace_root,
    );
    const parsed = parseVerifyOutput(stdout);
    return jsonResult(
      withWorkspace(workspace_root, {
        ...parsed,
        exitCode,
        stderr: stderr || undefined,
        stdout,
        workspace_root: cwd,
      }),
    );
  },
);

server.registerTool(
  "workflow_pr_context",
  {
    description:
      "Gather PR-ready repository context. On feature/* or bugfix/*, fetches and fast-forwards develop + current branch before diffing against develop.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const args = range ? [range] : [];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "pr-ready-context.sh",
      args,
      workspace_root,
    );
    if (exitCode !== 0) {
      const errLines = (stderr + "\n" + stdout).split("\n");
      const error =
        errLines.find((l) => l.startsWith("ERROR:")) ??
        stderr.trim() ??
        "pr-ready-context failed";
      return jsonResult(
        withWorkspace(workspace_root, {
          error,
          exitCode,
          workspace_root: cwd,
          stderr: stderr || undefined,
        }),
      );
    }
    const sections = parseSections(stdout);
    const repo = parseKeyValueLines(sections.Repository ?? "", [
      "branch",
      "range",
      "base_ref",
      "merge_base",
      "diff_range",
      "range_mode",
      "git_sync",
    ]);
    let vcsConfig = null;
    let mergedPrStyle = null;
    try {
      vcsConfig = JSON.parse((sections["VCS Config"] ?? "").trim());
    } catch {
      /* optional */
    }
    try {
      mergedPrStyle = JSON.parse((sections["Merged PR Style"] ?? "").trim());
    } catch {
      /* optional */
    }
    return jsonResult(
      withWorkspace(workspace_root, {
        branch: repo.branch,
        range: repo.range,
        base_ref: repo.base_ref,
        merge_base: repo.merge_base,
        diff_range: repo.diff_range,
        range_mode: repo.range_mode,
        git_sync: repo.git_sync,
        workspace_root: cwd,
        commits: sections.Commits ?? "",
        diff_stat: sections["Diff Stat"] ?? "",
        files: sections["Changed Files"] ?? "",
        pr_template: sections["PR Template"] ?? "",
        vcs_config: vcsConfig,
        merged_pr_style: mergedPrStyle,
        body_style_rules: [
          "Use ## Summary (short outcome bullets) and ## Validation or ## Test plan only",
          "Never add ## Notes with branch names, commit counts, diff stats, or scope disclaimers",
          "Never paste commit log, diff stat, or changed-files list into the MR/PR body",
          "Commits/diff in context are for drafting only — not for the published description",
        ],
        stdout,
        exitCode,
        stderr: stderr || undefined,
      }),
    );
  },
);

server.registerTool(
  "workflow_pr_create",
  {
    description:
      "Create GitLab MR or GitHub PR via glab/gh using vcs.json — requires confirmed: true",
    inputSchema: {
      confirmed: z.boolean(),
      title: z.string(),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      target_branch: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({
    confirmed,
    title,
    body,
    draft,
    target_branch,
    workspace_root,
  }) => {
    if (!confirmed) return jsonResult({ error: "confirmed: true required" });
    const { stdout, stderr, exitCode, cwd } = runScript(
      "pr-create.sh",
      [],
      workspace_root,
      {
        WF_PR_TITLE: title,
        WF_PR_BODY: body ?? "",
        WF_PR_CONFIRMED: "true",
        WF_PR_DRAFT: draft ? "true" : "false",
        WF_PR_TARGET: target_branch ?? "",
      },
    );
    try {
      const data = JSON.parse(stdout.trim());
      if (data.error) {
        return jsonResult(withWorkspace(workspace_root, { error: data.error, ...data }));
      }
      return jsonResult(withWorkspace(workspace_root, { ...data, workspace_root: cwd }));
    } catch {
      return jsonResult(
        withWorkspace(workspace_root, {
          error: stderr.trim() || stdout.trim() || "pr-create failed",
          exitCode,
        }),
      );
    }
  },
);

server.registerTool(
  "workflow_changelog_context",
  {
    description:
      "Gather changelog update context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const args = range ? [range] : [];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "changelog-context.sh",
      args,
      workspace_root,
    );
    const sections = parseSections(stdout);
    const unreleased = changelogUnreleasedStats(workspace_root);
    return jsonResult(
      withWorkspace(workspace_root, {
        changelog_excerpt: sections["Existing CHANGELOG.md"] ?? "",
        rules: sections["Keep a Changelog Rules"] ?? "",
        commits: sections.Commits ?? "",
        diff_stat: sections["Diff Stat"] ?? "",
        files: sections["Changed Files"] ?? "",
        unreleased,
        apply_hint:
          "ALWAYS merge via workflow_changelog_apply — never hand-edit ### Added/Changed/… under [Unreleased].",
        workspace_root: cwd,
        stdout,
        exitCode,
        stderr: stderr || undefined,
      }),
    );
  },
);

const changelogCategorySchema = z.enum([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);

server.registerTool(
  "workflow_changelog_apply",
  {
    description:
      "Merge Keep a Changelog bullets into ## [Unreleased] under the correct ### category. Collapses duplicate category headings. NEVER append a second ### Added block.",
    inputSchema: {
      entries: z
        .union([
          z.record(changelogCategorySchema, z.array(z.string())),
          z.array(
            z.object({
              category: changelogCategorySchema,
              text: z.string(),
            }),
          ),
        ])
        .optional(),
      normalize_only: z
        .boolean()
        .optional()
        .describe(
          "If true, only collapse duplicate ### headings under [Unreleased] (no new bullets).",
        ),
      path: z.string().optional().describe("Defaults to CHANGELOG.md"),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ entries, normalize_only, path: changelogPath, workspace_root }) => {
    const data = changelogApply({
      entries,
      path: changelogPath,
      normalize_only,
      workspace_root,
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(
      withWorkspace(workspace_root, {
        ...data,
        unreleased: changelogUnreleasedStats(workspace_root, changelogPath),
      }),
    );
  },
);

server.registerTool(
  "workflow_release_notes_context",
  {
    description:
      "Gather release notes context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range_or_tag: z.string().min(1),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range_or_tag, workspace_root }) => {
    const args = [range_or_tag];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "release-notes-context.sh",
      args,
      workspace_root,
    );
    const sections = parseSections(stdout);
    const repo = parseKeyValueLines(sections.Repository ?? "", [
      "requested",
      "range",
    ]);
    return jsonResult(
      withWorkspace(workspace_root, {
        requested: repo.requested,
        range: repo.range,
        tags: sections.Tags ?? "",
        commits: sections.Commits ?? "",
        diff_stat: sections["Diff Stat"] ?? "",
        files: sections["Changed Files"] ?? "",
        release_files: sections["Existing Release Files"] ?? "",
        workspace_root: cwd,
        stdout,
        exitCode,
        stderr: stderr || undefined,
      }),
    );
  },
);

server.registerTool(
  "workflow_docs_context",
  {
    description:
      "Gather docs refresh context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const args = range ? [range] : [];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "docs-refresh-context.sh",
      args,
      workspace_root,
    );
    const sections = parseSections(stdout);
    return jsonResult(
      withWorkspace(workspace_root, {
        changed_files: sections["Changed Files"] ?? "",
        readme_preview: sections["README Preview"] ?? "",
        package_scripts: sections["Package Scripts"] ?? "",
        files: sections["Documentation Files"] ?? "",
        workspace_root: cwd,
        stdout,
        exitCode,
        stderr: stderr || undefined,
      }),
    );
  },
);

server.registerTool(
  "workflow_git_context",
  {
    description:
      "Gather git status for commit skill. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      paths: z.array(z.string()).optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ paths, workspace_root }) => {
    const data = gitContext(workspace_root, paths ?? []);
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_resolve_branch",
  {
    description:
      "Resolve feature/* or bugfix/* branch from spec/plan. Returns current_branch, dirty, needs_checkout. No worktrees.",
    inputSchema: {
      spec_path: z.string(),
      plan_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ spec_path, plan_path, workspace_root }) => {
    const data = resolveBranch({ spec_path, plan_path, workspace_root });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_branch_setup",
  {
    description:
      "In-place checkout of feature/* or bugfix/* branch. Stash required when dirty. NEVER uses worktrees.",
    inputSchema: {
      action: z.enum(["setup", "reapply_stash"]).optional(),
      sdd_dir: z.string().optional(),
      target_branch: z.string().optional(),
      stash: z.enum(["yes", "no"]).optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ action, sdd_dir, target_branch, stash, workspace_root }) => {
    const data = branchSetup({
      action,
      sdd_dir,
      target_branch,
      stash,
      workspace_root,
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_sdd_context",
  {
    description:
      "Ensure docs/superpowers/sdd/<slug>/ exists; return progress ledger + Cursor TodoWrite todos[]. NEVER use .superpowers/sdd.",
    inputSchema: {
      slug: z.string().optional(),
      plan_path: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ slug, plan_path, workspace_root }) => {
    const data = sddContext({ slug, plan_path, workspace_root });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_sdd_task_brief",
  {
    description: "Write task-N-brief.md under docs/superpowers/sdd/<slug>/",
    inputSchema: {
      sdd_dir: z.string(),
      task_id: z.number(),
      section_text: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ sdd_dir, task_id, section_text, workspace_root }) => {
    const data = sddTaskBrief({
      sdd_dir,
      task_id,
      section_text,
      workspace_root,
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_sdd_review_package",
  {
    description: "Write review diff under SDD dir between base and head SHAs",
    inputSchema: {
      sdd_dir: z.string(),
      base_sha: z.string(),
      head_sha: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ sdd_dir, base_sha, head_sha, workspace_root }) => {
    const data = sddReviewPackage({
      sdd_dir,
      base_sha,
      head_sha,
      workspace_root,
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_sdd_append_progress",
  {
    description: "Append one validated line to docs/superpowers/sdd/<slug>/progress.md",
    inputSchema: {
      progress_path: z.string(),
      line: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ progress_path, line, workspace_root }) => {
    const data = sddAppendProgress({ progress_path, line, workspace_root });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_docs_branch",
  {
    description:
      "Resolve branch for spec/plan authors: keep current feature|bugfix or create from develop.",
    inputSchema: {
      plan_path: z.string().optional(),
      kind: z.enum(["feature", "bugfix"]).optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, kind, workspace_root }) => {
    const data = docsBranch({ plan_path, kind, workspace_root });
    if (data.error) return jsonResult(withWorkspace(workspace_root, { error: data.error }));
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_docs_validate",
  {
    description:
      "Hard-fail validate spec/plan headers, link, branch, and task order. Defaults to Cursor workspace; pass workspace_root when paths are relative to another repo.",
    inputSchema: {
      spec_path: z.string(),
      plan_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ spec_path, plan_path, workspace_root }) => {
    const data = docsValidate({ spec_path, plan_path, workspace_root });
    if (data.error) {
      return jsonResult(withWorkspace(workspace_root, { error: data.error, errors: data.errors ?? [] }));
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_plan_tasks",
  {
    description:
      "Parse plan ### Task N sections into structured tasks with section_text. Defaults to Cursor workspace; pass workspace_root when paths are relative to another repo.",
    inputSchema: {
      plan_path: z.string(),
      spec_path: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, spec_path, workspace_root }) => {
    const data = parsePlanTasks(plan_path, workspace_root);
    if (data.error) {
      return jsonResult(withWorkspace(workspace_root, { error: data.error }));
    }
    if (spec_path) {
      const branchData = resolveHandoffBranch(
        spec_path,
        plan_path,
        workspace_root,
      );
      if (branchData.error) {
        return jsonResult(
          withWorkspace(workspace_root, {
            ...data,
            branch_error: branchData.error,
          }),
        );
      }
      return jsonResult(
        withWorkspace(workspace_root, { ...data, branch: branchData.branch }),
      );
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_handoff_prompt",
  {
    description:
      "Build copy-paste handoff prompt for next session. Defaults to Cursor workspace; pass workspace_root when spec/plan paths are relative to another repo.",
    inputSchema: {
      message: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ message, workspace_root }) => {
    const root = workspace_root ?? process.cwd();
    const built = buildHandoffPrompt(root, message ?? "");
    if ("error" in built) {
      return jsonResult(withWorkspace(workspace_root, { error: built.error }));
    }
    const { prompt, spec: specPath, plan: planPath } = built;

    if (planPath) {
      const tasksData = parsePlanTasks(planPath, root);
      if (tasksData.error) {
        return jsonResult(
          withWorkspace(workspace_root, {
            prompt,
            error: tasksData.error,
          }),
        );
      }
      const payload: Record<string, unknown> = {
        prompt,
        tasks: tasksData.tasks,
        task_count: tasksData.task_count,
        workspace_root: root,
      };
      if (specPath) {
        const branchData = resolveHandoffBranch(
          specPath,
          planPath,
          root,
        );
        if (!branchData.error) {
          payload.branch = branchData.branch;
        }
      }
      const sdd = sddContext({ plan_path: planPath, workspace_root: root });
      if (!sdd.error) {
        payload.slug = sdd.slug;
        payload.sdd_dir = sdd.sdd_dir;
        payload.progress_path = sdd.progress_path;
        payload.completed_task_ids = sdd.completed_task_ids;
        payload.todos = sdd.todos;
        payload.todo_write_required = true;
      }
      return jsonResult(withWorkspace(workspace_root, payload));
    }

    return jsonResult(
      withWorkspace(workspace_root, {
        error: "Could not resolve spec and plan for handoff",
      }),
    );
  },
);

server.registerTool(
  "workflow_present_ascii",
  {
    description: "Render deterministic ASCII UI wireframe from JSON spec",
    inputSchema: {
      title: z.string().optional(),
      width: z.number().optional(),
      rows: z.array(z.record(z.any())),
    },
  },
  async (spec) => {
    const data = asciiWireframe(spec);
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data.data);
  },
);

server.registerTool(
  "workflow_present_flow",
  {
    description: "Render mermaid flowchart from JSON nodes/edges",
    inputSchema: {
      title: z.string().optional(),
      direction: z.enum(["TD", "LR", "BT", "RL"]).optional(),
      nodes: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          shape: z.string().optional(),
        }),
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().optional(),
        }),
      ),
    },
  },
  async (spec) => {
    const data = flowDiagram(spec);
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data.data);
  },
);

server.registerTool(
  "workflow_flow_status",
  {
    description: "Read the spec/plan approval flow state for a workflow",
    inputSchema: {
      plan_path: z.string().optional(),
      spec_path: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, spec_path, workspace_root }) => {
    const root = workspace_root ?? process.cwd();
    const slug = slugFromPath(plan_path ?? spec_path ?? "");
    if (!slug) return jsonResult({ error: "plan_path or spec_path required" });
    const state = readFlowState(root, slug);
    return jsonResult({
      slug,
      spec: state.spec,
      plan: state.plan,
      menu: state.menu,
      flow_path: `docs/superpowers/sdd/${slug}/flow.json`,
    });
  },
);

server.registerTool(
  "workflow_spec_approve",
  {
    description: "Advance spec status: first call self_reviewed, second call approved (after user approval)",
    inputSchema: {
      confirmed: z.boolean(),
      spec_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, spec_path, workspace_root }) => {
    const root = workspace_root ?? process.cwd();
    const slug = slugFromPath(spec_path);
    const result = transitionSpec(root, slug, spec_path, confirmed);
    if (result.ok === false) return jsonResult({ error: result.error });
    return jsonResult({ spec: spec_path, status: readFlowState(root, slug).spec.status });
  },
);

server.registerTool(
  "workflow_plan_approve",
  {
    description: "Advance plan status: first call self_reviewed, second call approved. Requires approved spec.",
    inputSchema: {
      confirmed: z.boolean(),
      plan_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, plan_path, workspace_root }) => {
    const root = workspace_root ?? process.cwd();
    const slug = slugFromPath(plan_path);
    const result = transitionPlan(root, slug, plan_path, confirmed);
    if (result.ok === false) return jsonResult({ error: result.error });
    return jsonResult({ plan: plan_path, status: readFlowState(root, slug).plan.status });
  },
);

server.registerTool(
  "workflow_plan_menu",
  {
    description: "Record the answered post-plan choice menu (called after native question)",
    inputSchema: {
      confirmed: z.boolean(),
      plan_path: z.string(),
      choice: z.enum(["subagent-driven", "inline", "handoff", "review-spec", "review-plan"]),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, plan_path, choice, workspace_root }) => {
    const root = workspace_root ?? process.cwd();
    const slug = slugFromPath(plan_path);
    const result = recordMenuChoice(root, slug, plan_path, choice, confirmed);
    if (result.ok === false) return jsonResult({ error: result.error });
    return jsonResult({ menu: { presented: true, chosen: choice } });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
