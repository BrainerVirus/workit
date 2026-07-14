import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok, run } from "../core";
import { gitContext } from "../legacy/git-context.js";
import { parseKeyValueLines, parseSections } from "../legacy/parse-sections.js";
import { parseVerifyOutput } from "../legacy/verify-parse.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = path.join(packageRoot, "scripts");
type RunResult = ReturnType<typeof run>;

export type RepoRuntime = {
  runScript(root: string, script: string, args: string[]): RunResult;
  git(root: string, args: string[]): RunResult;
};

const defaultRuntime: RepoRuntime = {
  runScript: (root, script, args) => run(root, path.join(scripts, script), args),
  git: (root, args) => run(root, "git", args),
};

const output = (value: unknown) => JSON.stringify(value, null, 2);
const diagnostics = ({ stdout, stderr, exitCode }: RunResult) => ({ stdout, stderr, exitCode });

function scriptResult<T extends object>(result: RunResult, parse: (stdout: string) => T) {
  if (result.exitCode !== 0) {
    return fail(result.stderr.trim() || result.stdout.trim() || "workflow script failed", diagnostics(result));
  }
  try {
    return ok({ ...parse(result.stdout), exitCode: 0, ...(result.stderr ? { stderr: result.stderr } : {}) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "workflow output parse failed", diagnostics(result));
  }
}

const json = (stdout: string) => JSON.parse(stdout.trim()) as Record<string, unknown>;
const optionalJson = (value: string | undefined) => {
  if (!value?.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
};
const sections = (stdout: string) => parseSections(stdout) as Record<string, string>;

const parsePr = (stdout: string) => {
  const part = sections(stdout);
  const repo = parseKeyValueLines(part.Repository ?? "", [
    "branch", "range", "base_ref", "merge_base", "diff_range", "range_mode", "git_sync",
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
  const invoke = (script: string, parse: (stdout: string) => Record<string, unknown>, args: string[] = []) =>
    async (_input: unknown, context: ToolContext) => output(scriptResult(runtime.runScript(context.worktree, script, args), parse));

  return {
    workflow_toolkit_init_status: tool({
      description: "Inspect toolkit initialization", args: {}, execute: invoke("init/status.sh", json),
    }),
    workflow_toolkit_status: tool({
      description: "Inspect toolkit and repository state", args: {}, execute: invoke("init/toolkit-status.sh", json),
    }),
    workflow_git_context: tool({
      description: "Read Git branch and change context",
      args: { paths: tool.schema.array(tool.schema.string()).optional() },
      execute: async ({ paths }, context) => output(ok(gitContext(context.worktree, paths ?? []))),
    }),
    workflow_verify: tool({
      description: "Discover and run repository verification",
      args: { dry_run: tool.schema.boolean().optional() },
      execute: async ({ dry_run }, context) => output(scriptResult(
        runtime.runScript(context.worktree, "verify-project.sh", dry_run ? ["--dry-run"] : []), parseVerifyOutput,
      )),
    }),
    workflow_pr_context: tool({
      description: "Gather branch-exclusive PR context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => output(scriptResult(
        runtime.runScript(context.worktree, "pr-ready-context.sh", range ? [range] : []), parsePr,
      )),
    }),
    workflow_changelog_context: tool({
      description: "Gather changelog context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => output(scriptResult(
        runtime.runScript(context.worktree, "changelog-context.sh", range ? [range] : []), parseChangelog,
      )),
    }),
    workflow_release_notes_context: tool({
      description: "Gather release notes for an explicit range",
      args: { range_or_tag: tool.schema.string() },
      execute: async ({ range_or_tag }, context) => !range_or_tag.trim()
        ? output(fail("release tag or range required"))
        : output(scriptResult(
          runtime.runScript(context.worktree, "release-notes-context.sh", [range_or_tag]), parseRelease,
        )),
    }),
    workflow_docs_context: tool({
      description: "Gather documentation refresh context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => output(scriptResult(
        runtime.runScript(context.worktree, "docs-refresh-context.sh", range ? [range] : []), parseDocs,
      )),
    }),
  };
}
