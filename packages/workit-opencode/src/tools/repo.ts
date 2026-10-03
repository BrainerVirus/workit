import { tool } from "@opencode-ai/plugin";
import type { RepoRuntime } from "../shared/repo-result";
import { executeInitApply, initApplyRuntime } from "../shared/init-apply";

/** OpenCode V1 registers only the confirmed init surface the contract claims. */
export function createRepoTools(runtime: RepoRuntime = initApplyRuntime) {
  return {
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
