import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";

import { getWorkflowBootstrap, isWorkflowBootstrap } from "./bootstrap";
import { REMINDER_TEXT, DETECTION_TEXT, DOC_DELIVERY_TEXT } from "./core/reminder";
import { detectProseChoices, detectBacktickDocRefs } from "./core/detector";
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
      const vendoredSkillsPath = path.join(root, "vendor", "superpowers", "skills");
      for (const p of [skillPath, vendoredSkillsPath]) {
        if (existsSync(p) && !mutable.skills.paths.includes(p)) {
          mutable.skills.paths.push(p);
        }
      }
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
    // ponytail: mirrors Superpowers bootstrap — inject once on the first user turn;
    // plus a per-turn reminder and post-hoc prose-choice detection
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        if (!output.messages.length) return;
        const users = output.messages.filter((m) => m.info.role === "user");
        const firstUser = users[0];
        const currentUser = users[users.length - 1];
        if (!currentUser?.parts.length) return;

        // First turn only: full bootstrap anchored to the session's first user message
        if (firstUser?.parts.length) {
          const firstAnchor = firstUser.parts.find((part) => part.type === "text") ?? firstUser.parts[0];
          const firstText = firstUser.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text?: string }).text ?? "")
            .join("\n");
          const bootstrap = getWorkflowBootstrap();
          if (bootstrap && !firstText.includes("<workflow-toolkit-contract>")) {
            firstUser.parts.unshift({
              id: firstAnchor.id,
              sessionID: firstAnchor.sessionID,
              messageID: firstAnchor.messageID,
              type: "text" as const,
              text: bootstrap,
            });
          }
        }

        // Every turn: compact reminder anchored to the CURRENT user message (idempotent)
        const anchor = currentUser.parts.find((part) => part.type === "text") ?? currentUser.parts[0];
        const makePart = (text: string) => ({
          id: `${anchor.id}-r${Date.now()}`,
          sessionID: anchor.sessionID,
          messageID: anchor.messageID,
          type: "text" as const,
          text,
        });
        const currentText = currentUser.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text?: string }).text ?? "")
          .join("\n");
        if (!currentText.includes(REMINDER_TEXT)) {
          currentUser.parts.unshift(makePart(REMINDER_TEXT));
        }

        // Post-hoc detection: last assistant message (before current user turn) used prose choices?
        const beforeCurrent = output.messages.slice(0, output.messages.indexOf(currentUser));
        const lastAssistant = [...beforeCurrent].reverse().find((m) => m.info.role === "assistant");
        if (lastAssistant) {
          const assistantText = lastAssistant.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text?: string }).text ?? "")
            .join("\n");
          const usedQuestionTool = lastAssistant.parts.some(
            (p) => (p as { tool?: string }).tool === "question",
          );
          if (detectProseChoices(assistantText) && !usedQuestionTool && !currentText.includes("workflow-detection")) {
            currentUser.parts.unshift(makePart(DETECTION_TEXT));
          }
          const docRefs = detectBacktickDocRefs(assistantText);
          if (docRefs && !currentText.includes("workflow-doc-delivery")) {
            currentUser.parts.unshift(makePart(DOC_DELIVERY_TEXT));
          }
        }
      } catch {
        // never break the session from a hook
      }
    },
  };
};

export default plugin;
