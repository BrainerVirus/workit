import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runScript } from "./lib/run-script.js";
import { parseSections, parseKeyValueLines } from "./lib/parse-sections.js";
import { parseVerifyOutput } from "./lib/verify-parse.js";
import { gitContext } from "./lib/git-context.js";
import { parsePlanTasks, resolveHandoffBranch } from "./lib/plan-tasks.js";
import { initStatus, initApply, toolkitStatus } from "./lib/init.js";
import { resolveBranch, branchSetup } from "./lib/branch-resolve.js";
import {
  sddContext,
  sddTaskBrief,
  sddReviewPackage,
  sddAppendProgress,
} from "./lib/sdd-context.js";
import {
  verifyYouTrackToken,
  context as youtrackContext,
  parseIssueRef as youtrackParseIssueRef,
  parseDuration as youtrackParseDuration,
  logTime as youtrackLogTime,
  buildDraft as youtrackBuildDraft,
  postUpdate as youtrackPostUpdate,
} from "./lib/youtrack.js";
import { asciiWireframe, flowDiagram } from "./lib/present.js";
import { withWorkspace } from "./lib/repo-tool.js";
import {
  changelogApply,
  changelogUnreleasedStats,
} from "./lib/changelog-apply.js";

const workspaceRootSchema = z
  .string()
  .optional()
  .describe(
    "Git repository root. Defaults to the Cursor workspace folder (${workspaceFolder}).",
  );

const server = new McpServer({
  name: "workflow-toolkit",
  version: "0.3.18",
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
    const args = message.trim() ? [message] : [];
    const { stdout, stderr, exitCode, cwd } = runScript(
      "collect-handoff-context.sh",
      args,
      workspace_root,
    );

    if (exitCode === 0) {
      const start = stdout.indexOf("PROMPT_START\n");
      const end = stdout.indexOf("\nPROMPT_END");
      if (start !== -1 && end !== -1) {
        const prompt = stdout.slice(start + "PROMPT_START\n".length, end);
        const planPath = extractPlanPath(prompt);
        const specPath = extractSpecPath(prompt);
        if (!planPath) {
          return jsonResult(
            withWorkspace(workspace_root, {
              prompt,
              workspace_root: cwd,
              error: "Could not extract plan path from prompt",
            }),
          );
        }
        const tasksData = parsePlanTasks(planPath, workspace_root);
        if (tasksData.error) {
          return jsonResult(
            withWorkspace(workspace_root, {
              prompt,
              workspace_root: cwd,
              error: tasksData.error,
            }),
          );
        }
        const payload = {
          prompt,
          tasks: tasksData.tasks,
          task_count: tasksData.task_count,
          workspace_root: cwd,
        };
        if (specPath) {
          const branchData = resolveHandoffBranch(
            specPath,
            planPath,
            workspace_root,
          );
          if (!branchData.error) {
            payload.branch = branchData.branch;
          }
        }
        const sdd = sddContext({ plan_path: planPath, workspace_root });
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
          error: "Prompt markers missing from script output",
          workspace_root: cwd,
          stdout,
        }),
      );
    }

    const errLines = (stderr + "\n" + stdout).split("\n");
    const error =
      errLines.find((l) => l.startsWith("ERROR:")) ?? "Handoff failed";
    const candidates = { specs: [], plans: [] };
    for (const line of errLines) {
      if (line.startsWith("SPEC: ")) candidates.specs.push(line.slice(6));
      if (line.startsWith("PLAN: ")) candidates.plans.push(line.slice(6));
    }
    return jsonResult(
      withWorkspace(workspace_root, {
        error,
        candidates:
          candidates.specs.length || candidates.plans.length
            ? candidates
            : undefined,
        stderr: stderr || undefined,
      }),
    );
  },
);

server.registerTool(
  "workflow_toolkit_init_status",
  {
    description:
      "Check workflow-toolkit setup (MCP deps, YouTrack config, token)",
    inputSchema: {},
  },
  async () => {
    const data = initStatus();
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

server.registerTool(
  "workflow_toolkit_status",
  {
    description:
      "Full health check: MCP deps, config files, YouTrack API verify. Use after editing token file.",
    inputSchema: {},
  },
  async () => {
    const data = toolkitStatus();
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

server.registerTool(
  "workflow_toolkit_init_apply",
  {
    description:
      "Apply init action. Requires confirmed: true. Token is NOT accepted here — user edits token file locally.",
    inputSchema: {
      action: z.enum([
        "npm_install",
        "youtrack_scaffold",
        "youtrack_json",
        "youtrack_token_placeholder",
        "vcs_scaffold",
      ]),
      confirmed: z.boolean(),
      base_url: z.string().optional(),
      default_mention: z.string().optional(),
      meeting_issue: z.string().optional(),
      vcs_provider: z.enum(["gitlab", "github"]).optional(),
      vcs_target_branch: z.string().optional(),
    },
  },
  async ({
    action,
    confirmed,
    base_url,
    default_mention,
    meeting_issue,
    vcs_provider,
    vcs_target_branch,
  }) => {
    const env = {};
    if (base_url) env.WORKFLOW_YT_BASE_URL = base_url;
    if (default_mention) env.WORKFLOW_YT_MENTION = default_mention;
    if (meeting_issue) env.WORKFLOW_YT_MEETING_ISSUE = meeting_issue;
    if (vcs_provider) env.WORKFLOW_VCS_PROVIDER = vcs_provider;
    if (vcs_target_branch) env.WORKFLOW_VCS_TARGET_BRANCH = vcs_target_branch;
    const data = initApply({ action, confirmed, env });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data.data);
  },
);

server.registerTool(
  "workflow_youtrack_verify_token",
  {
    description:
      "Read-only YouTrack token test (GET /api/users/me). No work items created.",
    inputSchema: {},
  },
  async () => {
    const result = verifyYouTrackToken();
    if (result.error) return jsonResult({ error: result.error });
    const data = result.data;
    if (!data.ok)
      return jsonResult({ error: data.error ?? "token invalid", ...data });
    return jsonResult(data);
  },
);

server.registerTool(
  "workflow_youtrack_parse_issue",
  {
    description:
      "Parse YouTrack issue URL or bare id (e.g. NSR-40) into issueId",
    inputSchema: {
      issue_ref: z
        .string()
        .describe("YouTrack URL or issue id, e.g. https://…/issue/NSR-40 or NSR-40"),
    },
  },
  async ({ issue_ref }) => {
    const data = youtrackParseIssueRef(issue_ref);
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

server.registerTool(
  "workflow_youtrack_context",
  {
    description:
      "YouTrack config, greeting, issue resolution (from issue_url/id or meetings)",
    inputSchema: {
      mode: z.enum(["meetings", "task"]).optional(),
      issue_id: z.string().optional(),
      issue_url: z.string().optional(),
      issue_ref: z.string().optional(),
      spec_path: z.string().optional(),
      plan_path: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({
    mode,
    issue_id,
    issue_url,
    issue_ref,
    spec_path,
    plan_path,
    workspace_root,
  }) => {
    const data = youtrackContext({
      mode,
      issue_id,
      issue_url,
      issue_ref,
      spec_path,
      plan_path,
      workspace_root,
    });
    if (data.error) {
      return jsonResult({
        error: data.error,
        ...(data.requiresIssueInput ? { requiresIssueInput: true } : {}),
      });
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_youtrack_parse_duration",
  {
    description: "Parse duration text (e.g. 1h 30m) to integer minutes",
    inputSchema: {
      text: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ text, workspace_root }) => {
    const data = youtrackParseDuration(text, workspace_root);
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_youtrack_log_time",
  {
    description: "POST YouTrack work item (time only, no comment)",
    inputSchema: {
      issueId: z.string(),
      minutes: z.number(),
      text: z.string().optional(),
      dateMs: z.number().optional().describe("Epoch ms for work item date; omit for today in config timezone"),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ issueId, minutes, text, dateMs, workspace_root }) => {
    const data = youtrackLogTime({
      issueId,
      minutes,
      text,
      dateMs,
      workspace_root,
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

server.registerTool(
  "workflow_youtrack_draft",
  {
    description: "Build ES-CL comment markdown without posting (envelope only by default)",
    inputSchema: {
      issueId: z.string(),
      userNotes: z.string(),
      greeting: z.string().optional(),
      projectName: z.string().optional(),
      includeProjectOpener: z.boolean().optional(),
      includeFacts: z.boolean().optional(),
      facts: z.record(z.any()).optional(),
    },
  },
  async (input) => jsonResult(youtrackBuildDraft(input)),
);

server.registerTool(
  "workflow_youtrack_post",
  {
    description: "Post YouTrack comment and optional time — requires confirmed: true",
    inputSchema: {
      confirmed: z.boolean(),
      issueId: z.string(),
      markdown: z.string(),
      minutes: z.number().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, issueId, markdown, minutes, workspace_root }) => {
    const data = youtrackPostUpdate({
      confirmed,
      issueId,
      markdown,
      minutes,
      workspace_root,
    });
    if (data.error && !data.partial) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
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

const transport = new StdioServerTransport();
await server.connect(transport);
