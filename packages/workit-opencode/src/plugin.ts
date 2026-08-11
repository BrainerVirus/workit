import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  COORDINATOR_WRITE_TOOLS,
  HostReceiptStore,
  subagentDrivenInterception,
} from "@brainervirus/workit-core/src/core/flow-state";
import { createTools } from "./tools";
import { adaptPluginHandoffClient } from "./tools/handoff";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import {
  describeConfigSource,
  setDiagnosticLogger,
} from "@brainervirus/workit-core/src/core/config";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: events mirror to OpenCode's server log and stderr, never the agent
// conversation. MCP stdout is never written by the logger.
type AppLogClient = {
  app?: {
    log?: (options: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
};

let openCodeClient: AppLogClient | undefined;

export const logger = createLogger({
  appLog: (event) => {
    const result = openCodeClient?.app?.log?.({
      body: {
        service: "workit",
        level: event.level,
        message: event.message,
        extra: event.context,
      },
    });
    if (result) void result.catch(() => {});
  },
  stderr: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

// Commands/skills/vendor/templates ship package-locally under assets/ so the
// packaged plugin resolves them without a share/checkout or monorepo dependency
// (PT-06/PT-07). src/ and dist/ are both one level below the package root.
const root = fileURLToPath(new URL("../assets/", import.meta.url));

// Package provenance: name + version only; a missing/unreadable package.json is
// a bounded warn event, never a crash (DG-04).
export const loadProvenance = (pkgUrl: string | URL): Record<string, string> => {
  try {
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { name?: string; version?: string };
    return {
      name: String(pkg.name ?? "workit-opencode"),
      version: String(pkg.version ?? "unknown"),
    };
  } catch (err) {
    logger.warn(EVENT.provenance, errorDetail(err));
    return { name: "workit-opencode", version: "unknown" };
  }
};

// Asset loading is fail-open: one missing command template is a sanitized warn
// event, and the rest of the plugin still loads (DG-04, DG-05).
export const loadCommandTemplates = (rootDir: string, names: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = readFileSync(path.join(rootDir, "commands", `${name}.md`), "utf8").trim();
    } catch (err) {
      logger.warn(EVENT.assets, { component: "command", name, ...errorDetail(err) });
    }
  }
  return out;
};

// Uncaught failures are reported as bounded sanitized events; the host owns the
// process, so this only logs (DG-04). The handler is installed once inside the
// plugin factory, where the host boundary actually exists.
export const reportUncaught = (phase: string, reason: unknown): void => {
  logger.error(EVENT.uncaughtFailure, { phase, ...errorDetail(reason) });
};

let uncaughtHandlersInstalled = false;
const installUncaughtHandlers = (): void => {
  if (uncaughtHandlersInstalled) return;
  uncaughtHandlersInstalled = true;
  process.on("unhandledRejection", (reason) => reportUncaught("unhandledRejection", reason));
};
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

/**
 * Extract the selected label from the answered `question` tool result
 * (AR-12). The host returns `metadata.answers` as an array of label arrays
 * (one per question); flow questions are single-select, so only a
 * one-element first answer yields a receipt. Multi-select or unanswered
 * questions produce no receipt and the approval tool then fails closed.
 */
export const questionAnswerLabel = (result: { metadata?: unknown }): string | undefined => {
  const answers = (result.metadata as { answers?: unknown } | undefined)?.answers;
  if (!Array.isArray(answers)) return undefined;
  const first = answers[0];
  if (!Array.isArray(first) || first.length !== 1) return undefined;
  const label = first[0];
  return typeof label === "string" ? label : undefined;
};

// AR-12: observe the answered native `question` and store a one-use
// receipt bound to sessionID + callID + exact selected label + timestamp.
// Correlation is by session + freshness + one-use + negative-label rejection
// (see HostReceiptStore in flow-state.ts, FINDING 2) — no execution window
// exists, because on a real host the model first calls the native `question`
// (user answers), then calls the approval tool.

const plugin: Plugin = async ({ client, directory }) => {
  openCodeClient = client as unknown as AppLogClient;
  installUncaughtHandlers();
  logger.info(EVENT.initialization, { host: "opencode", plugin_root: root });
  logger.info(EVENT.provenance, loadProvenance(new URL("../package.json", import.meta.url)));
  logger.info(EVENT.configurationSource, describeConfigSource());
  setDiagnosticLogger(logger);
  const state = new WorkflowStateStore();
  const receipts = new HostReceiptStore();
  return {
    tool: createTools(adaptPluginHandoffClient(client), state, client, receipts),
    // AR-12: observe the answered native `question` and store a one-use
    // receipt bound to sessionID + callID + exact selected label + timestamp
    // (+ the question text, best effort). The approval/menu tools consume the
    // session's most recent receipt (FINDING 2); their schemas expose no
    // evidence object, so model-crafted evidence cannot be injected.
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "question") return;
      const label = questionAnswerLabel(output);
      if (label === undefined) return; // multi-select/unanswered → no receipt
      const args = input.args as { question?: string; title?: string } | undefined;
      const questionText = args?.question ?? args?.title;
      receipts.record(input.sessionID, input.callID, label, Date.now(), questionText);
    },
    // CA-18/AR-13: while a subagent-driven plan is active, the root
    // (coordinator) session is denied known write tools and any shell command
    // outside the bounded read/test/review allowlist. Delegated child sessions
    // (host parentage) are the workers and are never intercepted. Fail-closed:
    // an unverifiable session is treated as the root coordinator. Scope note
    // (round 3): interception covers the SESSION's own workspace (its host
    // `directory`); a root session living in a DIFFERENT workspace than the
    // plan root is not that plan's coordinator and is not intercepted there —
    // the coordinator session is the one in the plan's workspace.
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash" && !COORDINATOR_WRITE_TOOLS.includes(input.tool)) return;
      let parentID: string | undefined;
      let sessionDirectory: string | undefined;
      try {
        const session = await client.session.get({ path: { id: input.sessionID } });
        parentID = session?.data?.parentID;
        sessionDirectory = session?.data?.directory;
      } catch {
        // fail closed: treated as the root coordinator
      }
      const active = findActiveSubagentDrivenPlans(sessionDirectory ?? directory).length > 0;
      const decision = subagentDrivenInterception({
        tool: input.tool,
        command: (output.args as { command?: string } | undefined)?.command,
        parentID,
        active,
      });
      if (!decision.ok) throw new Error(decision.error);
    },
    config: async (config) => {
      const mutable = config as typeof config & {
        skills?: { paths?: string[] };
      };
      config.command ??= {};
      const templates = loadCommandTemplates(root, Object.keys(descriptions));
      for (const [name, description] of Object.entries(descriptions)) {
        const template = templates[name];
        if (template === undefined) continue;
        config.command[name] = {
          description,
          template,
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
      logger.info(EVENT.assets, { commands_loaded: Object.keys(templates).length });
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
        // FG-06/CA-21: discovery scans the host session workspace, never process.cwd()
        const activePlans = findActiveSubagentDrivenPlans(directory);
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
      } catch (err) {
        // never break the session from a hook, but report the failure (DG-05)
        logger.warn(EVENT.hooks, { boundary: "chat.messages.transform", ...errorDetail(err) });
      }
    },
  };
};

export default plugin;
