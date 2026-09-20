import path from "node:path";
import { fail, ok } from "@brainervirus/workit-core/src/core";
import {
  configDir,
  mergeConfigValues,
  readConfig,
  writeConfig,
  type BranchPreset,
} from "@brainervirus/workit-core/src/core/config";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore";
import { ensureHygieneFiles } from "@brainervirus/workit-core/src/core/hygiene";
import { initApply } from "@brainervirus/workit-core/src/core/init";
import type { RepoRuntime } from "@brainervirus/workit-core/src/core/repo-tools";
import { legacyScriptResult, output, requireConfirmed } from "./repo-result";

/** The core initApply call in RunResult shape, shared so the V1 repo-tool
 * runtime and the V2 adapter run the identical confirmed action. */
export const initApplyRuntime: Pick<RepoRuntime, "initApply"> = {
  initApply: (root, action, env) => {
    const out = initApply({ action, confirmed: true, env });
    return {
      exitCode: out.error ? 1 : 0,
      stdout: JSON.stringify(out.data ?? out),
      stderr: "",
      cwd: root,
    };
  },
};

export type InitApplyArgs = {
  confirmed: boolean;
  action:
    | "youtrack_scaffold"
    | "youtrack_json"
    | "youtrack_token_placeholder"
    | "vcs_scaffold"
    | "config"
    | "gitignore"
    | "hygiene"
    | "branch_policy";
  base_url?: string;
  default_mention?: string;
  meeting_issue?: string;
  vcs_provider?: "gitlab" | "github";
  vcs_target_branch?: string;
  name?: string;
  develop_branch?: string;
  integration?: "pr" | "merge";
  locale?: string;
  locale_options?: string[];
  timezone?: string;
  branch_policy_preset?: "gitflow" | "github-flow" | "trunk-based" | "custom";
  branch_policy_allowed?: string[];
  branch_policy_protected?: string[];
  include_open_source?: boolean;
};

/** Host-neutral body of `workit_init_apply`, shared by the V1 tool wrapper and
 * the V2 adapter so the confirmed-action semantics cannot drift per host. */
export const executeInitApply = (
  args: InitApplyArgs,
  directory: string,
  runtime: Pick<RepoRuntime, "initApply">,
): string => {
  const rejected = requireConfirmed(args.confirmed);
  if (rejected) return rejected;
  const action = args.action;
  if (action === "hygiene") {
    const result = ensureHygieneFiles(directory, {
      confirmed: args.confirmed,
      includeOpenSource: args.include_open_source,
    });
    return output(result.ok ? ok(result) : fail(result.error));
  }
  if (action === "gitignore") {
    const result = ensureProjectGitignore(directory, args.confirmed);
    return output(result.ok ? ok(result) : fail(result.error));
  }
  if (action === "config") {
    // Mirrors core config.ts LOCALE_RE (keep in sync): 3-digit UN M.49
    // region subtags like es-419 validate alongside 2-letter regions.
    const LOCALE_RE = /^[a-z]{2,3}(-(?:[A-Z]{2}|[0-9]{3}))?$/;
    if (args.locale !== undefined && !LOCALE_RE.test(args.locale)) {
      return output(
        fail(`invalid locale: ${JSON.stringify(args.locale)} — expected BCP-47 like en or es-CL`),
      );
    }
    const current = readConfig();
    // RL-02/CA-23: the preset is authoritative — derived policy fields
    // always reset through the one shared merge (no divergent values).
    const next = mergeConfigValues(
      {
        locale: args.locale,
        localeOptions: args.locale_options,
        timezone: args.timezone,
        preset: args.branch_policy_preset as BranchPreset,
        allowed: args.branch_policy_allowed,
        protectedNames: args.branch_policy_protected,
      },
      current,
    );
    writeConfig(next);
    return output(ok({ action: "config", path: path.join(configDir(), "config.json"), ...next }));
  }
  const env = Object.fromEntries(
    Object.entries({
      WORKFLOW_YT_BASE_URL: args.base_url,
      WORKFLOW_YT_MENTION: args.default_mention,
      WORKFLOW_YT_MEETING_ISSUE: args.meeting_issue,
      WORKFLOW_VCS_PROVIDER: args.vcs_provider,
      WORKFLOW_VCS_TARGET_BRANCH: args.vcs_target_branch,
      WORKFLOW_WORKSPACE_ROOT: directory,
      WORKFLOW_BP_NAME: args.name,
      WORKFLOW_BP_DEVELOP: args.develop_branch,
      WORKFLOW_BP_INTEGRATION: args.integration,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return output(legacyScriptResult(runtime.initApply(directory, action, env)));
};
