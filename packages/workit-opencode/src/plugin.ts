import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

import { getWorkflowBootstrap } from "./bootstrap";
import {
  REMINDER_TEXT,
  DETECTION_TEXT,
  DOC_DELIVERY_TEXT,
  DOC_RENDER_TEXT,
  SDD_REMINDER_TEXT,
  shouldInjectSddReminder,
  CONFIG_GUARD_TEXT,
  shouldInjectConfigGuard,
  shouldInjectDocRender,
  VERIFICATION_TEXT,
  TDD_TEXT,
  BRAINSTORM_TEXT,
  DEBUG_TEXT,
  REVIEW_RECEPTION_TEXT,
  shouldInjectVerification,
  shouldInjectTdd,
  shouldInjectBrainstorm,
  shouldInjectDebug,
  shouldInjectReviewReception,
  ISSUE_RAIL_TEXT,
  shouldInjectIssueRail,
} from "@brainervirus/workit-core/src/core/reminder";
import {
  detectProseChoices,
  detectBacktickDocRefs,
  findActiveSubagentDrivenPlans,
  detectConfigGapError,
  detectRawDocDelivery,
  detectVerificationClaim,
  detectUntestedImplementation,
  detectImplementationWithoutDesign,
  detectFixWithoutRootCause,
  detectBlindReviewAcceptance,
  detectInstructionOption,
} from "@brainervirus/workit-core/src/core/detector";
import { createTools } from "@brainervirus/workit-core/src/tools";
import { adaptPluginHandoffClient } from "@brainervirus/workit-core/src/tools/handoff";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";

// Skills/commands/vendor/templates live in the core package. Resolve its root
// through node_modules (workspace symlink in the monorepo, sibling in a
// published install) instead of a relative path off this file.
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("@brainervirus/workit-core/package.json"));
const descriptions: Record<string, string> = {
  "wk-init": "Initialize workit configuration",
  "wk-status": "Show workflow and repository status",
  "wk-verify": "Discover and run repository verification",
  "wk-commit": "Review and create a guarded commit",
  "wk-pr": "Prepare or create a pull/merge request",
  "wk-changelog": "Preview and update Keep a Changelog",
  "wk-release-notes": "Draft notes for an explicit release range",
  "wk-docs-refresh": "Refresh documentation affected by changes",
  "wk-handoff": "Continue work in a new seeded OpenCode session",
  "wk-implement": "Execute an approved Superpowers plan",
  "wk-meetings": "Log confirmed meeting time in YouTrack",
  "wk-issue-update": "Post a confirmed YouTrack work update",
};

type PermissionDecision = "allow" | "ask" | "deny";
type MutablePermission = Record<string, unknown> & {
  "*"?: PermissionDecision;
  bash?: PermissionDecision | Record<string, PermissionDecision>;
};

const worktreeDenials = {
  "*git *worktree*": "deny",
} as const;

const withWorktreeDenials = (configuredPermission: unknown): MutablePermission => {
  const permission: MutablePermission =
    typeof configuredPermission === "string"
      ? { "*": configuredPermission as PermissionDecision }
      : { ...((configuredPermission ?? {}) as MutablePermission) };
  const bash = permission.bash;
  const bashRules: Record<string, PermissionDecision> =
    typeof bash === "string" ? { "*": bash } : { ...bash };
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
          template: readFileSync(path.join(root, "commands", `${name}.md`), "utf8").trim(),
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
      config.permission = withWorktreeDenials(config.permission) as typeof config.permission;
      for (const agent of Object.values(config.agent ?? {})) {
        if (!agent) continue;
        agent.permission = withWorktreeDenials(agent.permission) as typeof agent.permission;
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
          const firstAnchor =
            firstUser.parts.find((part) => part.type === "text") ?? firstUser.parts[0];
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
        const anchor =
          currentUser.parts.find((part) => part.type === "text") ?? currentUser.parts[0];
        const makePart = (text: string, tag = "r") => ({
          id: `${anchor.id}-${tag}${Date.now()}`,
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
        const assistantText = lastAssistant
          ? lastAssistant.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { text?: string }).text ?? "")
              .join("\n")
          : "";
        if (lastAssistant) {
          const usedQuestionTool = lastAssistant.parts.some(
            (p) => (p as { tool?: string }).tool === "question",
          );
          if (
            detectProseChoices(assistantText) &&
            !usedQuestionTool &&
            !currentText.includes("workflow-detection")
          ) {
            currentUser.parts.unshift(makePart(DETECTION_TEXT, "d"));
          }
          const docRefs = detectBacktickDocRefs(assistantText);
          if (docRefs && !currentText.includes("workflow-doc-delivery")) {
            currentUser.parts.unshift(makePart(DOC_DELIVERY_TEXT, "dd"));
          }
          if (detectRawDocDelivery(assistantText) && shouldInjectDocRender(currentText)) {
            currentUser.parts.unshift(makePart(DOC_RENDER_TEXT, "dr"));
          }
        }

        // Every turn: subagent-driven rail — active approved plans get one reminder (idempotent)
        // ponytail: process.cwd() ceiling — sessions launched from another directory scan the wrong docs/ tree
        const activePlans = findActiveSubagentDrivenPlans(process.cwd());
        if (activePlans.length > 0 && shouldInjectSddReminder(currentText)) {
          currentUser.parts.unshift(makePart(SDD_REMINDER_TEXT, "sdd"));
        }

        // Every turn: config-gap rail — structured config errors get a three-option question (idempotent)
        if (detectConfigGapError(assistantText) && shouldInjectConfigGuard(currentText)) {
          currentUser.parts.unshift(makePart(CONFIG_GUARD_TEXT, "cg"));
        }

        // Every turn: verification rail — completion claims without fresh check evidence (idempotent)
        if (detectVerificationClaim(assistantText) && shouldInjectVerification(currentText)) {
          currentUser.parts.unshift(makePart(VERIFICATION_TEXT, "vf"));
        }
        // Every turn: TDD rail — implementation without failing-test-first evidence (idempotent)
        if (detectUntestedImplementation(assistantText) && shouldInjectTdd(currentText)) {
          currentUser.parts.unshift(makePart(TDD_TEXT, "tdd"));
        }
        // Every turn: brainstorm rail — implementation without a presented design (idempotent)
        if (
          detectImplementationWithoutDesign(assistantText) &&
          shouldInjectBrainstorm(currentText)
        ) {
          currentUser.parts.unshift(makePart(BRAINSTORM_TEXT, "br"));
        }
        // Every turn: debugging rail — fixes without root-cause evidence (idempotent)
        if (detectFixWithoutRootCause(assistantText) && shouldInjectDebug(currentText)) {
          currentUser.parts.unshift(makePart(DEBUG_TEXT, "db"));
        }
        // Every turn: review-reception rail — feedback accepted without verification (idempotent)
        if (
          detectBlindReviewAcceptance(assistantText) &&
          shouldInjectReviewReception(currentText)
        ) {
          currentUser.parts.unshift(makePart(REVIEW_RECEPTION_TEXT, "rc"));
        }

        // Every turn: issue rail — previous assistant asked for free text via a clickable question option (idempotent)
        if (lastAssistant) {
          const questionParts = lastAssistant.parts.filter(
            (p) => (p as { tool?: string }).tool === "question",
          );
          const hasInstructionOption = questionParts.some((p) =>
            detectInstructionOption((p as { state?: { input?: unknown } }).state?.input),
          );
          if (hasInstructionOption && shouldInjectIssueRail(currentText)) {
            currentUser.parts.unshift(makePart(ISSUE_RAIL_TEXT, "ir"));
          }
        }
      } catch {
        // never break the session from a hook
      }
    },
  };
};

export default plugin;
