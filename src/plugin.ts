import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { createTools } from "./tools";
import { adaptPluginHandoffClient } from "./tools/handoff";
import { WorkflowStateStore } from "./state";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const descriptions: Record<string, string> = {
  "wf-init": "Initialize workflow-toolkit configuration",
  "wf-status": "Show workflow and repository status",
  "wf-verify": "Discover and run repository verification",
  "wf-commit": "Review and create a guarded commit",
  "wf-pr": "Prepare or create a pull/merge request",
  "wf-changelog": "Preview and update Keep a Changelog",
  "wf-release-notes": "Draft notes for an explicit release range",
  "wf-docs-refresh": "Refresh documentation affected by changes",
  "wf-handoff": "Continue work in a new seeded OpenCode session",
  "wf-implement": "Execute an approved Superpowers plan",
  "wf-meetings": "Log confirmed meeting time in YouTrack",
  "wf-issue-update": "Post a confirmed YouTrack work update",
};

const shellWord = String.raw`(?:"(?:\\.|[^"])*"|'[^']*'|[^\s;&|()]+)`;
const gitWorktree = new RegExp(
  String.raw`(?:^|[\n;&|()])\s*(?:(?:command|env|sudo)\s+)*(?:[^\s;&|()]*/)?git(?:\s+${shellWord})*?\s+worktree(?=$|[\s;&|()])`,
  "m",
);

export const isGitWorktreeCommand = (command: unknown) =>
  typeof command === "string" && gitWorktree.test(command);

const plugin: Plugin = async ({ client }) => {
  const state = new WorkflowStateStore();
  return {
    tool: createTools(adaptPluginHandoffClient(client), state),
    config: async (config) => {
      const mutable = config as typeof config & { skills?: { paths?: string[] } };
      config.command ??= {};
      for (const [name, description] of Object.entries(descriptions)) {
        config.command[name] = {
          description,
          template: readFileSync(path.join(root, "commands", `${name}.md`), "utf8").trim(),
        };
      }
      mutable.skills ??= {};
      mutable.skills.paths ??= [];
      const skillPath = path.join(root, "skills");
      if (!mutable.skills.paths.includes(skillPath)) mutable.skills.paths.push(skillPath);
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && isGitWorktreeCommand(output.args?.command)) {
        throw new Error(
          "Workflow Toolkit: worktrees are forbidden; use workflow_resolve_branch and workflow_branch_setup for an in-place feature/* or bugfix/* branch.",
        );
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = state.compactionContext(sessionID);
      if (context) output.context.push(context);
    },
  };
};

export default plugin;
