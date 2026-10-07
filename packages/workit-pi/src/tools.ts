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
} from "@brainervirus/workit-core/src/core";
import {
  handleHook,
  PI_DESCRIPTOR,
  rawGitPre,
  writePaths,
  type HookEvent,
  type HookInput,
} from "@brainervirus/workit-core/hooks";
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

const executeFamily = async (
  family: OperationFamily,
  input: unknown,
  ctx: ExtensionContext,
): Promise<PiToolResult> => {
  // Pi may deliver structured params as JSON strings (host transport quirk);
  // flat-input normalization decodes them.
  const parsed = parseAdvertisedOperation(family, input, "pi");
  if (!parsed.ok) return output(parsed);
  const trust = trustedForMutation(ctx, (parsed.data as { action?: unknown }).action);
  if (!trust.ok) return output(trust);
  const core = new WorkitCore(new TaskStore(ctx.cwd), piContext(ctx));
  const run = core[family] as unknown as (request: unknown) => Result<unknown>;
  return output(run.call(core, parsed.data));
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

export const enforceToolPolicy = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
): { block: true; reason: string } | undefined => {
  // The shared hook handler: branch policy, raw git/forge gate bypasses and
  // the before-write gate (S17). Pi's tool_call can only block, so a raw-git
  // nudge is added to the tool result instead (observeToolResult).
  const gate = (hookEvent: HookEvent) => {
    const decision = handleHook(hookInput(ctx, hookEvent), {
      descriptor: PI_DESCRIPTOR,
      addendum: null,
    });
    return decision.kind === "deny" ? { block: true as const, reason: decision.reason } : undefined;
  };
  if (event.toolName === "bash") {
    const command = (event.input as { command?: unknown } | undefined)?.command;
    return typeof command === "string"
      ? gate({ kind: "shell.pre", command, toolUseId: event.toolCallId ?? null })
      : undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  // Pi project trust is host policy and stays enforced.
  if (!ctx.isProjectTrusted()) return { block: true, reason: "Pi project is not trusted" };
  return gate({
    kind: "write.pre",
    tool: event.toolName,
    paths: writePaths(event.input),
    toolUseId: null,
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
    if (event.toolName !== "bash" || event.isError) return undefined;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return undefined;
    const post = hookInput(ctx, {
      kind: "shell.post",
      command,
      stdout: "",
      exitCode: null,
      toolUseId: event.toolCallId,
    });
    handleHook(post, { descriptor: PI_DESCRIPTOR, addendum: null });
    const nudge = rawGitPre(post, command);
    return nudge.kind === "context"
      ? { content: [...event.content, { type: "text", text: nudge.text }] }
      : undefined;
  } catch {
    return undefined;
  }
};
