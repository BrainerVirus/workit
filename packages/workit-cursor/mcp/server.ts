import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createLogger, redact, redactSecrets } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: Cursor events mirror to stderr. MCP stdout stays protocol-only.
export const logger = createLogger({
  stderr: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

const readServerVersion = (): string => {
  try {
    // Runtime read, not hardcoded: semantic-release bumps versions only in CI
    // (no commit-back), so any literal here would drift from the published tag.
    // package.json ships in the tarball regardless of the files whitelist.
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ??
      "0.0.0"
    );
  } catch (err) {
    logger.warn(EVENT.provenance, errorDetail(err));
    return "unknown";
  }
};

const VERSION = readServerVersion();
setDiagnosticLogger(logger);
logger.info(EVENT.initialization, { host: "cursor-mcp", server: "workit", version: VERSION });

// Uncaught process failures are bounded sanitized events on stderr; stdout stays
// protocol-only. The MCP process owns itself, so an uncaught exception is logged
// and the process exits with a nonzero status (DG-04).
process.on("unhandledRejection", (reason) =>
  logger.error(EVENT.uncaughtFailure, { phase: "unhandledRejection", ...errorDetail(reason) }),
);
process.on("uncaughtException", (err) => {
  logger.error(EVENT.uncaughtFailure, { phase: "uncaughtException", ...errorDetail(err) });
  process.exit(1);
});
import {
  parseSections,
  parseKeyValueLines,
} from "@brainervirus/workit-core/src/core/parse-sections";
import { parseVerifyOutput } from "@brainervirus/workit-core/src/core/verify-parse";
import {
  changelogContext,
  docsRefreshContext,
  prReadyContext,
  releaseNotesContext,
} from "@brainervirus/workit-core/src/core/repo-context";
import { runVerifyProject } from "@brainervirus/workit-core/src/core/verify-project";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";
import { prCreate } from "@brainervirus/workit-core/src/core/pr-create";
import { gitContext } from "@brainervirus/workit-core/src/core/git";
import {
  parsePlanTasks,
  resolveHandoffBranch,
} from "@brainervirus/workit-core/src/core/plan-tasks";
import { buildHandoffPrompt } from "@brainervirus/workit-core/src/core/handoff-tools";
import {
  assertSddControlGates,
  markHandoffDestination,
  mintDelegateToken,
  prepareFlowState,
  readEffectiveFlowState,
  readFlowState,
  recordMenuChoice,
  revokeDelegateToken,
  slugFromPath,
  slugFromSddPath,
  transitionExecution,
  transitionPlan,
  transitionSpec,
  type NativeChoiceEvidence,
} from "@brainervirus/workit-core/src/core/flow-state";
import {
  cursorCoordinatorContext,
  cursorMutationContext,
  cursorQuestionEvidence,
} from "./flow-evidence";

// The policy-only constant is valid by construction; the adapter never takes
// caller input, so a failing shape here is a programming error, not forgery.
const cursorConfirmation = (): NativeChoiceEvidence => {
  const result = cursorQuestionEvidence();
  if (!result.ok) throw new Error(result.error);
  return result.evidence;
};

/**
 * Token-gated mutation identity (cursor-subagent-inline CA-03/CA-04): an
 * optional `delegation_token` tool argument is validated through the adapter
 * before any context exists. A valid token yields the delegated context; an
 * invalid one fails closed with the structured code and never downgrades to
 * the coordinator session. The raw token is used only here and is never
 * logged or persisted.
 */
import {
  resolveCanonicalLayout,
  prepareDocsLayout,
} from "@brainervirus/workit-core/src/core/docs-layout";
import {
  detectLegacyDocs,
  migrateLegacyDocs,
  migrationQuestion,
} from "@brainervirus/workit-core/src/core/docs-migration";
import { linkDocsRepo, listSpecs, promoteSpec } from "@brainervirus/workit-core/src/core/docs-repo";
import {
  configDir,
  mergeConfigValues,
  readConfig,
  writeConfig,
} from "@brainervirus/workit-core/src/core/config";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore";
import { ensureHygieneFiles } from "@brainervirus/workit-core/src/core/hygiene";
import { listTemplates, writeTemplate } from "@brainervirus/workit-core/src/core/templates";
import { listRules, writeRule } from "@brainervirus/workit-core/src/core/rules";
import { initStatus, initApply, toolkitStatus } from "@brainervirus/workit-core/src/core/init";
import { resolveBranch, branchSetup } from "@brainervirus/workit-core/src/core/branch";
import { docsValidate } from "@brainervirus/workit-core/src/core/docs-validate";
import { docsBranch } from "@brainervirus/workit-core/src/core/branch";
import {
  sddAppendAdvisory,
  sddAppendProgress,
  sddContext,
  sddReviewPackage,
  sddTaskBrief,
} from "@brainervirus/workit-core/src/core/sdd";
import {
  verifyYouTrackToken,
  context as youtrackContext,
  parseIssueRef as youtrackParseIssueRef,
  parseDuration as youtrackParseDuration,
  logTime as youtrackLogTime,
  buildDraft as youtrackBuildDraft,
  postUpdate as youtrackPostUpdate,
} from "@brainervirus/workit-core/src/core/youtrack";
import { asciiWireframe, flowDiagram } from "@brainervirus/workit-core/src/core/present";
import { withWorkspace } from "@brainervirus/workit-core/src/core/repo-tool";
import {
  changelogApply,
  changelogUnreleasedStats,
} from "@brainervirus/workit-core/src/core/changelog";

const workspaceRootSchema = z
  .string()
  .optional()
  .default(() => process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd())
  .describe(
    "Git repository root. Defaults to the launcher workspace (WORKFLOW_WORKSPACE_ROOT), then the Cursor workspace folder (${workspaceFolder}), then the process cwd.",
  );

// Token-gated mutation schema fragment (cursor-subagent-inline CA-03): every
// mutation wrapper in the core mutation allowlist accepts the task-scoped
// delegation token. No caller-supplied role/taskIdentity field exists — the
// delegated identity is derived only from token validation (fail closed).
const delegationTokenSchema = z
  .string()
  .optional()
  .describe("Task-scoped delegation token from workit_delegate for delegated workers.");

const server = new McpServer({
  name: "workit",
  version: VERSION,
});

function jsonResult(data: Record<string, unknown>): CallToolResult {
  // Domain failures keep their structured detail but are never successful-looking
  // (DG-06): any payload carrying an `error` field is marked isError: true. The
  // error string is redacted like the throw-path wrapper (DG-05, DG-10), so a
  // secret in a domain error never reaches the MCP client raw. Pattern-only
  // (no truncation): the recovery/actionable text must stay intact for the model.
  const isError = Boolean(data.error);
  if (isError && typeof data.error === "string") {
    data.error = redactSecrets(data.error);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

// A throwing handler is caught here: the host stays usable, the failure is a
// bounded sanitized stderr event, and the client receives structured content
// with isError: true instead of a crash or a protocol error (DG-06, DG-10).
const registerTool = (
  name: string,
  config: Record<string, unknown>,
  cb: (args: any) => unknown,
): void => {
  server.registerTool(name, config as never, async (args) => {
    try {
      return (await cb(args as never)) as CallToolResult;
    } catch (err) {
      logger.error(EVENT.toolsFailed, { tool: name, ...errorDetail(err) });
      const safe = redact(err instanceof Error ? err.message : String(err)) as string;
      return {
        content: [{ type: "text", text: JSON.stringify({ error: safe }, null, 2) }],
        structuredContent: { error: safe, tool: name },
        isError: true,
      };
    }
  });
};

registerTool(
  "workit_verify",
  {
    description:
      "Run project validation scripts (verify-project.sh). Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      dry_run: z.boolean().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ dry_run, workspace_root }) => {
    const { stdout, stderr, exitCode, cwd } = runVerifyProject(workspace_root, Boolean(dry_run));
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

registerTool(
  "workit_doctor",
  {
    description:
      "Run the offline workit doctor and report installation health. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ workspace_root }) => {
    const report = runDoctor({ host: "cursor", cwd: workspace_root });
    return jsonResult(report);
  },
);

registerTool(
  "workit_pr_context",
  {
    description:
      "Gather PR-ready repository context. On feature/* or bugfix/*, fetches and fast-forwards develop + current branch before diffing against develop.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const { stdout, stderr, exitCode, cwd } = prReadyContext(workspace_root, range);
    if (exitCode !== 0) {
      const errLines = (stderr + "\n" + stdout).split("\n");
      const error =
        errLines.find((l) => l.startsWith("ERROR:")) ?? stderr.trim() ?? "pr-ready-context failed";
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

registerTool(
  "workit_pr_create",
  {
    description:
      "Create GitLab MR or GitHub PR via glab/gh using vcs.json — requires confirmed: true",
    inputSchema: {
      confirmed: z.boolean(),
      title: z.string(),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      target_branch: z.string().optional(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, title, body, draft, target_branch, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    if (!confirmed) return jsonResult({ error: "confirmed: true required" });
    const data = prCreate(
      {
        WF_PR_TITLE: title,
        WF_PR_BODY: body ?? "",
        WF_PR_CONFIRMED: "true",
        WF_PR_DRAFT: draft ? "true" : "false",
        WF_PR_TARGET: target_branch ?? "",
      },
      workspace_root,
    );
    if (data.error || data.ok === false) {
      return jsonResult(
        withWorkspace(workspace_root, {
          error: data.error ?? "pr-create failed",
          ...data,
        }),
      );
    }
    return jsonResult(withWorkspace(workspace_root, { ...data }));
  },
);

registerTool(
  "workit_changelog_context",
  {
    description:
      "Gather changelog update context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const { stdout, stderr, exitCode, cwd } = changelogContext(workspace_root, range);
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
          "ALWAYS merge via workit_changelog_apply — never hand-edit ### Added/Changed/… under [Unreleased].",
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

registerTool(
  "workit_changelog_apply",
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
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ entries, normalize_only, path: changelogPath, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
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

registerTool(
  "workit_release_notes_context",
  {
    description:
      "Gather release notes context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range_or_tag: z.string().min(1),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range_or_tag, workspace_root }) => {
    const { stdout, stderr, exitCode, cwd } = releaseNotesContext(workspace_root, range_or_tag);
    const sections = parseSections(stdout);
    const repo = parseKeyValueLines(sections.Repository ?? "", ["requested", "range"]);
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

registerTool(
  "workit_docs_context",
  {
    description:
      "Gather docs refresh context. Defaults to Cursor workspace; pass workspace_root when the target repo differs.",
    inputSchema: {
      range: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ range, workspace_root }) => {
    const { stdout, stderr, exitCode, cwd } = docsRefreshContext(workspace_root, range);
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

registerTool(
  "workit_git_context",
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

registerTool(
  "workit_resolve_branch",
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
    if ("error" in data) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_branch_setup",
  {
    description:
      "In-place checkout of feature/* or bugfix/* branch. Stash required when dirty. NEVER uses worktrees.",
    inputSchema: {
      action: z.enum(["setup", "reapply_stash"]).optional(),
      sdd_dir: z.string().optional(),
      target_branch: z.string().optional(),
      stash: z.enum(["yes", "no"]).optional(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ action, sdd_dir, target_branch, stash, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    // Parity: the MCP process owns a real sanitized logger, so the flow-guard
    // journal mirrors to the same stderr event stream as every other tool.
    const data = branchSetup({
      action,
      sdd_dir,
      target_branch,
      stash,
      workspace_root,
      log: (message) => logger.info(message),
    });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_sdd_context",
  {
    description:
      "Resolve canonical docs/<slug>/sdd/ paths; creates nothing (progress.md appears only on the first confirmed append). NEVER use .superpowers/sdd.",
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

registerTool(
  "workit_sdd_task_brief",
  {
    description: "Write task-N-brief.md under docs/<slug>/sdd/",
    inputSchema: {
      sdd_dir: z.string(),
      task_id: z.number(),
      section_text: z.string(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ sdd_dir, task_id, section_text, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const slug = slugFromSddPath(sdd_dir);
    if (!slug) return jsonResult({ error: "could not derive slug — expected docs/<slug>/sdd/..." });
    // Slug binding (cursor-subagent-inline): a delegated identity is bound to
    // the flow the token was minted for; a caller-derived slug pointing at a
    // different flow fails closed instead of writing another flow's ledger.
    if (identity.slug !== undefined && identity.slug !== slug) {
      return jsonResult({
        error: `delegation token is bound to flow ${JSON.stringify(identity.slug)}, not ${JSON.stringify(slug)}`,
        code: "slug_mismatch",
      });
    }
    const gate = assertSddControlGates(
      workspace_root,
      slug,
      { requireMenu: true, requireDocs: true },
      identity.context,
    );
    if (!gate.ok) return jsonResult({ error: gate.error, code: gate.code });
    const data = sddTaskBrief({
      sdd_dir,
      task_id,
      section_text,
      workspace_root,
    });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_sdd_review_package",
  {
    description: "Write review diff under SDD dir between base and head SHAs",
    inputSchema: {
      sdd_dir: z.string(),
      base_sha: z.string(),
      head_sha: z.string(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ sdd_dir, base_sha, head_sha, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const slug = slugFromSddPath(sdd_dir);
    if (!slug) return jsonResult({ error: "could not derive slug — expected docs/<slug>/sdd/..." });
    // Slug binding: same fail-closed contract as workit_sdd_task_brief.
    if (identity.slug !== undefined && identity.slug !== slug) {
      return jsonResult({
        error: `delegation token is bound to flow ${JSON.stringify(identity.slug)}, not ${JSON.stringify(slug)}`,
        code: "slug_mismatch",
      });
    }
    const gate = assertSddControlGates(
      workspace_root,
      slug,
      { requireMenu: true, requireDocs: true },
      identity.context,
    );
    if (!gate.ok) return jsonResult({ error: gate.error, code: gate.code });
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

registerTool(
  "workit_sdd_append_progress",
  {
    description: "Append one validated line to docs/<slug>/sdd/progress.md",
    inputSchema: {
      progress_path: z.string(),
      line: z.string(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ progress_path, line, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const slug = slugFromSddPath(progress_path);
    if (!slug) return jsonResult({ error: "could not derive slug — expected docs/<slug>/sdd/..." });
    // Slug binding: same fail-closed contract as workit_sdd_task_brief — a
    // worker can never write (and thus never revoke) another flow's ledger.
    if (identity.slug !== undefined && identity.slug !== slug) {
      return jsonResult({
        error: `delegation token is bound to flow ${JSON.stringify(identity.slug)}, not ${JSON.stringify(slug)}`,
        code: "slug_mismatch",
      });
    }
    const gate = assertSddControlGates(
      workspace_root,
      slug,
      { requireMenu: true, requireDocs: true },
      identity.context,
    );
    if (!gate.ok) return jsonResult({ error: gate.error, code: gate.code });
    const data = sddAppendProgress({ progress_path, line, workspace_root });
    if (data.error) return jsonResult({ error: data.error });
    // Revocation-at-progress (cursor-subagent-inline CA-03, D-02): when a
    // delegated worker records its task's progress line, the task's active
    // token is revoked. The delegated context carries the task identity, so
    // only the worker's own task token is revoked; the revoke is best-effort
    // AFTER the progress line landed (a coordinator append has no token to
    // revoke and simply records the no-active-token structured failure).
    // ponytail: the token can be revoked between this validation and the
    // locked write — the TOCTOU consequence is bounded to one extra mutation
    // by the already-validated token.
    if (identity.context.role === "delegated" && identity.context.taskIdentity) {
      revokeDelegateToken(workspace_root, slug, Number(identity.context.taskIdentity));
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_sdd_append_advisory",
  {
    description:
      "Append a validated advisory line to docs/<slug>/sdd/advisories.md (coordinator-owned)",
    inputSchema: {
      advisories_path: z.string(),
      task_id: z.number(),
      text: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ advisories_path, task_id, text, workspace_root }) => {
    const slug = slugFromSddPath(advisories_path);
    if (!slug) return jsonResult({ error: "could not derive slug — expected docs/<slug>/sdd/..." });
    const gate = assertSddControlGates(
      workspace_root,
      slug,
      { requireMenu: true, requireDocs: true },
      cursorCoordinatorContext(workspace_root),
    );
    if (!gate.ok) return jsonResult({ error: gate.error, code: gate.code });
    const data = sddAppendAdvisory({ advisories_path, task_id, text, workspace_root });
    if ("error" in data) return jsonResult({ error: data.error, code: data.code });
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_docs_branch",
  {
    description:
      "Resolve branch for spec/plan authors: keep current feature|bugfix or create from the configured base.",
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

registerTool(
  "workit_docs_layout",
  {
    description:
      "Canonical docs layout: prepare creates missing docs/ and docs/<slug>/; migrate detects legacy docs/superpowers/ and copies safe pairs after a native Migrate safely / Not now question",
    inputSchema: {
      action: z.enum(["prepare", "migrate"]).default("prepare"),
      slug: z.string().optional(),
      spec_path: z.string().optional(),
      plan_path: z.string().optional(),
      confirmed: z.boolean().optional(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ action, slug, spec_path, plan_path, confirmed, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    if (action === "migrate") {
      const detect = detectLegacyDocs(workspace_root);
      if (confirmed === undefined) {
        return jsonResult(
          withWorkspace(workspace_root, {
            action: "migrate",
            stage: detect.entries.length === 0 ? "nothing_to_migrate" : "awaiting_confirmation",
            question: migrationQuestion(detect),
            detect,
          }),
        );
      }
      const result = migrateLegacyDocs({ workspace_root, slug, confirmed });
      if (result.ok) {
        return jsonResult(
          withWorkspace(workspace_root, { action: "migrate", stage: "migrated", ...result.data }),
        );
      }
      if (result.declined) {
        return jsonResult(
          withWorkspace(workspace_root, {
            action: "migrate",
            stage: "declined",
            active_workflow: result.active_workflow,
            detect,
          }),
        );
      }
      return jsonResult(
        withWorkspace(workspace_root, {
          error: result.error,
          collisions: result.collisions ?? [],
          detect,
        }),
      );
    }
    const result = prepareDocsLayout({ workspace_root, slug, spec_path, plan_path });
    if (!result.ok) return jsonResult(withWorkspace(workspace_root, { error: result.error }));
    return jsonResult(withWorkspace(workspace_root, result));
  },
);

registerTool(
  "workit_docs_validate",
  {
    description:
      "Hard-fail validate spec/plan headers, link, branch, task order; returns quality findings (hard/warning). Defaults to Cursor workspace; pass workspace_root when paths are relative to another repo.",
    inputSchema: {
      spec_path: z.string(),
      plan_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ spec_path, plan_path, workspace_root }) => {
    const data = docsValidate({ spec_path, plan_path, workspace_root });
    if (data.ok === false) {
      return jsonResult(
        withWorkspace(workspace_root, { error: data.error, errors: data.errors ?? [] }),
      );
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_plan_tasks",
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
    if ("error" in data) {
      return jsonResult(withWorkspace(workspace_root, { error: data.error }));
    }
    if (spec_path) {
      const branchData = resolveHandoffBranch(spec_path, plan_path, workspace_root);
      if ("error" in branchData) {
        return jsonResult(
          withWorkspace(workspace_root, {
            ...data,
            branch_error: branchData.error,
          }),
        );
      }
      return jsonResult(withWorkspace(workspace_root, { ...data, branch: branchData.branch }));
    }
    return jsonResult(withWorkspace(workspace_root, data));
  },
);

registerTool(
  "workit_handoff_prompt",
  {
    description:
      "Build copy-paste handoff prompt for next session. Defaults to Cursor workspace; pass workspace_root when spec/plan paths are relative to another repo.",
    inputSchema: {
      message: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ message, workspace_root }) => {
    const root = workspace_root;
    const built = buildHandoffPrompt(root, message ?? "");
    if ("error" in built) {
      // CA-07: generation (including docs validation) failed — return WITHOUT
      // marking the flow as a destination; one retry can rebuild and mark.
      return jsonResult(withWorkspace(workspace_root, { error: built.error }));
    }
    const { prompt, spec: specPath, plan: planPath } = built;

    if (!planPath) {
      return jsonResult(
        withWorkspace(workspace_root, {
          error: "Could not resolve spec and plan for handoff",
        }),
      );
    }

    // Parse tasks BEFORE any mutation (CA-07/CA-09): a parse failure returns
    // without marking the flow as a destination, so "generation failure ⇒ no
    // mutation" holds for every stage after build. parsePlanTasks only needs
    // the plan path, which is already resolved.
    const tasksData = parsePlanTasks(planPath, root);
    if ("error" in tasksData) {
      return jsonResult(
        withWorkspace(workspace_root, {
          prompt,
          error: tasksData.error,
        }),
      );
    }

    // Build-then-mark (CA-07/CA-09): mark the destination ONLY after the
    // complete core prompt built and tasks parsed successfully. A marked
    // destination rejects a second handoff (recursive_handoff) and has its
    // menu reset.
    const slug = slugFromPath(planPath);
    const marked = markHandoffDestination(root, slug, planPath);
    if (marked.ok === false) {
      return jsonResult(
        withWorkspace(workspace_root, {
          error: marked.error,
          code: marked.code,
          ...(marked.details ? { details: marked.details } : {}),
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
      const branchData = resolveHandoffBranch(specPath, planPath, root);
      if (!("error" in branchData)) {
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
    // Effective destination state (CA-07): handoff_destination true plus the
    // reset menu — the source post-plan menu evidence is consumed by the mark.
    const effective = readEffectiveFlowState(root, slug);
    if (effective.ok) {
      payload.handoff_destination = effective.state.handoff_destination;
      payload.menu = effective.state.menu;
    }
    return jsonResult(withWorkspace(workspace_root, payload));
  },
);

registerTool(
  "workit_init_status",
  {
    description: "Check workit setup (MCP deps, YouTrack config, token)",
    inputSchema: {},
  },
  async () => {
    const data = initStatus();
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

registerTool(
  "workit_status",
  {
    description:
      "Full health check: MCP deps, config files, YouTrack API verify. Use after editing token file.",
    inputSchema: {},
  },
  async () => {
    const data = await toolkitStatus();
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

registerTool(
  "workit_init_apply",
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
        "config",
        "gitignore",
        "hygiene",
        "branch_policy",
      ]),
      confirmed: z.boolean(),
      base_url: z.string().optional(),
      default_mention: z.string().optional(),
      meeting_issue: z.string().optional(),
      vcs_provider: z.enum(["gitlab", "github"]).optional(),
      vcs_target_branch: z.string().optional(),
      name: z.string().optional(),
      develop_branch: z.string().optional(),
      integration: z.enum(["pr", "merge"]).optional(),
      locale: z.string().optional(),
      locale_options: z.array(z.string()).optional(),
      timezone: z.string().optional(),
      branch_policy_preset: z.enum(["gitflow", "github-flow", "trunk-based", "custom"]).optional(),
      branch_policy_allowed: z.array(z.string()).optional(),
      branch_policy_protected: z.array(z.string()).optional(),
      include_open_source: z.boolean().optional(),
      workspace_root: workspaceRootSchema,
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
    name,
    develop_branch,
    integration,
    locale,
    locale_options,
    timezone,
    branch_policy_preset,
    branch_policy_allowed,
    branch_policy_protected,
    include_open_source,
    workspace_root,
  }) => {
    if (action === "hygiene") {
      const result = ensureHygieneFiles(workspace_root, {
        confirmed,
        includeOpenSource: include_open_source,
      });
      if (!result.ok) return jsonResult({ error: result.error });
      return jsonResult(result);
    }
    if (action === "gitignore") {
      const result = ensureProjectGitignore(workspace_root, confirmed);
      if (!result.ok) return jsonResult({ error: result.error });
      return jsonResult(result);
    }
    if (action === "config") {
      // Mirrors core config.ts LOCALE_RE (keep in sync): 3-digit UN M.49
      // region subtags like es-419 validate alongside 2-letter regions.
      if (locale !== undefined && !/^[a-z]{2,3}(-(?:[A-Z]{2}|[0-9]{3}))?$/.test(locale)) {
        return jsonResult({
          error: `invalid locale: ${JSON.stringify(locale)} — expected BCP-47 like en or es-CL`,
        });
      }
      const current = readConfig();
      const next = mergeConfigValues(
        {
          locale,
          localeOptions: locale_options,
          timezone,
          preset: branch_policy_preset as any,
          allowed: branch_policy_allowed,
          protectedNames: branch_policy_protected,
        },
        current,
      );
      writeConfig(next);
      return jsonResult({ action: "config", path: `${configDir()}/config.json`, ...next });
    }
    const env: Record<string, string> = {};
    if (base_url) env.WORKFLOW_YT_BASE_URL = base_url;
    if (default_mention) env.WORKFLOW_YT_MENTION = default_mention;
    if (meeting_issue) env.WORKFLOW_YT_MEETING_ISSUE = meeting_issue;
    if (vcs_provider) env.WORKFLOW_VCS_PROVIDER = vcs_provider;
    if (vcs_target_branch) env.WORKFLOW_VCS_TARGET_BRANCH = vcs_target_branch;
    env.WORKFLOW_WORKSPACE_ROOT = workspace_root;
    if (name) env.WORKFLOW_BP_NAME = name;
    if (develop_branch) env.WORKFLOW_BP_DEVELOP = develop_branch;
    if (integration) env.WORKFLOW_BP_INTEGRATION = integration;
    const data = initApply({ action, confirmed, env });
    if (data.error) return jsonResult({ error: data.error });
    return jsonResult(data.data);
  },
);

registerTool(
  "workit_youtrack_verify_token",
  {
    description: "Read-only YouTrack token test (GET /api/users/me). No work items created.",
    inputSchema: {},
  },
  async () => {
    const result = verifyYouTrackToken();
    if (result.error) return jsonResult({ error: result.error });
    const data = result.data;
    if (!data.ok) return jsonResult({ error: data.error ?? "token invalid", ...data });
    return jsonResult(data);
  },
);

registerTool(
  "workit_youtrack_parse_issue",
  {
    description: "Parse YouTrack issue URL or bare id (e.g. NSR-40) into issueId",
    inputSchema: {
      issue_ref: z
        .string()
        .describe("YouTrack URL or issue id, e.g. https://…/issue/NSR-40 or NSR-40"),
    },
  },
  async ({ issue_ref }) => {
    const data = youtrackParseIssueRef(issue_ref);
    if ("error" in data) return jsonResult({ error: data.error });
    return jsonResult(data);
  },
);

registerTool(
  "workit_youtrack_context",
  {
    description: "YouTrack config, greeting, issue resolution (from issue_url/id or meetings)",
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
  async ({ mode, issue_id, issue_url, issue_ref, spec_path, plan_path, workspace_root }) => {
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

registerTool(
  "workit_youtrack_parse_duration",
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

registerTool(
  "workit_youtrack_log_time",
  {
    description: "POST YouTrack work item (time only, no comment)",
    inputSchema: {
      issueId: z.string(),
      minutes: z.number(),
      text: z.string().optional(),
      dateMs: z
        .number()
        .optional()
        .describe("Epoch ms for work item date; omit for today in config timezone"),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ issueId, minutes, text, dateMs, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const data = await youtrackLogTime({
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

registerTool(
  "workit_youtrack_draft",
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

registerTool(
  "workit_youtrack_post",
  {
    description: "Post YouTrack comment and optional time — requires confirmed: true",
    inputSchema: {
      confirmed: z.boolean(),
      issueId: z.string(),
      markdown: z.string(),
      minutes: z.number().optional(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ confirmed, issueId, markdown, minutes, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const data = await youtrackPostUpdate({
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

registerTool(
  "workit_present_ascii",
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

registerTool(
  "workit_present_flow",
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

registerTool(
  "workit_flow_status",
  {
    description:
      "Read the spec/plan approval flow state for a workflow; on first read it records flow activation and canonical document paths (FG-01)",
    inputSchema: {
      plan_path: z.string().optional(),
      spec_path: z.string().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, spec_path, workspace_root }) => {
    const resolved = resolveCanonicalLayout({
      workspace_root,
      spec_path,
      plan_path,
    });
    if (!resolved.ok) return jsonResult(withWorkspace(workspace_root, { error: resolved.error }));
    const { workspace, slug } = resolved.layout;
    // Effective read (CA-02/CA-04): digest reconciliation and legacy
    // compatibility run under the per-flow lock before status trusts persisted
    // approvals; drift is reported structurally alongside the execution state.
    let effective = readEffectiveFlowState(workspace, slug);
    if (!effective.ok && effective.code === "flow_not_activated") {
      const prepared = prepareFlowState(
        workspace,
        slug,
        { spec_path, plan_path },
        cursorCoordinatorContext(workspace),
      );
      if (!prepared.ok) return jsonResult({ error: prepared.error, code: prepared.code });
      effective = readEffectiveFlowState(workspace, slug);
    }
    if (!effective.ok) return jsonResult({ error: effective.error, code: effective.code });
    const { state, drift } = effective;
    return jsonResult({
      slug,
      spec: state.spec,
      plan: state.plan,
      menu: state.menu,
      execution: state.execution,
      drift,
      flow_path: `docs/${slug}/sdd/flow.json`,
    });
  },
);

registerTool(
  "workit_spec_approve",
  {
    description:
      "Advance spec status with the Cursor policy-only confirmation: draft -> approved in a single call. The self-review validation runs automatically inside the transition; only the final approval asks for your confirmation. Cursor records attested: false (the MCP cannot observe AskQuestion results); there is no evidence argument (CA-42).",
    inputSchema: {
      spec_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ spec_path, workspace_root }) => {
    const resolved = resolveCanonicalLayout({ workspace_root, spec_path });
    if (!resolved.ok) return jsonResult(withWorkspace(workspace_root, { error: resolved.error }));
    const { workspace, slug } = resolved.layout;
    const result = transitionSpec(
      workspace,
      slug,
      spec_path,
      cursorConfirmation(),
      cursorCoordinatorContext(workspace),
    );
    if (result.ok === false) return jsonResult({ error: result.error, code: result.code });
    return jsonResult({ spec: spec_path, status: readFlowState(workspace, slug).spec.status });
  },
);

registerTool(
  "workit_plan_approve",
  {
    description:
      "Advance plan status with the Cursor policy-only confirmation: draft -> approved in a single call. The self-review validation runs automatically inside the transition; only the final approval asks for your confirmation. Requires approved spec. Cursor records attested: false; there is no evidence argument (CA-42).",
    inputSchema: {
      plan_path: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, workspace_root }) => {
    const resolved = resolveCanonicalLayout({ workspace_root, plan_path });
    if (!resolved.ok) return jsonResult(withWorkspace(workspace_root, { error: resolved.error }));
    const { workspace, slug } = resolved.layout;
    const result = transitionPlan(
      workspace,
      slug,
      plan_path,
      cursorConfirmation(),
      cursorCoordinatorContext(workspace),
    );
    if (result.ok === false) return jsonResult({ error: result.error, code: result.code });
    return jsonResult({ plan: plan_path, status: readFlowState(workspace, slug).plan.status });
  },
);

registerTool(
  "workit_plan_menu",
  {
    description:
      "Record the answered post-plan choice menu with the Cursor policy-only confirmation. An accepted Cursor subagent-driven choice activates execution and returns a coordinator_lease (mint delegation tokens with it); there is no evidence argument.",
    inputSchema: {
      plan_path: z.string(),
      choice: z.enum(["subagent-driven", "inline", "handoff", "review-spec", "review-plan"]),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ plan_path, choice, workspace_root }) => {
    const resolved = resolveCanonicalLayout({ workspace_root, plan_path });
    if (!resolved.ok) return jsonResult(withWorkspace(workspace_root, { error: resolved.error }));
    const { workspace, slug } = resolved.layout;
    const result = recordMenuChoice(
      workspace,
      slug,
      plan_path,
      choice,
      cursorConfirmation(),
      cursorCoordinatorContext(workspace),
    );
    if (result.ok === false) return jsonResult({ error: result.error, code: result.code });
    return jsonResult({
      menu: { presented: true, chosen: choice },
      // The raw coordinator lease is returned exactly once (Task 1 contract)
      // and must never be logged — it crosses this boundary once only.
      ...(result.coordinator_lease !== undefined
        ? { coordinator_lease: result.coordinator_lease }
        : {}),
    });
  },
);

// Delegation minting (cursor-subagent-inline CA-02): the coordinator lease
// authorizes exactly this operation — minting a task-scoped delegation token.
// The tool modifies no product state; only the token hash persists (core
// mintDelegateToken). The raw token is returned once to the coordinator, which
// passes it to the Cursor-native subagent prompt; it is never logged here.
registerTool(
  "workit_delegate",
  {
    description:
      "Mint a task-scoped delegation token for a Cursor-native subagent. Requires the coordinator_lease returned once by workit_plan_menu with choice subagent-driven. Pass the returned delegation_token to the subagent; mutation tools accept it as delegation_token.",
    inputSchema: {
      slug: z.string(),
      plan_path: z.string(),
      task_id: z.number(),
      coordinator_lease: z.string(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ slug, plan_path, task_id, coordinator_lease, workspace_root }) => {
    const minted = mintDelegateToken(workspace_root, slug, plan_path, task_id, coordinator_lease);
    if (!minted.ok) return jsonResult({ error: minted.error, code: minted.code });
    return jsonResult({ delegation_token: minted.token, slug, task_id });
  },
);

// Execution lifecycle tools (CA-11, CA-14, CA-23): each transitions the plan's
// execution between pending/active/paused/completed through core
// `transitionExecution` with the Cursor policy-only confirmation and the
// deterministic cursor MutationContext (CA-42, CA-20/21). Thin mappings only:
// no ledger parsing, no verification, no transition rules are reproduced here.
// Results report the post-transition effective execution state and any approval
// drift; failures surface structured `details` (e.g. incomplete ledger or
// verification failure facts). Every call resolves against the explicit
// `workspace_root`; there is no evidence/role argument.
const lifecycleTool = (action: "pause" | "resume" | "complete", description: string) => {
  registerTool(
    `workit_plan_${action}`,
    {
      description,
      inputSchema: {
        plan_path: z.string(),
        workspace_root: workspaceRootSchema,
      },
    },
    async ({ plan_path, workspace_root }) => {
      const resolved = resolveCanonicalLayout({ workspace_root, plan_path });
      if (!resolved.ok) {
        return jsonResult(withWorkspace(workspace_root, { error: resolved.error }));
      }
      const { workspace, slug } = resolved.layout;
      const result = transitionExecution(
        workspace,
        slug,
        plan_path,
        action,
        cursorConfirmation(),
        cursorCoordinatorContext(workspace),
      );
      if (result.ok === false) {
        return jsonResult(
          withWorkspace(workspace_root, {
            error: result.error,
            code: result.code,
            ...(result.details ? { details: result.details } : {}),
          }),
        );
      }
      const effective = readEffectiveFlowState(workspace, slug);
      if (!effective.ok) {
        return jsonResult(
          withWorkspace(workspace_root, { error: effective.error, code: effective.code }),
        );
      }
      return jsonResult(
        withWorkspace(workspace_root, {
          plan: plan_path,
          execution: effective.state.execution,
          drift: effective.drift,
        }),
      );
    },
  );
};

lifecycleTool(
  "pause",
  "Pause a running plan with the Cursor policy-only confirmation: active -> paused. The MCP cannot observe AskQuestion results, so it records attested: false; there is no evidence argument (CA-42). Requires plan_path and workspace_root.",
);
lifecycleTool(
  "resume",
  "Resume a paused plan with the Cursor policy-only confirmation: paused -> active. The MCP cannot observe AskQuestion results, so it records attested: false; there is no evidence argument (CA-42). Requires plan_path and workspace_root.",
);
lifecycleTool(
  "complete",
  "Complete a running plan with the Cursor policy-only confirmation: active/paused -> completed, after the SDD ledger is complete and repository verification passes. The MCP cannot observe AskQuestion results, so it records attested: false; there is no evidence argument (CA-42). Requires plan_path and workspace_root.",
);

registerTool(
  "workit_docs_repo_link",
  {
    description: "Link the component docs repo in the toolkit config",
    inputSchema: {
      path: z.string(),
      confirmed: z.boolean(),
      delegation_token: delegationTokenSchema,
    },
  },
  async ({ path: docsPath, confirmed, delegation_token }) => {
    const identity = cursorMutationContext(
      process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
      delegation_token,
    );
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const result = linkDocsRepo(docsPath, confirmed);
    if (!result.ok) return jsonResult({ error: result.error });
    return jsonResult({ path: result.path });
  },
);

registerTool(
  "workit_docs_list",
  {
    description: "List local specs with docs-repo promotion status",
    inputSchema: { workspace_root: workspaceRootSchema },
  },
  async ({ workspace_root }) => jsonResult(listSpecs(workspace_root)),
);

registerTool(
  "workit_docs_promote",
  {
    description: "Promote a spec (+plan) to the linked docs repo with quality gate",
    inputSchema: {
      slug: z.string(),
      confirmed: z.boolean(),
      force: z.boolean().optional(),
      delegation_token: delegationTokenSchema,
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ slug, confirmed, force, delegation_token, workspace_root }) => {
    const identity = cursorMutationContext(workspace_root, delegation_token);
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const result = promoteSpec(workspace_root, slug, { confirmed, force });
    if (!result.ok) return jsonResult({ error: result.error, findings: result.findings ?? [] });
    return jsonResult({
      target_dir: result.target_dir,
      files: result.files,
      index_updated: result.index_updated,
    });
  },
);

registerTool(
  "workit_template_list",
  {
    description: "List editable templates with their source",
    inputSchema: { workspace_root: workspaceRootSchema },
  },
  async () => jsonResult({ templates: listTemplates() }),
);

registerTool(
  "workit_template_edit",
  {
    description: "Write an edited template to the toolkit config dir",
    inputSchema: {
      name: z.enum(["issue-update", "greeting", "headers"]),
      content: z.string(),
      confirmed: z.boolean(),
      delegation_token: delegationTokenSchema,
    },
  },
  async ({ name, content, confirmed, delegation_token }) => {
    const identity = cursorMutationContext(
      process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
      delegation_token,
    );
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const result = writeTemplate(name, content, confirmed);
    if (!result.ok) return jsonResult({ error: result.error });
    return jsonResult({ path: result.path });
  },
);

registerTool(
  "workit_rule_list",
  {
    description: "List canonical rules (config) with platforms",
    inputSchema: { workspace_root: workspaceRootSchema },
  },
  async () => jsonResult({ rules: listRules() }),
);

registerTool(
  "workit_rule_edit",
  {
    description: "Write a canonical rule to the toolkit config dir",
    inputSchema: {
      name: z.string(),
      description: z.string(),
      platforms: z.array(z.enum(["cursor", "opencode"])),
      body: z.string(),
      confirmed: z.boolean(),
      delegation_token: delegationTokenSchema,
    },
  },
  async ({ name, description, platforms, body, confirmed, delegation_token }) => {
    const identity = cursorMutationContext(
      process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
      delegation_token,
    );
    if (!identity.ok) return jsonResult({ error: identity.error, code: identity.code });
    const result = writeRule({ name, description, platforms, body }, confirmed);
    if (!result.ok) return jsonResult({ error: result.error });
    return jsonResult({ path: result.path });
  },
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  logger.info(EVENT.mcpConnection, { host: "cursor-mcp", server: "workit" });
} catch (err) {
  logger.error(EVENT.mcpConnection, errorDetail(err));
  throw err;
}
