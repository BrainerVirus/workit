import {
  failure,
  approvedExternalAction,
  externalActionState,
  priorExternalAction,
  externalActionDescriptor,
  externalActionHelp,
  externalActionRequest,
  externalActionRef,
  createAuthorizedExternalActionRunner,
  matchesNativeExternalAction,
  nativeExternalActionObservation,
  boundedOperationJsonSchema,
  OPERATION_SCHEMA_DEPTH,
  OPERATION_FAMILIES,
  parseOperation,
  success,
  canonicalJson,
  TaskStore,
  WorkitCore,
  type OperationFamily,
  type NativeActionVerification,
  type NativeDecisionVerification,
  type NativeAuthorityVerifier,
  type NativeReconciliationVerification,
  type ContractResult as Result,
} from "@brainervirus/workit-core/src/core";
import {
  approvedResolvedExternalAction,
  executeResolvedExternalAction,
  readExternalAction,
  resolveExternalActionRequest,
} from "@brainervirus/workit-core/src/core/external-action-effects";
import type { Provenance } from "@brainervirus/workit-core/src/core/task-contract";
import { assertProductWriteAllowed } from "@brainervirus/workit-core/src/core/workers";
import type {
  ExtensionContext,
  AgentToolResult,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { piContext } from "./context";

const readOnlyActions = new Set(["list", "inspect", "preview", "explain", "export"]);
const decisionReceipt = (actor: string, callId: string, approved: boolean) => ({
  actor,
  callId,
  approved,
});
type PiDecisionObservation = { actor: string; approved: boolean; callId: string };
const readDecisionObservation = (value: unknown): PiDecisionObservation | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.actor === "string" &&
    typeof candidate.approved === "boolean" &&
    typeof candidate.callId === "string"
    ? { actor: candidate.actor, approved: candidate.approved, callId: candidate.callId }
    : null;
};

const output = (result: Result<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
});
type PiToolResult = AgentToolResult<Result<unknown>>;

const nativeAuthority = (
  actor: string,
  reconciliationTokens = new WeakSet<object>(),
): NativeAuthorityVerifier => ({
  verifyDecision: ({
    observation,
    expected,
    caller,
  }: NativeDecisionVerification): Result<Provenance> => {
    const receipt = readDecisionObservation(observation);
    if (
      !receipt ||
      caller.host !== "pi" ||
      caller.actor !== actor ||
      receipt.actor !== actor ||
      receipt.approved !== (expected.response === "approved")
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
      receipts: [{ kind: "host", host: "pi", handle: `decision:${receipt.callId}` }],
    });
  },
  verifyAction: ({ observation, expected, caller }: NativeActionVerification) => {
    if (
      caller.host !== "pi" ||
      caller.actor !== actor ||
      !matchesNativeExternalAction(observation, {
        actor,
        actionRef: expected.actionRef,
        outcome: expected.outcome,
        ...(expected.outcome === "reserve"
          ? {}
          : { taskRevision: expected.taskRevision, workspaceRevision: expected.workspaceRevision }),
      })
    )
      return failure(
        "permission_denied",
        "native Pi action observation is not bound to this session",
      );
    return success(null, null, {
      kind: "host_observed",
      host: "pi",
      session: { kind: "host", host: "pi", handle: actor },
      workerId: null,
      receipts: [
        {
          kind: "host",
          host: "pi",
          handle: `action:${expected.actionRef.kind === "host" ? expected.actionRef.handle : "external-action"}`,
        },
      ],
    });
  },
  verifyReconciliation: ({ observation, expected, caller }: NativeReconciliationVerification) => {
    const value = observation as Record<string, unknown>;
    if (
      typeof observation !== "object" ||
      observation === null ||
      caller.host !== "pi" ||
      caller.actor !== actor ||
      !reconciliationTokens.has(observation) ||
      value.kind !== "provider_read" ||
      value.outcome !== "succeeded" ||
      value.evidenceDigest !== expected.evidenceDigest ||
      (expected.step !== undefined && value.step !== expected.step) ||
      canonicalJson(value.actionRef) !== canonicalJson(expected.actionRef)
    )
      return failure("permission_denied", "native hosting reconciliation is not attested");
    return success(null, null, {
      kind: "host_observed",
      host: "pi",
      session: { kind: "host", host: "pi", handle: actor },
      workerId: null,
      receipts: [{ kind: "host", host: "pi", handle: `reconcile:${expected.evidenceDigest}` }],
    });
  },
});

export const nativeExternalActionRunner = (
  root: string,
  actor: string,
  core: WorkitCore,
  step?: string,
) =>
  createAuthorizedExternalActionRunner(core, (operation) => {
    const store = new TaskStore(root);
    const selected = approvedExternalAction(store, "pi", actor, operation);
    if (!selected.ok) return selected;
    const actionRef = externalActionRef("pi", actor, operation);
    return {
      taskId: selected.data.task.id,
      decisionId: selected.data.entry.id,
      actionRef,
      expectedRevision: selected.data.task.revision,
      expectedWorkspaceRevision: selected.data.workspace.revision,
      binding: selected.data.entry.data.binding,
      ...(step ? { step } : {}),
      refresh: () => {
        const task = store.readTask(selected.data.task.id);
        const workspace = store.readWorkspace();
        if (!task.ok || !workspace.ok || !workspace.data)
          throw new Error("external action state changed");
        return {
          expectedRevision: task.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
        };
      },
      reserveObservation: nativeExternalActionObservation(actor, actionRef, "reserve"),
      settleObservation: (outcome: "succeeded" | "not_started" | "unknown", revisions) =>
        nativeExternalActionObservation(
          actor,
          actionRef,
          outcome,
          actionRef.kind === "host" ? actionRef.handle : "external-action",
          revisions,
        ),
    };
  });

const schemaFor = (family: OperationFamily) =>
  ({ type: "object", ...boundedOperationJsonSchema(family, OPERATION_SCHEMA_DEPTH, true) }) as any;

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

const trustedForMutation = (ctx: ExtensionContext, action: unknown): Result<null> => {  if (ctx.isProjectTrusted() || readOnlyActions.has(String(action)))
    return success(null, null, null);
  return failure("permission_denied", "Pi project is not trusted for Workit mutations");
};

const executeFamily = async (
  family: OperationFamily,
  toolCallId: string,
  input: unknown,
  ctx: ExtensionContext,
): Promise<PiToolResult> => {
  // Pi may deliver structured params as JSON strings (host transport quirk).
  // Strict input wins; a decoded retry only rescues stringified payloads, and
  // the original failure stands when decoding changes nothing.
  const parsedStrict = parseOperation(family, input);
  const parsed = parsedStrict.ok ? parsedStrict : parseOperation(family, decodeStrings(input));
  if (!parsed.ok) return output(parsedStrict);
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

export const registerWorkitTools = (
  pi: { registerTool(tool: ToolDefinition): void },
  options: { allowExternalActions?: boolean } = {},
): void => {
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
  if (options.allowExternalActions === false) return;
  pi.registerTool({
    name: "workit_external_action",
    label: "workit_external_action",
    description: externalActionHelp,
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "git.branch_setup",
            "git.commit",
            "git.push",
            "hosting.pull_request",
            "youtrack.update",
            "youtrack.time",
            "youtrack.meeting",
            "changelog.apply",
            "context.read",
          ],
        },
        payload: { type: "object", additionalProperties: true },
      },
      required: ["operation", "payload"],
      additionalProperties: false,
    },
    async execute(toolCallId, input, _signal, _onUpdate, ctx) {
      const parsed = externalActionRequest(input);
      if (!parsed.ok) return output(parsed);
      const context = piContext(ctx);
      const resolved = resolveExternalActionRequest(ctx.cwd, parsed.data);
      if (!resolved.ok) return output(resolved);
      if (resolved.data.request.operation === "context.read")
        return output(await executeResolvedExternalAction(resolved.data, ctx.cwd));
      if (!ctx.isProjectTrusted())
        return output(
          failure("permission_denied", "Pi project is not trusted for external actions"),
        );
      if (context.workerId !== null)
        return output(
          failure("permission_denied", "supervised Pi children cannot run external actions"),
        );
      if (!ctx.hasUI)
        return output(
          failure("needs_input", "interactive confirmation UI is unavailable", {
            capability: "interactive_decision",
          }),
        );
      const actor = context.caller.actor;
      const store = new TaskStore(ctx.cwd);
      const reconciliationTokens = new WeakSet<object>();
      const core = new WorkitCore(store, {
        ...context,
        nativeAuthority: nativeAuthority(actor, reconciliationTokens),
      });
      const descriptor = externalActionDescriptor(
        resolved.data.request.operation,
        resolved.data.descriptorPayload,
      );
      const priorRequest = priorExternalAction(
        store,
        "pi",
        actor,
        resolved.data.request.operation,
        resolved.data.request.payload,
      );
      if (priorRequest.ok && priorRequest.data.entry.data.consumption?.state === "uncertain") {
        const original = approvedResolvedExternalAction(
          priorRequest.data.entry.data.binding.approvedContent,
        );
        if (original.ok) {
          const actionRef = priorRequest.data.entry.data.consumption.actionRef;
          const evidence = await readExternalAction(ctx.cwd, original.data, actionRef);
          const freshTask = store.readTask(priorRequest.data.task.id);
          const freshWorkspace = store.readWorkspace();
          if (
            evidence.ok &&
            evidence.data.outcome === "succeeded" &&
            freshTask.ok &&
            freshWorkspace.ok &&
            freshWorkspace.data
          ) {
            reconciliationTokens.add(evidence.data.observation);
            const reconciled = core.reconcileAction({
              taskId: priorRequest.data.task.id,
              decisionId: priorRequest.data.entry.id,
              actionRef,
              expectedRevision: freshTask.data.revision,
              expectedWorkspaceRevision: freshWorkspace.data.revision,
              outcome: "succeeded",
              evidenceDigest: evidence.data.evidenceDigest,
              ...(evidence.data.step ? { step: evidence.data.step } : {}),
              observation: evidence.data.observation,
            });
            if (reconciled.ok) {
              if (evidence.data.step === "comment") {
                const remaining = await nativeExternalActionRunner(
                  ctx.cwd,
                  actor,
                  core,
                  "time",
                )(priorRequest.data.entry.data.binding.approvedContent, () =>
                  executeResolvedExternalAction(original.data, ctx.cwd, "time", {
                    host: "pi",
                    actor,
                  }),
                );
                return output(remaining);
              }
              return output(reconciled);
            }
          }
        }
        return output(
          failure("external_outcome_unknown", "previous external action outcome is unknown"),
        );
      }
      if (priorRequest.ok && priorRequest.data.entry.data.consumption !== null)
        return output(failure("permission_denied", "external action was already settled"));
      const existing = approvedExternalAction(store, "pi", actor, descriptor);
      if (!existing.ok) {
        const prior = externalActionState(store, "pi", actor, descriptor);
        if (prior.ok && prior.data.entry.data.consumption !== null)
          return output(failure("permission_denied", "external action was already settled"));
        const listed = store.listTasks();
        const workspace = store.readWorkspace();
        if (!listed.ok || !workspace.ok || !workspace.data)
          return output(failure("storage_error", "external action state is unavailable"));
        const candidates = listed.data.filter(
          (task) =>
            task.status === "active" &&
            task.workspaceId === workspace.data!.id &&
            task.intent.provenance.session?.kind === "host" &&
            task.intent.provenance.session.host === "pi" &&
            task.intent.provenance.session.handle === actor,
        );
        if (candidates.length !== 1)
          return output(
            failure("permission_denied", "external action requires exactly one active Pi task"),
          );
        const task = candidates[0];
        const approved = await ctx.ui.confirm("Workit external action", descriptor);
        if (!approved)
          return output(failure("permission_denied", "external action was not approved"));
        const currentWorkspace = store.readWorkspace();
        if (!currentWorkspace.ok || !currentWorkspace.data)
          return output(failure("storage_error", "workspace state is unavailable"));
        const decision = core.observeDecision(
          {
            schemaVersion: 1,
            action: "record",
            taskId: task.id,
            expectedRevision: task.revision,
            purpose: "action",
            binding: {
              taskId: task.id,
              workspaceId: currentWorkspace.data.id,
              scope: task.intent.data.scope,
              presented: `Approve ${descriptor}`,
              approvedContent: descriptor,
              contentRefs: [],
            },
            response: "approved",
            requirementIds: [],
          },
          decisionReceipt(actor, toolCallId, true),
        );
        if (!decision.ok) return output(decision);
      }
      const result = await nativeExternalActionRunner(
        ctx.cwd,
        actor,
        core,
      )(descriptor, (step) =>
        executeResolvedExternalAction(resolved.data, ctx.cwd, step, { host: "pi", actor }),
      );
      return output(result);
    },
  });
};

const writePaths = (toolName: string, input: Record<string, unknown>): string[] =>
  toolName === "write" || toolName === "edit" ? [String(input.path ?? input.filePath ?? "")] : [];

export const enforceNativeWriter = (
  event: ToolCallEvent,
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
