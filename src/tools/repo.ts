import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, gitRevisionParts, ok, resolveInside, run } from "../core";
import { changelogApply } from "../legacy/changelog-apply.js";
import { gitContext } from "../legacy/git-context.js";
import { parseKeyValueLines, parseSections } from "../legacy/parse-sections.js";
import { parseVerifyOutput } from "../legacy/verify-parse.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = path.join(packageRoot, "scripts");
type RunResult = ReturnType<typeof run>;

export type RepoRuntime = {
  runScript(root: string, script: string, args: string[], env?: Record<string, string>): RunResult;
  git(root: string, args: string[]): RunResult;
};

const defaultRuntime: RepoRuntime = {
  runScript: (root, script, args, env) => run(root, path.join(scripts, script), args, env),
  git: (root, args) => run(root, "git", args),
};

const output = (value: unknown) => JSON.stringify(value, null, 2);
const diagnostics = ({ stdout, stderr, exitCode }: RunResult) => ({ stdout, stderr, exitCode });
const requireConfirmed = (confirmed: boolean) => confirmed === true ? null : output(fail("confirmed: true required"));
const protectedBranches = new Set(["main", "master", "develop", "prod"]);

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
const legacyScriptResult = (result: RunResult) => {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = json(result.stdout); } catch { /* handled below */ }
  if (result.exitCode !== 0 || parsed?.error || parsed?.ok === false) return fail(
    parsed?.error
      ? String(parsed.error)
      : parsed?.ok === false
        ? "legacy operation reported failure"
        : result.stderr.trim() || result.stdout.trim() || "workflow script failed",
    diagnostics(result),
  );
  if (!parsed) return fail("workflow output parse failed", diagnostics(result));
  const { ok: _legacyOk, ...data } = parsed;
  return ok({ ...data, exitCode: 0, ...(result.stderr ? { stderr: result.stderr } : {}) });
};
const optionalJson = (value: string | undefined) => {
  if (!value?.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
};
const sections = (stdout: string) => parseSections(stdout) as Record<string, string>;
export const normalizeLegacyResult = (value: Record<string, unknown>) => {
  if (value.error) return fail(String(value.error));
  if (value.ok === false) return fail("legacy operation reported failure");
  const { ok: _legacyOk, ...data } = value;
  return ok(data);
};

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
  const validateRange = (root: string, value: string) => {
    for (const revision of gitRevisionParts(value)) {
      const resolved = runtime.git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
      if (resolved.exitCode !== 0) throw new Error(`invalid Git revision or range: ${value}`);
    }
  };
  const contextWithRange = (
    root: string, script: string, value: string | undefined,
    parse: (stdout: string) => Record<string, unknown>,
  ) => {
    try { if (value) validateRange(root, value); }
    catch (error) { return output(fail(error instanceof Error ? error.message : "invalid Git revision or range")); }
    return output(scriptResult(runtime.runScript(root, script, value ? [value] : []), parse));
  };
  const invoke = (script: string, parse: (stdout: string) => Record<string, unknown>, args: string[] = []) =>
    async (_input: unknown, context: ToolContext) => output(scriptResult(runtime.runScript(context.directory, script, args), parse));

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
      execute: async ({ paths }, context) => output(ok(gitContext(context.directory, paths ?? []))),
    }),
    workflow_verify: tool({
      description: "Discover and run repository verification",
      args: { dry_run: tool.schema.boolean().optional() },
      execute: async ({ dry_run }, context) => output(scriptResult(
        runtime.runScript(context.directory, "verify-project.sh", dry_run ? ["--dry-run"] : []), parseVerifyOutput,
      )),
    }),
    workflow_pr_context: tool({
      description: "Gather branch-exclusive PR context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => contextWithRange(context.directory, "pr-ready-context.sh", range, parsePr),
    }),
    workflow_changelog_context: tool({
      description: "Gather changelog context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => contextWithRange(context.directory, "changelog-context.sh", range, parseChangelog),
    }),
    workflow_release_notes_context: tool({
      description: "Gather release notes for an explicit range",
      args: { range_or_tag: tool.schema.string() },
      execute: async ({ range_or_tag }, context) => !range_or_tag.trim()
        ? output(fail("release tag or range required"))
        : contextWithRange(context.directory, "release-notes-context.sh", range_or_tag, parseRelease),
    }),
    workflow_docs_context: tool({
      description: "Gather documentation refresh context",
      args: { range: tool.schema.string().optional() },
      execute: async ({ range }, context) => output(scriptResult(
        runtime.runScript(context.directory, "docs-refresh-context.sh", range ? [range] : []), parseDocs,
      )),
    }),
    workflow_changelog_apply: tool({
      description: "Apply confirmed Keep a Changelog entries to Unreleased",
      args: {
        confirmed: tool.schema.boolean(),
        entries: tool.schema.union([
          tool.schema.record(tool.schema.string(), tool.schema.array(tool.schema.string())),
          tool.schema.array(tool.schema.object({ category: tool.schema.string(), text: tool.schema.string() })),
        ]).optional(),
        path: tool.schema.string().optional(),
        normalize_only: tool.schema.boolean().optional(),
      },
      execute: async ({ confirmed, entries, path: changelogPath, normalize_only }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        try {
          changelogPath = resolveInside(context.directory, changelogPath ?? "CHANGELOG.md");
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "invalid changelog path"));
        }
        return output(normalizeLegacyResult(changelogApply({
          entries, path: changelogPath, normalize_only, workspace_root: realpathSync(context.directory),
        }) as Record<string, unknown>));
      },
    }),
    workflow_branch_setup: tool({
      description: "Apply a confirmed in-place feature or bugfix branch setup",
      args: {
        confirmed: tool.schema.boolean(),
        action: tool.schema.enum(["setup", "reapply_stash"]).optional(),
        sdd_dir: tool.schema.string().optional(),
        target_branch: tool.schema.string().optional(),
        stash: tool.schema.enum(["yes", "no"]).optional(),
      },
      execute: async ({ confirmed, action, sdd_dir, target_branch, stash }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        try {
          sdd_dir = resolveInside(context.directory, sdd_dir ?? "docs/superpowers/sdd");
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "invalid SDD path"));
        }
        return output(legacyScriptResult(runtime.runScript(context.directory, "branch/setup-branch.sh", [
          action ?? "setup", sdd_dir ?? "docs/superpowers/sdd", target_branch ?? "", stash ?? "no",
        ])));
      },
    }),
    workflow_commit: tool({
      description: "Commit the current index on a feature or bugfix branch without staging files",
      args: { confirmed: tool.schema.boolean(), message: tool.schema.string() },
      execute: async ({ confirmed, message }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const branch = runtime.git(context.directory, ["branch", "--show-current"]);
        if (branch.exitCode !== 0) return output(fail(
          branch.stderr.trim() || branch.stdout.trim() || "unable to read current branch", diagnostics(branch),
        ));
        const name = branch.stdout.trim();
        if (protectedBranches.has(name)) return output(fail(`cannot commit on protected branch ${name}`));
        if (!/^(feature|bugfix)\/.+/.test(name)) return output(fail("commit requires feature/* or bugfix/* branch"));
        return output(scriptResult(runtime.git(context.directory, ["commit", "-m", message]),
          (stdout) => ({ stdout: stdout.trim() })));
      },
    }),
    workflow_pr_create: tool({
      description: "Create a confirmed pull or merge request",
      args: {
        confirmed: tool.schema.boolean(),
        title: tool.schema.string(),
        body: tool.schema.string().optional(),
        draft: tool.schema.boolean().optional(),
        target_branch: tool.schema.string().optional(),
      },
      execute: async ({ confirmed, title, body, draft, target_branch }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const branch = runtime.git(context.directory, ["branch", "--show-current"]);
        if (branch.exitCode !== 0) return output(fail(
          branch.stderr.trim() || branch.stdout.trim() || "unable to read current branch", diagnostics(branch),
        ));
        const name = branch.stdout.trim();
        if (!/^(feature|bugfix)\/.+/.test(name)) {
          return output(fail("PR creation requires feature/* or bugfix/* branch"));
        }
        return output(legacyScriptResult(runtime.runScript(context.directory, "pr-create.sh", [], {
          WF_PR_TITLE: title,
          WF_PR_BODY: body ?? "",
          WF_PR_CONFIRMED: "true",
          WF_PR_DRAFT: draft ? "true" : "false",
          WF_PR_TARGET: target_branch ?? "",
        })));
      },
    }),
    workflow_toolkit_init_apply: tool({
      description: "Apply a confirmed toolkit initialization action",
      args: {
        confirmed: tool.schema.boolean(),
        action: tool.schema.enum([
          "youtrack_scaffold", "youtrack_json", "youtrack_token_placeholder", "vcs_scaffold",
        ]),
        base_url: tool.schema.string().optional(),
        default_mention: tool.schema.string().optional(),
        meeting_issue: tool.schema.string().optional(),
        vcs_provider: tool.schema.enum(["gitlab", "github"]).optional(),
        vcs_target_branch: tool.schema.string().optional(),
      },
      execute: async ({
        confirmed, action, base_url, default_mention, meeting_issue, vcs_provider, vcs_target_branch,
      }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const env = Object.fromEntries(Object.entries({
          WORKFLOW_YT_BASE_URL: base_url,
          WORKFLOW_YT_MENTION: default_mention,
          WORKFLOW_YT_MEETING_ISSUE: meeting_issue,
          WORKFLOW_VCS_PROVIDER: vcs_provider,
          WORKFLOW_VCS_TARGET_BRANCH: vcs_target_branch,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined));
        return output(legacyScriptResult(runtime.runScript(
          context.directory, "init/apply.sh", [action, "true"], env,
        )));
      },
    }),
  };
}
