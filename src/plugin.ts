import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { getWorkflowBootstrap, isWorkflowBootstrap } from "./bootstrap";
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

type PermissionDecision = "allow" | "ask" | "deny";
type MutablePermission = Record<string, unknown> & {
  "*"?: PermissionDecision;
  bash?: PermissionDecision | Record<string, PermissionDecision>;
};

const worktreeDenials = {
  "*git *worktree*": "deny",
} as const;

const withWorktreeDenials = (
  configuredPermission: unknown,
): MutablePermission => {
  const permission: MutablePermission =
    typeof configuredPermission === "string"
      ? { "*": configuredPermission as PermissionDecision }
      : { ...((configuredPermission ?? {}) as MutablePermission) };
  const bash = permission.bash;
  const bashRules: Record<string, PermissionDecision> =
    typeof bash === "string" ? { "*": bash } : { ...(bash ?? {}) };
  for (const pattern of Object.keys(worktreeDenials)) delete bashRules[pattern];
  permission.bash = { ...bashRules, ...worktreeDenials };
  return permission;
};

const plugin: Plugin = async ({ client }) => {
  const state = new WorkflowStateStore();
  return {
    tool: createTools(adaptPluginHandoffClient(client), state),
    config: async (config) => {
      const mutable = config as typeof config & {
        skills?: { paths?: string[] };
      };
      config.command ??= {};
      for (const [name, description] of Object.entries(descriptions)) {
        config.command[name] = {
          description,
          template: readFileSync(
            path.join(root, "commands", `${name}.md`),
            "utf8",
          ).trim(),
        };
      }
      mutable.skills ??= {};
      mutable.skills.paths ??= [];
      const skillPath = path.join(root, "skills");
      if (!mutable.skills.paths.includes(skillPath))
        mutable.skills.paths.push(skillPath);
      // Current OpenCode accepts top-level shorthand before the installed SDK types do.
      config.permission = withWorktreeDenials(
        config.permission,
      ) as typeof config.permission;
      for (const agent of Object.values(config.agent ?? {})) {
        if (!agent) continue;
        agent.permission = withWorktreeDenials(
          agent.permission,
        ) as typeof agent.permission;
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = state.compactionContext(sessionID);
      if (context) output.context.push(context);
    },
    // ponytail: mirrors Superpowers bootstrap — inject once on the first user turn
    "experimental.chat.messages.transform": async (_input, output) => {
      const bootstrap = getWorkflowBootstrap();
      if (!bootstrap || !output.messages.length) return;
      const firstUser = output.messages.find((m) => m.info.role === "user");
      if (!firstUser?.parts.length) return;
      if (firstUser.parts.some(
        (part) => part.type === "text" && isWorkflowBootstrap(part.text),
      )) return;
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });
    },
  };
};

export default plugin;
