import { tool } from "@opencode-ai/plugin";
import { fail, gitRevisionParts, ok, run } from "@brainervirus/workit-core/src/core";
import { gitContext } from "@brainervirus/workit-core/src/core/git";
import {
  parseKeyValueLines,
  parseSections,
} from "@brainervirus/workit-core/src/core/parse-sections";
import { parseVerifyOutput } from "@brainervirus/workit-core/src/core/verify-parse";
import {
  changelogContext,
  docsRefreshContext,
  prReadyContext,
  releaseNotesContext,
} from "@brainervirus/workit-core/src/core/repo-context";
import { runVerifyProject } from "@brainervirus/workit-core/src/core/verify-project";
import { initStatusData, toolkitStatusData } from "@brainervirus/workit-core/src/core/init";
import type { RepoRuntime, RunResult } from "@brainervirus/workit-core/src/core/repo-tools";
import { executeInitApply, initApplyRuntime } from "../shared/init-apply";
import { output, scriptResult } from "../shared/repo-result";

const defaultRuntime: RepoRuntime = {
  git: (root, args) => run(root, "git", args),
  verifyProject: (root, dryRun) => runVerifyProject(root, dryRun),
  prContext: (root, range) => prReadyContext(root, range),
  changelogContext: (root, range) => changelogContext(root, range),
  docsContext: (root, range) => docsRefreshContext(root, range),
  releaseContext: (root, range) => releaseNotesContext(root, range),
  ...initApplyRuntime,
  initStatus: (root) => ({
    exitCode: 0,
    stdout: JSON.stringify(initStatusData()),
    stderr: "",
    cwd: root,
  }),
  toolkitStatus: async (root) => ({
    exitCode: 0,
    stdout: JSON.stringify(await toolkitStatusData()),
    stderr: "",
    cwd: root,
  }),
};

const json = (stdout: string) => JSON.parse(stdout.trim()) as Record<string, unknown>;
const optionalJson = (value: string | undefined) => {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const sections = (stdout: string) => parseSections(stdout) as Record<string, string>;

const parsePr = (stdout: string) => {
  const part = sections(stdout);
  const repo = parseKeyValueLines(part.Repository ?? "", [
    "branch",
    "range",
    "base_ref",
    "merge_base",
    "diff_range",
    "range_mode",
    "git_sync",
  ]);
  return {
    ...repo,
    commits: part.Commits ?? "",
    diff_stat: part["Diff Stat"] ?? "",
    files: part["Changed Files"] ?? "",
    pr_template: part["PR Template"] ?? "",
    vcs_config: optionalJson(part["VCS Config"]),
    merged_pr_style: optionalJson(part["Merged PR Style"]),
  };
};

const parseChangelog = (stdout: string) => {
  const part = sections(stdout);
  const repo = parseKeyValueLines(part.Repository ?? "", ["branch", "range"]);
  return {
    ...repo,
    changelog_excerpt: part["Existing CHANGELOG.md"] ?? "",
    rules: part["Keep a Changelog Rules"] ?? "",
    commits: part.Commits ?? "",
    diff_stat: part["Diff Stat"] ?? "",
    files: part["Changed Files"] ?? "",
  };
};

const parseRelease = (stdout: string) => {
  const part = sections(stdout);
  const repo = parseKeyValueLines(part.Repository ?? "", ["requested", "range"]);
  return {
    ...repo,
    tags: part.Tags ?? "",
    commits: part.Commits ?? "",
    diff_stat: part["Diff Stat"] ?? "",
    files: part["Changed Files"] ?? "",
    release_files: part["Existing Release Files"] ?? "",
  };
};

const parseDocs = (stdout: string) => {
  const part = sections(stdout);
  const repo = parseKeyValueLines(part.Repository ?? "", ["branch", "range"]);
  return {
    ...repo,
    changed_files: part["Changed Files"] ?? "",
    readme_preview: part["README Preview"] ?? "",
    package_scripts: part["Package Scripts"] ?? "",
    files: part["Documentation Files"] ?? "",
  };
};

export function createRepoTools(runtime: RepoRuntime = defaultRuntime) {
  const validateRange = (root: string, value: string) => {
    for (const revision of gitRevisionParts(value)) {
      const resolved = runtime.git(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ]);
      if (resolved.exitCode !== 0) throw new Error(`invalid Git revision or range: ${value}`);
    }
  };
  const contextWithRange = async (
    root: string,
    runContext: (root: string, value: string | undefined) => RunResult | Promise<RunResult>,
    value: string | undefined,
    parse: (stdout: string) => Record<string, unknown>,
  ) => {
    try {
      if (value) validateRange(root, value);
    } catch (error) {
      return output(fail(error instanceof Error ? error.message : "invalid Git revision or range"));
    }
    return output(scriptResult(await runContext(root, value), parse));
  };

  return {
    workit_init_status: tool({
      description: "Inspect toolkit initialization",
      args: {},
      execute: async (_input, context) =>
        output(scriptResult(await runtime.initStatus(context.directory), json)),
    }),
    workit_status: tool({
      description: "Inspect toolkit and repository state",
      args: {},
      execute: async (_input, context) =>
        output(scriptResult(await runtime.toolkitStatus(context.directory), json)),
    }),
    workit_git_context: tool({
      description: "Read Git branch and change context",
      args: { paths: tool.schema.array(tool.schema.string()).optional() },
      execute: async ({ paths }, context) => output(ok(gitContext(context.directory, paths ?? []))),
    }),
    workit_verify: tool({
      description: "Discover and run repository verification",
      args: { dry_run: tool.schema.boolean().optional() },
      execute: async ({ dry_run }, context) =>
        output(
          scriptResult(
            runtime.verifyProject(context.directory, Boolean(dry_run)),
            parseVerifyOutput,
          ),
        ),
    }),
    workit_pr_context: tool({
      description: "Gather branch-exclusive PR context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) =>
        contextWithRange(context.directory, runtime.prContext, range, parsePr),
    }),
    workit_changelog_context: tool({
      description: "Gather changelog context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) =>
        contextWithRange(context.directory, runtime.changelogContext, range, parseChangelog),
    }),
    workit_release_notes_context: tool({
      description: "Gather release notes for an explicit range",
      args: { range_or_tag: tool.schema.string() },
      execute: async ({ range_or_tag }, context) =>
        !range_or_tag.trim()
          ? output(fail("release tag or range required"))
          : contextWithRange(
              context.directory,
              (root, value) => runtime.releaseContext(root, value ?? ""),
              range_or_tag,
              parseRelease,
            ),
    }),
    workit_docs_context: tool({
      description: "Gather documentation refresh context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) =>
        output(scriptResult(runtime.docsContext(context.directory, range), parseDocs)),
    }),
    workit_init_apply: tool({
      description: "Apply a confirmed toolkit initialization action",
      args: {
        confirmed: tool.schema.boolean(),
        action: tool.schema.enum([
          "youtrack_scaffold",
          "youtrack_json",
          "youtrack_token_placeholder",
          "vcs_scaffold",
          "config",
          "gitignore",
          "hygiene",
          "branch_policy",
        ]),
        base_url: tool.schema.string().optional(),
        default_mention: tool.schema.string().optional(),
        meeting_issue: tool.schema.string().optional(),
        vcs_provider: tool.schema.enum(["gitlab", "github"]).optional(),
        vcs_target_branch: tool.schema.string().optional(),
        name: tool.schema.string().optional(),
        develop_branch: tool.schema.string().optional(),
        integration: tool.schema.enum(["pr", "merge"]).optional(),
        locale: tool.schema.string().optional(),
        locale_options: tool.schema.array(tool.schema.string()).optional(),
        timezone: tool.schema.string().optional(),
        branch_policy_preset: tool.schema
          .enum(["gitflow", "github-flow", "trunk-based", "custom"])
          .optional(),
        branch_policy_allowed: tool.schema.array(tool.schema.string()).optional(),
        branch_policy_protected: tool.schema.array(tool.schema.string()).optional(),
        include_open_source: tool.schema.boolean().optional(),
      },
      execute: async (args, context) => executeInitApply(args, context.directory, runtime),
    }),
  };
}
