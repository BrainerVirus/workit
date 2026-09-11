import {
  canonicalJson,
  failure,
  success,
  type Id,
  type Ref,
  type Result,
  type Revision,
  type Decision,
  refSchema,
  sha256,
} from "./task-contract";
import { WorkitCore } from "./task-engine";
import { TaskStore } from "./task-store";
import * as z from "zod";

export type AuthorizedActionInput = {
  core: WorkitCore;
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  binding?: Decision["binding"];
  reserveObservation: unknown;
  settleObservation: (
    outcome: "succeeded" | "not_started" | "unknown",
    revisions?: { taskRevision: Revision; workspaceRevision: Revision },
  ) => unknown;
  refresh?: () => Pick<AuthorizedActionInput, "expectedRevision" | "expectedWorkspaceRevision">;
  step?: string;
  capability?: string;
  available?: boolean;
  failureOutcome?: "not_started" | "unknown";
};

export type ExternalActionResult<T> = Result<T>;

const externalActionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("git.branch_setup"),
      payload: z
        .object({
          action: z.enum(["setup", "reapply_stash"]).optional(),
          sdd_dir: z.string().optional(),
          target_branch: z.string().optional(),
          stash: z.enum(["yes", "no"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("git.commit"),
      payload: z.object({ message: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("git.push"),
      payload: z.object({ branch: z.string().min(1).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("hosting.pull_request"),
      payload: z
        .object({
          title: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional(),
          target_branch: z.string().optional(),
          babysit: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.update"),
      payload: z
        .object({
          issueId: z.string().min(1),
          markdown: z.string().min(1),
          minutes: z.number().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.time"),
      payload: z
        .object({
          issueId: z.string().min(1),
          minutes: z.number().positive(),
          text: z.string().optional(),
          dateMs: z.number().finite().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.meeting"),
      payload: z
        .object({
          issueId: z.string().min(1),
          minutes: z.number().positive(),
          text: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("changelog.apply"),
      payload: z
        .object({
          entries: z
            .union([
              z.record(z.string(), z.array(z.string())),
              z.array(z.object({ category: z.string().min(1), text: z.string().min(1) }).strict()),
            ])
            .optional(),
          path: z.string().optional(),
          normalize_only: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("context.read"),
      payload: z
        .object({
          kind: z.enum(["git", "pr", "youtrack", "github_issue", "changelog", "release", "affected"]),
          range: z.string().optional(),
          issueId: z.string().optional(),
          issueUrl: z.string().optional(),
          issueRef: z.string().optional(),
          mode: z.string().optional(),
          specPath: z.string().optional(),
          planPath: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ExternalActionRequest = z.infer<typeof externalActionSchema>;

export type ExternalActionOperation = ExternalActionRequest["operation"];

export const externalActionRequest = (value: unknown): Result<ExternalActionRequest> => {
  const parsed = externalActionSchema.safeParse(value);
  return parsed.success
    ? success(null, null, parsed.data)
    : failure("invalid_input", "external action payload is invalid", {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          reason: issue.message,
        })),
      });
};
export type ExternalActionRunner = <T>(
  input: Omit<AuthorizedActionInput, "core">,
  effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
) => Promise<ExternalActionResult<T>>;
export type ExternalActionEffect = <T>(
  operation: string,
  effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
) => Promise<ExternalActionResult<T>>;
export type ExternalActionBinding = (
  operation: string,
) => Omit<AuthorizedActionInput, "core"> | ExternalActionResult<never>;

/**
 * Host adapters use this exact, canonical string as the native approval
 * binding. It deliberately includes the concrete target/payload so an
 * approved sentence cannot authorize a different effect by substring.
 */
export const externalActionDescriptor = (operation: string, payload: unknown): string =>
  canonicalJson({
    operation,
    payload,
    ...(payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "resolved" in payload &&
    payload.resolved &&
    typeof payload.resolved === "object" &&
    Array.isArray((payload.resolved as { steps?: unknown }).steps)
      ? { steps: (payload.resolved as { steps: string[] }).steps }
      : {}),
  });

/** Compact host-facing help for the fixed optional-action surface. */
export const externalActionHelp =
  "Fixed actions: git.branch_setup {action?,sdd_dir?,target_branch?,stash?}; git.commit {message}; git.push {branch?}; hosting.pull_request {title,body?,draft?,target_branch?,babysit?}; youtrack.update {issueId,markdown,minutes?}; youtrack.time {issueId,minutes,text?,dateMs?}; youtrack.meeting {issueId,minutes,text}; changelog.apply {entries?,path?,normalize_only?}; context.read {kind,range?,issueId?,issueUrl?,issueRef?,mode?,specPath?,planPath?}. context.read is read-only and needs no approval; all other operations require native approval (CLI uses a TTY; caller-unattested MCP cannot mutate).";

export const externalActionRef = (
  host: "opencode" | "pi" | "workit_cli",
  actor: string,
  descriptor: string,
): Ref => ({
  kind: "host",
  host,
  handle: `external:${sha256({ actor, descriptor }).slice(0, 32)}`,
});

export const externalActionState = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
) => {
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const candidates = listed.data.flatMap((task) => {
    if (
      task.status !== "active" ||
      task.workspaceId !== workspace.data!.id ||
      task.intent.provenance.session?.kind !== "host" ||
      task.intent.provenance.session.host !== host ||
      task.intent.provenance.session.handle !== actor
    )
      return [];
    return task.decisions
      .filter(
        (entry) =>
          entry.data.purpose === "action" &&
          entry.data.response === "approved" &&
          entry.data.revoked === null &&
          entry.data.binding.approvedContent === operation,
      )
      .map((entry) => ({ task, entry }));
  });
  if (candidates.length !== 1)
    return failure(
      "permission_denied",
      candidates.length === 0
        ? "no approved action is bound to this session"
        : "multiple approved actions match this session",
    );
  return success(workspace.data.revision, null, { ...candidates[0], workspace: workspace.data });
};

/** Find a prior decision for the same user-requested operation/payload even when its resolved target drifted. */
export const priorExternalAction = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
  payload: unknown,
) => {
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const candidates = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions
      .filter((entry) => {
        if (
          entry.data.purpose !== "action" ||
          entry.data.response !== "approved" ||
          entry.data.revoked !== null
        )
          return false;
        try {
          const descriptor = JSON.parse(entry.data.binding.approvedContent) as {
            operation?: unknown;
            payload?: Record<string, unknown>;
          };
          if (
            descriptor.operation !== operation ||
            !descriptor.payload ||
            typeof descriptor.payload !== "object"
          )
            return false;
          const storedPayload = { ...descriptor.payload };
          delete storedPayload.resolved;
          return canonicalJson(storedPayload) === canonicalJson(payload);
        } catch {
          return false;
        }
      })
      .map((entry) => ({ task, entry }));
  });
  if (candidates.length !== 1)
    return failure(
      "permission_denied",
      candidates.length === 0
        ? "no prior external action matches this request"
        : "multiple prior external actions match this request",
    );
  return success(workspace.data.revision, null, { ...candidates[0], workspace: workspace.data });
};

export const approvedExternalAction = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
) => {
  const selected = externalActionState(store, host, actor, operation);
  if (!selected.ok) return selected;
  if (selected.data.entry.data.consumption !== null)
    return failure(
      selected.data.entry.data.consumption.state === "uncertain"
        ? "external_outcome_unknown"
        : "permission_denied",
      selected.data.entry.data.consumption.state === "uncertain"
        ? "previous external action outcome is unknown"
        : "external action was already settled",
    );
  return selected;
};

export const createAuthorizedExternalActionRunner =
  (core: WorkitCore, bind: ExternalActionBinding): ExternalActionEffect =>
  async <T>(
    operation: string,
    effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
  ) => {
    let steps: string[] = [];
    try {
      const parsed = JSON.parse(operation) as { steps?: unknown };
      if (Array.isArray(parsed.steps) && parsed.steps.every((step) => typeof step === "string"))
        steps = parsed.steps;
    } catch {
      /* non-descriptor callers remain one-shot */
    }
    const sequence = steps.length ? steps : [undefined];
    let latest: ExternalActionResult<T> | undefined;
    for (const step of sequence) {
      const binding = bind(operation);
      if ("ok" in binding) return binding as ExternalActionResult<T>;
      const result = await runAuthorizedExternalAction(
        { core, ...(binding as Omit<AuthorizedActionInput, "core">), ...(step ? { step } : {}) },
        () => effect(step),
      );
      latest = result;
      if (!result.ok) return result;
    }
    return latest ?? failure("recovery_required", "external action did not execute");
  };

export type NativeExternalActionObservation = {
  actor: string;
  actionRef: Ref;
  outcome: "reserve" | "succeeded" | "not_started" | "unknown";
  callId?: string;
  taskRevision?: Revision;
  workspaceRevision?: Revision;
};

export const nativeExternalActionObservation = (
  actor: string,
  actionRef: Ref,
  outcome: NativeExternalActionObservation["outcome"],
  callId = actionRef.kind === "host" ? actionRef.handle : "external-action",
  revisions?: { taskRevision: Revision; workspaceRevision: Revision },
): NativeExternalActionObservation =>
  revisions
    ? { actor, actionRef, outcome, callId, ...revisions }
    : { actor, actionRef, outcome, callId };

export const readNativeExternalActionObservation = (
  value: unknown,
): NativeExternalActionObservation | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.actor !== "string" ||
    !refSchema.safeParse(candidate.actionRef).success ||
    !["reserve", "succeeded", "not_started", "unknown"].includes(String(candidate.outcome)) ||
    (candidate.callId !== undefined && typeof candidate.callId !== "string") ||
    (candidate.taskRevision !== undefined && typeof candidate.taskRevision !== "string") ||
    (candidate.workspaceRevision !== undefined && typeof candidate.workspaceRevision !== "string")
  )
    return null;
  return {
    actor: candidate.actor,
    actionRef: candidate.actionRef as Ref,
    outcome: candidate.outcome as NativeExternalActionObservation["outcome"],
    ...(candidate.callId === undefined ? {} : { callId: candidate.callId }),
    ...(candidate.taskRevision === undefined
      ? {}
      : { taskRevision: candidate.taskRevision as Revision }),
    ...(candidate.workspaceRevision === undefined
      ? {}
      : { workspaceRevision: candidate.workspaceRevision as Revision }),
  };
};

export const matchesNativeExternalAction = (
  value: unknown,
  expected: {
    actor: string;
    actionRef: Ref;
    outcome: NativeExternalActionObservation["outcome"];
    taskRevision?: Revision;
    workspaceRevision?: Revision;
  },
): boolean => {
  const observation = readNativeExternalActionObservation(value);
  return (
    observation !== null &&
    observation.actor === expected.actor &&
    observation.outcome === expected.outcome &&
    (expected.taskRevision === undefined || observation.taskRevision === expected.taskRevision) &&
    (expected.workspaceRevision === undefined ||
      observation.workspaceRevision === expected.workspaceRevision) &&
    canonicalJson(observation.actionRef) === canonicalJson(expected.actionRef)
  );
};

/**
 * Run one concrete, already-authorized external effect through the core's
 * one-time reservation and settlement transitions. The adapter supplies the
 * host-observed action evidence; this helper never turns an arbitrary payload
 * into an external effect and never retries an uncertain outcome.
 */
export async function runAuthorizedExternalAction<T>(
  input: AuthorizedActionInput,
  effect: () => T | Result<T> | Promise<T | Result<T>>,
): Promise<ExternalActionResult<T>> {
  if (input.core.isDelegatedCaller())
    return failure("permission_denied", "delegated workers cannot run external actions");
  if (input.available === false)
    return failure(
      "capability_unavailable",
      `${input.capability ?? "external action"} is unavailable`,
      { capability: input.capability ?? "external_action" },
    );

  const reserved = input.core.reserveAction({
    taskId: input.taskId,
    decisionId: input.decisionId,
    actionRef: input.actionRef,
    expectedRevision: input.expectedRevision,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.step ? { step: input.step } : {}),
    observation: input.reserveObservation,
  });
  if (!reserved.ok) return reserved as ExternalActionResult<T>;

  const settle = (
    outcome: "succeeded" | "not_started" | "unknown",
    refreshed = false,
  ): ExternalActionResult<unknown> => {
    try {
      const revisions =
        refreshed && input.refresh
          ? input.refresh()
          : {
              expectedRevision: reserved.data.taskRevision,
              expectedWorkspaceRevision: reserved.data.workspaceRevision,
            };
      return input.core.settleAction({
        ...reserved.data,
        taskRevision: revisions.expectedRevision,
        workspaceRevision: revisions.expectedWorkspaceRevision,
        outcome,
        ...(input.step ? { step: input.step } : {}),
        observation: input.settleObservation(outcome, {
          taskRevision: revisions.expectedRevision,
          workspaceRevision: revisions.expectedWorkspaceRevision,
        }),
      });
    } catch {
      return failure("external_outcome_unknown", "external action settlement is unavailable", {
        operation: "external_action",
        outcome: "unknown",
      });
    }
  };
  const settleWithRefresh = (
    outcome: "succeeded" | "not_started" | "unknown",
    first: ExternalActionResult<unknown>,
  ): ExternalActionResult<unknown> =>
    !first.ok && first.code === "revision_conflict" && input.refresh
      ? settle(outcome, true)
      : first;

  let effectValue: T | Result<T>;
  try {
    effectValue = await effect();
  } catch {
    const settled = settleWithRefresh("unknown", settle("unknown"));
    if (!settled.ok) return settled as ExternalActionResult<T>;
    return failure("external_outcome_unknown", "external action outcome is unknown", {
      operation: "external_action",
      outcome: "unknown",
    });
  }
  if (
    typeof effectValue === "object" &&
    effectValue !== null &&
    "ok" in effectValue &&
    typeof (effectValue as { ok?: unknown }).ok === "boolean"
  ) {
    const contract = effectValue as Result<T>;
    if (!contract.ok) {
      const preflight =
        typeof contract.details === "object" &&
        contract.details !== null &&
        (contract.details as Record<string, unknown>).outcome === "not_started";
      const outcome = input.failureOutcome ?? (preflight ? "not_started" : "unknown");
      const settled = settleWithRefresh(outcome, settle(outcome));
      if (!settled.ok && outcome === "unknown") return settled as ExternalActionResult<T>;
      return contract;
    }
    effectValue = contract.data;
  }
  const settled = settleWithRefresh("succeeded", settle("succeeded"));
  if (!settled.ok) return settled as ExternalActionResult<T>;
  return {
    ok: true,
    schemaVersion: 1,
    revision: settled.revision,
    workspaceRevision: settled.workspaceRevision,
    data: effectValue as T,
  };
}
