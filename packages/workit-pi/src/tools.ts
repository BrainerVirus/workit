import {
  failure,
  operationJsonSchema,
  OPERATION_FAMILIES,
  parseOperation,
  success,
  TaskStore,
  WorkitCore,
  type OperationFamily,
  type ContractResult as Result,
} from "@brainervirus/workit-core/src/core";
import { assertProductWriteAllowed } from "@brainervirus/workit-core/src/core/workers";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { piContext } from "./context";

const readOnlyActions = new Set(["list", "inspect", "preview", "explain", "export"]);
const decisionReceipt = (actor: string, callId: string, approved: boolean) => ({
  actor,
  callId,
  approved,
});

const output = (result: Result<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
});

const nativeAuthority = (actor: string) => ({
  verifyDecision: ({ observation, expected, caller }: any): Result<any> => {
    if (
      caller.host !== "pi" ||
      caller.actor !== actor ||
      observation?.actor !== actor ||
      observation?.approved !== (expected.response === "approved")
    )
      return failure(
        "permission_denied",
        "native Pi decision receipt is not bound to this session",
      );
    return success(null, null, {
      kind: "host_observed",
      host: "pi",
      session: { kind: "host", host: "pi", handle: actor },
      workerId: null,
      receipts: [{ kind: "host", host: "pi", handle: `decision:${observation.callId}` }],
    });
  },
  verifyAction: () => failure("permission_denied", "native Pi action observation is unavailable"),
});

const schemaFor = (family: OperationFamily) =>
  ({ type: "object", ...operationJsonSchema(family) }) as any;

const trustedForMutation = (ctx: ExtensionContext, action: unknown): Result<null> => {
  if (ctx.isProjectTrusted() || readOnlyActions.has(String(action)))
    return success(null, null, null);
  return failure("permission_denied", "Pi project is not trusted for Workit mutations");
};

const executeFamily = async (
  family: OperationFamily,
  toolCallId: string,
  input: unknown,
  ctx: ExtensionContext,
): Promise<any> => {
  const parsed = parseOperation(family, input);
  if (!parsed.ok) return output(parsed);
  const trust = trustedForMutation(ctx, (parsed.data as { action?: unknown }).action);
  if (!trust.ok) return output(trust);
  const context = piContext(ctx);
  const store = new TaskStore(ctx.cwd);
  const core = new WorkitCore(store, {
    ...context,
    nativeAuthority: nativeAuthority(context.caller.actor),
  });
  if (family === "decision" && (parsed.data as { action?: string }).action === "record") {
    if (!ctx.hasUI)
      return output(
        failure("needs_input", "interactive decision UI is unavailable", {
          capability: "interactive_decision",
          operation: "decision.record",
        }),
      );
    const decision = parsed.data as {
      response: "approved" | "rejected";
      binding: { presented: string };
    };
    const approved = await ctx.ui.confirm("Workit decision", decision.binding.presented);
    if (approved !== (decision.response === "approved"))
      return output(
        failure("permission_denied", "Pi decision answer did not match the requested response"),
      );
    return output(
      core.observeDecision(
        parsed.data,
        decisionReceipt(context.caller.actor, toolCallId, approved),
      ),
    );
  }
  const run = core[family] as unknown as (request: unknown) => Result<unknown>;
  return output(run.call(core, parsed.data));
};

export const registerWorkitTools = (pi: {
  registerTool(tool: ToolDefinition<any>): void;
}): void => {
  for (const family of OPERATION_FAMILIES)
    pi.registerTool({
      name: `workit_${family}`,
      label: `workit_${family}`,
      description: `Workit ${family} operations backed by the shared task contract.`,
      parameters: schemaFor(family),
      async execute(toolCallId, input, _signal, _onUpdate, ctx) {
        return executeFamily(family, toolCallId, input, ctx);
      },
    });
};

const writePaths = (toolName: string, input: Record<string, unknown>): string[] =>
  toolName === "write" || toolName === "edit" ? [String(input.path ?? input.filePath ?? "")] : [];

export const enforceNativeWriter = (
  event: any,
  ctx: ExtensionContext,
): { block: true; reason: string } | undefined => {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  if (!ctx.isProjectTrusted()) return { block: true, reason: "Pi project is not trusted" };
  const store = new TaskStore(ctx.cwd);
  const workspace = store.readWorkspace();
  if (!workspace.ok) return { block: true, reason: workspace.error };
  if (!workspace.data) return undefined;
  const tasks = store.listTasks();
  if (!tasks.ok) return { block: true, reason: tasks.error };
  const active = tasks.data.filter(
    (task) => task.status === "active" && task.workspaceId === workspace.data?.id,
  );
  if (active.length === 0) return undefined;
  if (active.length !== 1) return { block: true, reason: "Workit writer state is ambiguous" };
  const result = assertProductWriteAllowed({
    task: active[0],
    workspace: workspace.data,
    caller: { host: "pi", actor: ctx.sessionManager.getSessionId() },
    paths: writePaths(event.toolName, event.input),
    store,
  });
  return result.ok ? undefined : { block: true, reason: result.error };
};
