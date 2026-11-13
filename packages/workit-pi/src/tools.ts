import {
  failure,
  contextReadJsonSchema,
  flatOperationJsonSchema,
  operationDescription,
  parseContextRead,
  readExternalContext,
  OPERATION_FAMILIES,
  parseAdvertisedOperation,
  success,
  TaskStore,
  WorkitCore,
  type OperationFamily,
  type ContractResult as Result,
} from "@workit-dev/core/src/core";
import { briefInspectResult } from "@workit-dev/core/src/core/task-evaluation";
import {
  handleHook,
  PI_DESCRIPTOR,
  promptNudge,
  rawGitPre,
  recordSkillLoad,
  shellNudge,
  skillFileIn,
  writePaths,
  type HookEvent,
  type HookInput,
} from "@workit-dev/core/hooks";
import { roleSteering } from "@workit-dev/core/src/hooks/steering";
import { approveCallDeny, approveCallIn } from "@workit-dev/core/src/approvals/call";
import { inlineAskFor, inlineCallDeny, inlineCallIn } from "@workit-dev/core/src/approvals/inline";
import {
  INLINE_TICKET_ENV,
  recordInlineAsk,
  liveApprovalRequest,
  recordApprovalAsked,
  recordApprovalGrant,
  recordApprovalRejected,
  renderApprovalRequest,
} from "@workit-dev/core/src/approvals/store";
import {
  escalateToolFailure,
  repeatedCliFailure,
  type FailureMemo,
} from "@workit-dev/core/src/hooks/repeat-failure";
import type {
  ExtensionContext,
  AgentToolResult,
  ToolCallEvent,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { piContext } from "./context";

const readOnlyActions = new Set(["list", "inspect", "preview", "explain", "export"]);

const output = (result: Result<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
});
type PiToolResult = AgentToolResult<Result<unknown>>;

/** Flat schema; Pi's transport may stringify non-string params, so those also accept strings. */
const schemaFor = (family: OperationFamily) =>
  flatOperationJsonSchema(family, { stringTolerant: true }) as any;

const decodeStrings = (value: unknown): unknown => {
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === "string" ? value : decoded;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(decodeStrings);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeStrings(entry)]),
    );
  return value;
};

const trustedForMutation = (ctx: ExtensionContext, action: unknown): Result<null> => {
  if (ctx.isProjectTrusted() || readOnlyActions.has(String(action)))
    return success(null, null, null);
  return failure("permission_denied", "Pi project is not trusted for Workit mutations");
};

const failures: FailureMemo = new Map();

const executeFamily = async (
  family: OperationFamily,
  input: unknown,
  ctx: ExtensionContext,
): Promise<PiToolResult> => {
  const result = runFamily(family, input, ctx);
  return output(
    escalateToolFailure(failures, piContext(ctx).caller.actor, `workit_${family}`, input, result),
  );
};

const runFamily = (
  family: OperationFamily,
  input: unknown,
  ctx: ExtensionContext,
): Result<unknown> => {
  // Pi may deliver structured params as JSON strings (host transport quirk);
  // flat-input normalization decodes them.
  const parsed = parseAdvertisedOperation(family, input, "pi");
  if (!parsed.ok) return parsed;
  const trust = trustedForMutation(ctx, (parsed.data as { action?: unknown }).action);
  if (!trust.ok) return trust;
  const context = piContext(ctx);
  const core = new WorkitCore(new TaskStore(ctx.cwd), context);
  const run = core[family] as unknown as (request: unknown) => Result<unknown>;
  const result = run.call(core, parsed.data);
  return family === "task" && (context.workerId ?? null) !== null
    ? briefInspectResult(parsed.data, result)
    : result;
};

export const registerWorkitTools = (
  pi: { registerTool(tool: ToolDefinition): void },
  options: { allowContext?: boolean } = {},
): void => {
  for (const family of OPERATION_FAMILIES)
    pi.registerTool({
      name: `workit_${family}`,
      label: `workit_${family}`,
      description: operationDescription(family),
      parameters: schemaFor(family),
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return executeFamily(family, input, ctx);
      },
    });
  if (options.allowContext === false) return;
  // Delivery (push, PR, merge) is the workit CLI's git/pr/stack verbs under the
  // workspace autonomy grants; Pi keeps only the read-only context reader.
  pi.registerTool({
    name: "workit_context",
    label: "workit_context",
    description:
      "Read Git, pull request, YouTrack, issue, changelog, release, or affected-file context.",
    parameters: contextReadJsonSchema(),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const parsed = parseContextRead(decodeStrings(input));
      if (!parsed.ok) return output(parsed);
      return output(await readExternalContext(ctx.cwd, parsed.data));
    },
  });
};

const hookInput = (ctx: ExtensionContext, event: HookEvent): HookInput => ({
  host: "pi",
  cwd: ctx.cwd,
  session: {
    id: process.env.WORKIT_PI_WORKER_SESSION || ctx.sessionManager?.getSessionId() || "",
    agentId: null,
    agentType: null,
    parentId: null,
  },
  permissionMode: null,
  transcriptPath: null,
  event,
});

type Blocked = { block: true; reason: string };

const APPROVE = "Approve once";
const REJECT = "Reject";
const EDIT = "Edit";

/**
 * `workit approve <id>…` in Pi's TUI (host-approval spec): the dialog shows
 * each request as Workit stored it, the answer is recorded here, in the
 * host's runtime, and the shell call is blocked with a result naming it.
 * Print mode has no dialog and RPC sends it to a client that may be a
 * program, so both fall through to the shared gate (the user runs it in a
 * terminal). Never throws: a failure records nothing.
 */
const approveInDialog = async (
  ids: readonly string[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<Blocked> => {
  try {
    const session = hookInput(ctx, { kind: "context.turn" }).session.id || null;
    const found = ids.map((id) => liveApprovalRequest(id));
    const shown = found.map((item) =>
      item.ok ? renderApprovalRequest(item.request) : item.reason,
    );
    const live = found.flatMap((item) => (item.ok ? [item.request.id] : []));
    if (live.length === 0)
      return { block: true, reason: `Nothing to approve: ${shown.join("; ")}` };
    const choice = await ctx.ui.select(`Workit asks you to approve:\n${shown.join("\n")}`, [
      APPROVE,
      REJECT,
      EDIT,
    ]);
    if (choice === APPROVE) {
      const toolUseId = event.toolCallId ?? `pi-${Date.now()}`;
      recordApprovalAsked({
        toolUseId,
        session: session ?? "",
        host: "pi",
        ids: live,
      });
      const recorded = live.filter(
        (id) =>
          recordApprovalGrant({
            id,
            host: "pi",
            session: session ?? "",
            toolUseId,
            via: "host",
          }).ok,
      );
      return {
        block: true,
        reason: `The user approved ${recorded.join(" ")} in Pi's dialog: recorded, one use each, for 15 minutes. Run the refused verb again; do not run workit approve again.`,
      };
    }
    if (choice === REJECT || choice === EDIT) {
      for (const id of live)
        recordApprovalRejected({
          id,
          host: "pi",
          session,
          edit: choice === EDIT,
        });
      return {
        block: true,
        reason:
          choice === EDIT
            ? `The user chose Edit for ${live.join(" ")}: change what the request names, then run the verb again; it writes a new request.`
            : `The user rejected ${live.join(" ")}. Do not retry it; report that the action was not approved.`,
      };
    }
    return {
      block: true,
      reason: `The user dismissed the approval dialog for ${live.join(" ")}: nothing was recorded.`,
    };
  } catch (error) {
    return {
      block: true,
      reason: `Workit could not record the approval: ${String(error)}`,
    };
  }
};

/**
 * The ask on the action itself (#864): a plain `workit youtrack note|…` call
 * in Pi's TUI shows its full text in a dialog; on Approve the ask is
 * recorded here and the call runs with its ticket, so the verb posts in that
 * same call. Reject or a dismissed dialog blocks it. Never throws.
 */
const askInline = async (
  words: readonly string[],
  command: string,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<Blocked | undefined> => {
  try {
    const ask = inlineAskFor(words, ctx.cwd);
    if (!ask) return undefined;
    const choice = await ctx.ui.select(ask.text, [APPROVE, REJECT]);
    if (choice !== APPROVE)
      return {
        block: true,
        reason:
          choice === REJECT
            ? `The user rejected ${ask.action}: nothing was posted. Do not retry it; report that it was not approved.`
            : `The user dismissed the dialog for ${ask.action}: nothing was posted.`,
      };
    const { ticket } = recordInlineAsk({
      kind: ask.kind,
      argvHash: ask.argvHash,
      contentHash: ask.contentHash,
      host: "pi",
      // What this process's bash tool exports as PI_SESSION_ID (a worker's
      // own session, never `<lead>:<worker>`): the verb reads the same (#864).
      session: ctx.sessionManager?.getSessionId() || null,
      agent: null,
      toolUseId: event.toolCallId ?? null,
    });
    (event.input as { command: string }).command = `${INLINE_TICKET_ENV}=${ticket} ${command}`;
    return undefined;
  } catch (error) {
    return { block: true, reason: `Workit could not record the approval: ${String(error)}` };
  }
};

export const enforceToolPolicy = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Blocked | Promise<Blocked | undefined> | undefined => {
  // The shared hook handler: branch policy, raw git/forge gate bypasses and
  // the before-write gate (S17). Pi's tool_call can only block, so a raw-git
  // nudge is added to the tool result instead (observeToolResult).
  const gate = (hookEvent: HookEvent) => {
    const decision = handleHook(hookInput(ctx, hookEvent), {
      descriptor: PI_DESCRIPTOR,
      addendum: null,
    });
    // A heavy command runs under the machine lease: Pi's tool_call input is
    // mutable, so the command is replaced in place.
    if (decision.kind === "rewrite" && event.toolName === "bash")
      (event.input as { command: string }).command = decision.command;
    return decision.kind === "deny" ? { block: true as const, reason: decision.reason } : undefined;
  };
  if (event.toolName === "bash") {
    const command = (event.input as { command?: unknown } | undefined)?.command;
    const approve = typeof command === "string" ? approveCallIn(command) : null;
    if (approve && !approve.plain) return { block: true, reason: approveCallDeny(approve.fix) };
    if (approve?.plain && ctx.mode === "tui" && ctx.hasUI)
      return approveInDialog(approve.ids, event, ctx);
    const inline = typeof command === "string" ? inlineCallIn(command) : null;
    if (inline && !inline.plain) return { block: true, reason: inlineCallDeny(inline.fix) };
    if (inline?.plain && ctx.mode === "tui" && ctx.hasUI) {
      // The shared gates judge the call first; only a pass reaches the dialog.
      const gated = gate({
        kind: "shell.pre",
        command: command as string,
        toolUseId: event.toolCallId ?? null,
      });
      return gated ?? askInline(inline.words, command as string, event, ctx);
    }
    return typeof command === "string"
      ? gate({
          kind: "shell.pre",
          command,
          toolUseId: event.toolCallId ?? null,
        })
      : undefined;
  }
  if (event.toolName === "read") {
    // Pi loads a skill by reading its SKILL.md: record a Workit one.
    const file = (event.input as { path?: unknown } | undefined)?.path;
    const skill = typeof file === "string" ? skillFileIn(file) : null;
    if (skill)
      recordSkillLoad(
        hookInput(ctx, { kind: "tool.pre", tool: "read", toolUseId: null }),
        skill,
        "read",
      );
    return undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  // Pi project trust is host policy and stays enforced.
  if (!ctx.isProjectTrusted()) return { block: true, reason: "Pi project is not trusted" };
  return gate({
    kind: "write.pre",
    tool: event.toolName,
    paths: writePaths(event.input),
    toolUseId: null,
    text: JSON.stringify(event.input ?? {}),
  });
};

/**
 * A finished bash call: a raw `git commit` is recorded for the session
 * (tool_result is Pi's post-tool event), and a raw git/forge command gets
 * the workit nudge appended to its output. Never throws.
 */
export const observeToolResult = (
  event: ToolResultEvent,
  ctx: ExtensionContext,
): { content: ToolResultEvent["content"] } | undefined => {
  try {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return undefined;
    const shown = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const session = piContext(ctx).caller.actor;
    const repeated = repeatedCliFailure(failures, session, command, shown);
    if (event.isError)
      return repeated
        ? { content: [...event.content, { type: "text", text: repeated }] }
        : undefined;
    const post = hookInput(ctx, {
      kind: "shell.post",
      command,
      stdout: "",
      exitCode: null,
      toolUseId: event.toolCallId,
    });
    handleHook(post, { descriptor: PI_DESCRIPTOR, addendum: null });
    // A Pi worker is a subagent: never a skill nudge, and a git nudge only
    // when its role's brief does not already say how to run git (#428).
    const named = process.env.WORKIT_PI_WORKER_ROLE;
    const role = named === "implementer" ? "implementer" : named ? "judge" : null;
    const nudge = process.env.WORKIT_PI_WORKER_SESSION
      ? rawGitPre(post, command, { nudge: roleSteering(role, false).nudges })
      : shellNudge(post, command);
    const extra = [nudge.kind === "context" ? nudge.text : null, repeated].filter(
      (text): text is string => text !== null,
    );
    return extra.length > 0
      ? {
          content: [...event.content, { type: "text", text: extra.join("\n\n") }],
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/** A main session's new prompt: the line naming the skill its trigger word routes to. */
export const skillPromptNudge = (prompt: string, ctx: ExtensionContext): string | null =>
  process.env.WORKIT_PI_WORKER_SESSION
    ? null
    : promptNudge(hookInput(ctx, { kind: "context.turn", prompt }), prompt);
