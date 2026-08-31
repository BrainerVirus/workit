import path from "node:path";
import { realpathSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { fail, gitRevisionParts, ok, resolveInside, run } from "@brainervirus/workit-core/src/core";
import { changelogApply } from "@brainervirus/workit-core/src/core/changelog";
import { gitContext } from "@brainervirus/workit-core/src/core/git";
import {
  parseKeyValueLines,
  parseSections,
} from "@brainervirus/workit-core/src/core/parse-sections";
import { parseVerifyOutput } from "@brainervirus/workit-core/src/core/verify-parse";
import { branchSetup, resolveBranchPolicyFor } from "@brainervirus/workit-core/src/core/branch";
import {
  configDir,
  getDiagnosticLogger,
  mergeConfigValues,
  readConfig,
  writeConfig,
  type BranchPreset,
} from "@brainervirus/workit-core/src/core/config";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore";
import { ensureHygieneFiles } from "@brainervirus/workit-core/src/core/hygiene";
import {
  changelogContext,
  docsRefreshContext,
  prReadyContext,
  releaseNotesContext,
} from "@brainervirus/workit-core/src/core/repo-context";
import { runVerifyProject } from "@brainervirus/workit-core/src/core/verify-project";
import { prCreate } from "@brainervirus/workit-core/src/core/pr-create";
import {
  initApply,
  initStatusData,
  toolkitStatusData,
} from "@brainervirus/workit-core/src/core/init";
import {
  normalizeLegacyResult,
  type RepoRuntime,
  type RunResult,
} from "@brainervirus/workit-core/src/core/repo-tools";

const defaultRuntime: RepoRuntime = {
  git: (root, args) => run(root, "git", args),
  verifyProject: (root, dryRun) => runVerifyProject(root, dryRun),
  prContext: (root, range) => prReadyContext(root, range),
  changelogContext: (root, range) => changelogContext(root, range),
  docsContext: (root, range) => docsRefreshContext(root, range),
  releaseContext: (root, range) => releaseNotesContext(root, range),
  prCreate: (root, env) => {
    // B6: merge the process env so WORKFLOW_YT_ISSUE/WORKFLOW_GH_ISSUE (and
    // any other env-driven issue linking) set by the host still reaches
    // prCreate alongside the 5 explicit WF_PR_* tool arguments.
    const out = prCreate({ ...process.env, ...env }, root);
    return {
      exitCode: out.error || out.ok === false ? 1 : 0,
      stdout: JSON.stringify(out),
      stderr: "",
      cwd: root,
    };
  },
  initApply: (root, action, env) => {
    const out = initApply({ action, confirmed: true, env });
    return {
      exitCode: out.error ? 1 : 0,
      stdout: JSON.stringify(out.data ?? out),
      stderr: "",
      cwd: root,
    };
  },
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

const output = (value: unknown) => JSON.stringify(value, null, 2);
const diagnostics = ({ stdout, stderr, exitCode }: RunResult) => ({ stdout, stderr, exitCode });
const requireConfirmed = (confirmed: boolean) =>
  confirmed === true ? null : output(fail("confirmed: true required"));

function scriptResult<T extends object>(result: RunResult, parse: (stdout: string) => T) {
  if (result.exitCode !== 0) {
    return fail(
      result.stderr.trim() || result.stdout.trim() || "workflow script failed",
      diagnostics(result),
    );
  }
  try {
    return ok({
      ...parse(result.stdout),
      exitCode: 0,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "workflow output parse failed",
      diagnostics(result),
    );
  }
}

const json = (stdout: string) => JSON.parse(stdout.trim()) as Record<string, unknown>;
const legacyScriptResult = (result: RunResult) => {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = json(result.stdout);
  } catch {
    /* handled below */
  }
  if (result.exitCode !== 0 || parsed?.error || parsed?.ok === false)
    return fail(
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
    workit_changelog_apply: tool({
      description: "Apply confirmed Keep a Changelog entries to Unreleased",
      args: {
        confirmed: tool.schema.boolean(),
        entries: tool.schema
          .union([
            tool.schema.record(tool.schema.string(), tool.schema.array(tool.schema.string())),
            tool.schema.array(
              tool.schema.object({ category: tool.schema.string(), text: tool.schema.string() }),
            ),
          ])
          .optional(),
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
        return output(
          normalizeLegacyResult(
            changelogApply({
              entries,
              path: changelogPath,
              normalize_only,
              workspace_root: realpathSync(context.directory),
            }) as Record<string, unknown>,
          ),
        );
      },
    }),
    workit_branch_setup: tool({
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
        let resolvedSdd = sdd_dir ?? "docs";
        try {
          resolvedSdd = resolveInside(context.directory, resolvedSdd);
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "invalid SDD path"));
        }
        // Flow-guard journal rides the plugin's diagnostic logger when the
        // host installed one; absent logger keeps branchSetup silent.
        const diagnostic = getDiagnosticLogger();
        const result = branchSetup({
          action,
          sdd_dir: resolvedSdd,
          target_branch,
          stash,
          workspace_root: context.directory,
          log: diagnostic ? (message) => diagnostic.info(message) : undefined,
        });
        return output(
          legacyScriptResult({
            stdout: JSON.stringify(result),
            stderr: "",
            exitCode: result.error ? 1 : 0,
            cwd: context.directory,
          }),
        );
      },
    }),
    workit_commit: tool({
      description: "Commit the current index on a feature or bugfix branch without staging files",
      args: { confirmed: tool.schema.boolean(), message: tool.schema.string() },
      execute: async ({ confirmed, message }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const branch = runtime.git(context.directory, ["branch", "--show-current"]);
        if (branch.exitCode !== 0)
          return output(
            fail(
              branch.stderr.trim() || branch.stdout.trim() || "unable to read current branch",
              diagnostics(branch),
            ),
          );
        const name = branch.stdout.trim();
        const pol = resolveBranchPolicyFor(context.directory);
        if (pol.protected.has(name.toLowerCase()))
          return output(fail(`cannot commit on protected branch ${name}`));
        if (!pol.allowed.some((r) => r.test(name)) || name.endsWith("/"))
          return output(fail(`commit requires an allowed branch (current: ${name})`));
        return output(
          scriptResult(runtime.git(context.directory, ["commit", "-m", message]), (stdout) => ({
            stdout: stdout.trim(),
          })),
        );
      },
    }),
    workit_pr_create: tool({
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
        if (branch.exitCode !== 0)
          return output(
            fail(
              branch.stderr.trim() || branch.stdout.trim() || "unable to read current branch",
              diagnostics(branch),
            ),
          );
        const name = branch.stdout.trim();
        const pol = resolveBranchPolicyFor(context.directory);
        if (!pol.allowed.some((r) => r.test(name)) || name.endsWith("/")) {
          return output(fail(`PR creation requires an allowed branch (current: ${name})`));
        }
        return output(
          legacyScriptResult(
            runtime.prCreate(context.directory, {
              WF_PR_TITLE: title,
              WF_PR_BODY: body ?? "",
              WF_PR_CONFIRMED: "true",
              WF_PR_DRAFT: draft ? "true" : "false",
              WF_PR_TARGET: target_branch ?? "",
            }),
          ),
        );
      },
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
      execute: async (
        {
          confirmed,
          action,
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
        },
        context,
      ) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        if (action === "hygiene") {
          const result = ensureHygieneFiles(context.directory, {
            confirmed,
            includeOpenSource: include_open_source,
          });
          return output(result.ok ? ok(result) : fail(result.error));
        }
        if (action === "gitignore") {
          const result = ensureProjectGitignore(context.directory, confirmed);
          return output(result.ok ? ok(result) : fail(result.error));
        }
        if (action === "config") {
          // Mirrors core config.ts LOCALE_RE (keep in sync): 3-digit UN M.49
          // region subtags like es-419 validate alongside 2-letter regions.
          const LOCALE_RE = /^[a-z]{2,3}(-(?:[A-Z]{2}|[0-9]{3}))?$/;
          if (locale !== undefined && !LOCALE_RE.test(locale)) {
            return output(
              fail(`invalid locale: ${JSON.stringify(locale)} — expected BCP-47 like en or es-CL`),
            );
          }
          const current = readConfig();
          // RL-02/CA-23: the preset is authoritative — derived policy fields
          // always reset through the one shared merge (no divergent values).
          const next = mergeConfigValues(
            {
              locale,
              localeOptions: locale_options,
              timezone,
              preset: branch_policy_preset as BranchPreset,
              allowed: branch_policy_allowed,
              protectedNames: branch_policy_protected,
            },
            current,
          );
          writeConfig(next);
          return output(
            ok({ action: "config", path: path.join(configDir(), "config.json"), ...next }),
          );
        }
        const env = Object.fromEntries(
          Object.entries({
            WORKFLOW_YT_BASE_URL: base_url,
            WORKFLOW_YT_MENTION: default_mention,
            WORKFLOW_YT_MEETING_ISSUE: meeting_issue,
            WORKFLOW_VCS_PROVIDER: vcs_provider,
            WORKFLOW_VCS_TARGET_BRANCH: vcs_target_branch,
            WORKFLOW_WORKSPACE_ROOT: context.directory,
            WORKFLOW_BP_NAME: name,
            WORKFLOW_BP_DEVELOP: develop_branch,
            WORKFLOW_BP_INTEGRATION: integration,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        return output(legacyScriptResult(runtime.initApply(context.directory, action, env)));
      },
    }),
  };
}
