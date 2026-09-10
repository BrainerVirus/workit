import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  OPERATION_FAMILIES,
  approvedExternalAction,
  externalActionState,
  priorExternalAction,
  externalActionDescriptor,
  externalActionRequest,
  externalActionRef,
  nativeExternalActionObservation,
  createAuthorizedExternalActionRunner,
  TaskStore,
  WorkitCore,
  compactTaskContext,
  failure,
  success,
  type Capability,
  type Caller,
  type Constraint,
  type OperationFamily,
  type OperationContext,
} from "@brainervirus/workit-core/src/core";
import {
  approvedResolvedExternalAction,
  executeResolvedExternalAction,
  readExternalAction,
  resolveExternalActionRequest,
} from "@brainervirus/workit-core/src/core/external-action-effects";
import type {
  NativeAuthorityVerifier,
  NativeReconciliationVerification,
} from "@brainervirus/workit-core/src/core/authority";
import type { Provenance } from "@brainervirus/workit-core/src/core/task-contract";
import { canonicalJson, type Result } from "@brainervirus/workit-core/src/core/task-contract";

export const TASK_FAMILIES = OPERATION_FAMILIES;
export const TASK_ACTIONS = {
  task: ["start", "list", "inspect", "revise", "progress", "pause", "resume", "close"],
  policy: ["assess", "preview", "explain"],
  evidence: ["record"],
  finding: ["record", "resolve"],
  decision: ["record", "revoke"],
  worker: ["assign", "report", "cancel"],
  writer: ["acquire", "release"],
  state: ["export", "import", "recover"],
} as const satisfies Record<OperationFamily, readonly string[]>;

type Stream = { write: (chunk: string) => void };
type JsonInput = string | AsyncIterable<string | Uint8Array>;

export type TaskCliDeps = {
  cwd?: string;
  root?: string;
  actor?: string;
  caller?: Caller;
  capabilities?: Capability[];
  constraints?: Constraint[];
  now?: OperationContext["now"];
  nativeRecovery?: OperationContext["nativeRecovery"];
  stdinIsTTY?: () => boolean;
  confirm?: () => Promise<boolean>;
  afterExport?: () => void;
  stdin?: JsonInput;
  out?: Stream;
  err?: Stream;
};

type Parsed = {
  family: OperationFamily;
  action: string;
  request: Record<string, unknown>;
  json: boolean;
  confirmed: boolean;
  observedConfirmation: boolean;
  handoff: boolean;
  taskId?: string;
};

type ParseResult =
  | { ok: true; parsed: Parsed }
  | { ok: false; result: Result<never>; json: boolean; usage?: string };

const outOf = (deps: TaskCliDeps) => deps.out ?? process.stdout;
const errOf = (deps: TaskCliDeps) => deps.err ?? process.stderr;
const write = (stream: Stream, value: string) =>
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
const jsonResult = (stream: Stream, result: Result<unknown>) =>
  write(stream, JSON.stringify(result));

const usage = (message: string): Result<never> => failure("invalid_input", message);
const parseUsage = (message: string, json: boolean): ParseResult => ({
  ok: false,
  result: usage(message),
  json,
  usage: message,
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return Object.is(left, right);
  }
};

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

async function readInput(input: JsonInput): Promise<string> {
  if (typeof input === "string") return input;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = "";
  for await (const chunk of input)
    value += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  value += decoder.decode();
  return value;
}

async function payloadValue(
  raw: string | undefined,
  deps: TaskCliDeps,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: Result<never> }> {
  if (raw === undefined) return { ok: true, value: {} };
  let source: string;
  try {
    source =
      raw === "-"
        ? await readInput(deps.stdin ?? process.stdin)
        : raw.startsWith("@")
          ? decodeUtf8(readFileSync(raw.slice(1)))
          : raw;
  } catch (error) {
    return {
      ok: false,
      result: failure("invalid_input", `unable to read payload: ${String(error)}`),
    };
  }
  try {
    const value = JSON.parse(source) as unknown;
    return isObject(value)
      ? { ok: true, value }
      : { ok: false, result: failure("invalid_input", "payload must be a JSON object") };
  } catch (error) {
    return {
      ok: false,
      result: failure("invalid_input", `payload JSON is invalid: ${String(error)}`),
    };
  }
}

const familyHas = (family: OperationFamily, action: string): boolean =>
  (TASK_ACTIONS[family] as readonly string[]).includes(action);

function inject(request: Record<string, unknown>, key: string, value: unknown): Result<null> {
  if (key in request && !same(request[key], value))
    return failure("invalid_input", `payload ${key} conflicts with the explicit flag`, {
      fields: [{ path: key, reason: "explicit flag conflicts with payload" }],
    });
  request[key] = value;
  return success(null, null, null);
}

async function parseTaskArgs(argv: string[], deps: TaskCliDeps): Promise<ParseResult> {
  const jsonRequested = argv.includes("--json");
  const familyName = argv[0];
  if (familyName === "handoff") return parseHandoffArgs(argv.slice(1), deps);
  if (!familyName || !(TASK_FAMILIES as readonly string[]).includes(familyName))
    return parseUsage(`unknown operation family: ${familyName ?? ""}`, jsonRequested);
  const family = familyName as OperationFamily;
  const actionName = argv[1];
  const action = actionName?.replace(/-/g, "_");
  if (!action || !familyHas(family, action))
    return parseUsage(`unknown action for ${family}: ${actionName ?? ""}`, jsonRequested);

  let payload: string | undefined;
  let taskId: string | undefined;
  let revision: string | undefined;
  let workspaceRevision: string | null | undefined;
  let view: string | undefined;
  let json = jsonRequested;
  let confirmed = false;
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json" || token === "--confirm") {
      if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
      seen.add(token);
      if (token === "--json") json = true;
      else confirmed = true;
      continue;
    }
    if (!["--payload", "--task", "--revision", "--workspace-revision", "--view"].includes(token))
      return parseUsage(`unknown argument: ${token}`, json);
    const value = argv[++i];
    if (value === undefined || (value.trim() === "" && token !== "--workspace-revision"))
      return parseUsage(`${token} requires a value`, json);
    if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
    seen.add(token);
    if (token === "--payload") payload = value;
    else if (token === "--task") taskId = value;
    else if (token === "--revision") revision = value;
    else if (token === "--workspace-revision") workspaceRevision = value === "null" ? null : value;
    else view = value;
  }
  const loaded = await payloadValue(payload, deps);
  if (!loaded.ok) return { ok: false, result: loaded.result, json };
  const request = loaded.value;
  if (!("schemaVersion" in request)) request.schemaVersion = 1;
  for (const [key, value] of [
    ["action", action],
    ...(taskId === undefined ? [] : [["taskId", taskId] as const]),
    ...(revision === undefined ? [] : [["expectedRevision", revision] as const]),
    ...(workspaceRevision === undefined
      ? []
      : [["expectedWorkspaceRevision", workspaceRevision] as const]),
    ...(view === undefined ? [] : [["view", view] as const]),
  ] as const) {
    const checked = inject(request, key, value);
    if (!checked.ok) return { ok: false, result: checked, json };
  }
  return {
    ok: true,
    parsed: {
      family,
      action,
      request,
      json,
      confirmed,
      observedConfirmation: false,
      handoff: false,
    },
  };
}

async function parseHandoffArgs(argv: string[], deps: TaskCliDeps): Promise<ParseResult> {
  let taskId: string | undefined;
  let json = argv.includes("--json");
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
      seen.add(token);
      json = true;
      continue;
    }
    if (token !== "--task") return parseUsage(`unknown argument: ${token}`, json);
    if (taskId !== undefined || argv[i + 1] === undefined || argv[i + 1].trim() === "")
      return parseUsage("--task requires one non-empty value", json);
    if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
    seen.add(token);
    taskId = argv[++i];
  }
  if (!taskId) return parseUsage("handoff requires --task <id>", json);
  void deps;
  return {
    ok: true,
    parsed: {
      family: "state",
      action: "export",
      request: { schemaVersion: 1, action: "export", taskId },
      json,
      confirmed: false,
      observedConfirmation: false,
      handoff: true,
      taskId,
    },
  };
}

const dispatch = (core: WorkitCore, family: OperationFamily, request: unknown): Result<unknown> => {
  switch (family) {
    case "task":
      return core.task(request);
    case "policy":
      return core.policy(request);
    case "evidence":
      return core.evidence(request);
    case "finding":
      return core.finding(request);
    case "decision":
      return core.decision(request);
    case "worker":
      return core.worker(request);
    case "writer":
      return core.writer(request);
    case "state":
      return core.state(request);
  }
};

const contextFor = (
  root: string,
  deps: TaskCliDeps,
  provenanceKind: OperationContext["provenanceKind"] = "agent_reported",
): OperationContext => ({
  root,
  caller: deps.caller ?? { host: "workit_cli", actor: deps.actor ?? "cli" },
  provenanceKind,
  capabilities: deps.capabilities ?? [],
  constraints: deps.constraints ?? [],
  now: deps.now ?? (() => new Date().toISOString()),
  nativeRecovery: deps.nativeRecovery,
});

const CONSENT_ACTIONS = new Set([
  "task.pause",
  "task.resume",
  "task.close",
  "worker.cancel",
  "writer.acquire",
  "writer.release",
  "state.import",
  "state.recover",
]);

const needsConsent = (parsed: Parsed): boolean =>
  CONSENT_ACTIONS.has(`${parsed.family}.${parsed.action}`);

async function observeConsent(
  deps: TaskCliDeps,
): Promise<{ accepted: boolean; observed: boolean }> {
  const tty = deps.stdinIsTTY ? deps.stdinIsTTY() : process.stdin.isTTY === true;
  if (!tty) return { accepted: false, observed: false };
  if (deps.confirm) return { accepted: await deps.confirm(), observed: true };
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Proceed? [y/N] ");
    return { accepted: /^y(es)?$/i.test(answer.trim()), observed: true };
  } finally {
    prompt.close();
  }
}

function printHuman(result: Result<unknown>, deps: TaskCliDeps, handoff = false): void {
  const stream = result.ok ? outOf(deps) : errOf(deps);
  if (!result.ok) {
    write(stream, `${result.code}: ${result.error}`);
    for (const field of result.details.fields ?? [])
      write(stream, `  ${field.path}: ${field.reason}`);
    return;
  }
  const data = result.data as any;
  if (handoff && data?.bundle && data?.context) {
    write(stream, "Task export");
    write(stream, JSON.stringify(data.bundle, null, 2));
    write(stream, "Destination context");
    write(stream, JSON.stringify(data.context, null, 2));
    return;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row && typeof row === "object" && "id" in row && "status" in row)
      write(stream, `${row.id} ${row.status}${row.objective ? ` — ${row.objective}` : ""}`);
    else write(stream, JSON.stringify(row, null, 2));
    for (const gap of row?.requirements?.filter((item: any) => item.status !== "satisfied") ?? [])
      write(stream, `policy gap: ${gap.reason}`);
  }
}

export async function runTaskCommand(argv: string[], deps: TaskCliDeps = {}): Promise<number> {
  const parsed = await parseTaskArgs(argv, deps);
  if (!parsed.ok) {
    if (parsed.json) jsonResult(outOf(deps), parsed.result);
    else
      write(
        errOf(deps),
        parsed.usage ?? (parsed.result.ok ? "invalid input" : parsed.result.error),
      );
    return parsed.usage ? 2 : 1;
  }
  const root = deps.root ?? process.env.WORKFLOW_WORKSPACE_ROOT ?? deps.cwd ?? process.cwd();
  let observedConfirmation = parsed.parsed.observedConfirmation;
  if (needsConsent(parsed.parsed) && !parsed.parsed.confirmed) {
    const consent = await observeConsent(deps);
    if (!consent.accepted) {
      const result = failure("needs_input", "explicit consent is required for this operation", {
        operation: `${parsed.parsed.family}.${parsed.parsed.action}`,
      });
      if (parsed.parsed.json) jsonResult(outOf(deps), result);
      else printHuman(result, deps);
      return 1;
    }
    observedConfirmation = consent.observed;
  }
  const core = new WorkitCore(
    new TaskStore(root),
    contextFor(root, deps, observedConfirmation ? "host_observed" : "agent_reported"),
  );
  let result: Result<unknown>;
  if (parsed.parsed.handoff) {
    const exported = dispatch(core, "state", parsed.parsed.request);
    if (!exported.ok) result = exported;
    else {
      deps.afterExport?.();
      const viewed = dispatch(core, "task", {
        schemaVersion: 1,
        action: "inspect",
        taskId: parsed.parsed.taskId,
        view: "full",
      });
      if (!viewed.ok) result = viewed;
      else if (
        viewed.revision !== exported.revision ||
        viewed.workspaceRevision !== exported.workspaceRevision
      )
        result = failure("revision_conflict", "task changed while preparing handoff", {
          operation: "handoff",
          ...(exported.revision ? { expectedRevision: exported.revision } : {}),
          ...(viewed.revision ? { actualRevision: viewed.revision } : {}),
          expectedWorkspaceRevision: exported.workspaceRevision,
          actualWorkspaceRevision: viewed.workspaceRevision,
        });
      else
        result = success(exported.revision, exported.workspaceRevision, {
          bundle: exported.data,
          context: JSON.parse(compactTaskContext(viewed.data as any)),
        });
    }
  } else if (
    parsed.parsed.family === "task" &&
    parsed.parsed.action === "resume" &&
    Array.isArray(parsed.parsed.request.authorityRefs) &&
    parsed.parsed.request.authorityRefs.length === 0
  ) {
    result = failure("needs_input", "resume requires explicit authority consent", {
      operation: "task.resume",
    });
  } else result = dispatch(core, parsed.parsed.family, parsed.parsed.request);
  if (parsed.parsed.json) jsonResult(outOf(deps), result);
  else printHuman(result, deps, parsed.parsed.handoff);
  return result.ok ? 0 : 1;
}

const cliActionProvenance = (actor: string): Provenance => ({
  kind: "host_observed",
  host: "workit_cli",
  session: { kind: "host", host: "workit_cli", handle: actor },
  workerId: null,
  receipts: [{ kind: "host", host: "workit_cli", handle: `action:${actor}` }],
});

const cliActionAuthority = (
  actor: string,
  reconciliationTokens = new WeakSet<object>(),
): NativeAuthorityVerifier => ({
  verifyDecision: ({ observation, expected, caller }) => {
    const value = observation as Record<string, unknown>;
    return caller.host === "workit_cli" &&
      caller.actor === actor &&
      value?.actor === actor &&
      value?.approved === (expected.response === "approved")
      ? success(null, null, cliActionProvenance(actor))
      : failure("permission_denied", "CLI confirmation is not attested");
  },
  verifyAction: ({ observation, expected, caller }) => {
    const value = observation as Record<string, unknown>;
    return caller.host === "workit_cli" &&
      caller.actor === actor &&
      value?.actor === actor &&
      value?.outcome === expected.outcome &&
      (expected.outcome === "reserve" ||
        (value?.taskRevision === expected.taskRevision &&
          value?.workspaceRevision === expected.workspaceRevision)) &&
      canonicalJson(value?.actionRef) === canonicalJson(expected.actionRef)
      ? success(null, null, cliActionProvenance(actor))
      : failure("permission_denied", "CLI action observation is not attested");
  },
  verifyReconciliation: ({ observation, expected, caller }: NativeReconciliationVerification) => {
    const value = observation as Record<string, unknown>;
    return typeof observation === "object" &&
      observation !== null &&
      caller.host === "workit_cli" &&
      caller.actor === actor &&
      reconciliationTokens.has(observation) &&
      value.kind === "provider_read" &&
      value.outcome === "succeeded" &&
      value.evidenceDigest === expected.evidenceDigest &&
      (expected.step === undefined || value.step === expected.step) &&
      canonicalJson(value.actionRef) === canonicalJson(expected.actionRef)
      ? success(null, null, cliActionProvenance(actor))
      : failure("permission_denied", "CLI hosting reconciliation is not attested");
  },
});

const nativeExternalActionRunner = (root: string, actor: string, core: WorkitCore, step?: string) =>
  createAuthorizedExternalActionRunner(core, (operationValue) => {
    const store = new TaskStore(root);
    const approved = approvedExternalAction(store, "workit_cli", actor, operationValue);
    if (!approved.ok) return approved;
    const actionRef = externalActionRef("workit_cli", actor, operationValue);
    return {
      taskId: approved.data.task.id,
      decisionId: approved.data.entry.id,
      actionRef,
      expectedRevision: approved.data.task.revision,
      expectedWorkspaceRevision: approved.data.workspace.revision,
      binding: approved.data.entry.data.binding,
      ...(step ? { step } : {}),
      refresh: () => {
        const freshTask = store.readTask(approved.data.task.id);
        const freshWorkspace = store.readWorkspace();
        if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data)
          throw new Error("external action state changed");
        return {
          expectedRevision: freshTask.data.revision,
          expectedWorkspaceRevision: freshWorkspace.data.revision,
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

export async function runActionCommand(argv: string[], deps: TaskCliDeps = {}): Promise<number> {
  const json = argv.includes("--json");
  const preview = argv.includes("--preview");
  const operation = argv.find((value) => !value.startsWith("--")) ?? "";
  const payloadIndex = argv.indexOf("--payload");
  const taskIndex = argv.indexOf("--task");
  if (!operation || payloadIndex < 0 || argv[payloadIndex + 1] === undefined) {
    const result = failure("invalid_input", "action requires <operation> --payload <JSON>");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 2;
  }
  if (
    taskIndex >= 0 &&
    (argv[taskIndex + 1] === undefined || argv[taskIndex + 1].startsWith("--"))
  ) {
    const result = failure("invalid_input", "--task requires a value");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 2;
  }
  // Same @file/stdin parity as the task surface: inline JSON, a UTF-8
  // @file, or UTF-8 stdin with -.
  const loaded = await payloadValue(argv[payloadIndex + 1], deps);
  if (!loaded.ok) {
    if (json) jsonResult(outOf(deps), loaded.result);
    else printHuman(loaded.result, deps);
    return 2;
  }
  const payload: unknown = loaded.value;
  const parsed = externalActionRequest({ operation, payload });
  if (!parsed.ok) {
    if (json) jsonResult(outOf(deps), parsed);
    else printHuman(parsed, deps);
    return 2;
  }
  const root = deps.root ?? process.env.WORKFLOW_WORKSPACE_ROOT ?? deps.cwd ?? process.cwd();
  const resolved = resolveExternalActionRequest(root, parsed.data);
  if (!resolved.ok) {
    if (json) jsonResult(outOf(deps), resolved);
    else printHuman(resolved, deps);
    return 2;
  }
  const normalized = resolved.data.request;
  const descriptor = externalActionDescriptor(
    normalized.operation,
    resolved.data.descriptorPayload,
  );
  if (preview) {
    const result = success(null, null, {
      operation: normalized.operation,
      descriptor,
      payload: normalized.payload,
    });
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 0;
  }
  if (normalized.operation === "context.read") {
    const result = await executeResolvedExternalAction(resolved.data, root);
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return result.ok ? 0 : 1;
  }
  const tty = deps.stdinIsTTY ? deps.stdinIsTTY() : process.stdin.isTTY === true;
  if (!tty || !argv.includes("--confirm")) {
    const result = failure("needs_input", "TTY confirmation is required for external actions", {
      operation: normalized.operation,
    });
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  const actor = deps.actor ?? "cli";
  const store = new TaskStore(root);
  const taskId = taskIndex >= 0 ? argv[taskIndex + 1] : undefined;
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok || !workspace.data) {
    const result = failure("storage_error", "external action state is unavailable");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  const tasks = listed.data.filter(
    (task) =>
      task.status === "active" &&
      task.workspaceId === workspace.data!.id &&
      (!taskId || task.id === taskId),
  );
  if (tasks.length !== 1) {
    const result = failure("permission_denied", "external action requires exactly one active task");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  const task = tasks[0];
  const prior = externalActionState(store, "workit_cli", actor, descriptor);
  const priorRequest = priorExternalAction(
    store,
    "workit_cli",
    actor,
    normalized.operation,
    normalized.payload,
  );
  if (
    priorRequest.ok &&
    priorRequest.data.entry.data.consumption !== null &&
    priorRequest.data.entry.data.consumption.state !== "uncertain"
  ) {
    const result = failure("permission_denied", "external action was already settled");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  if (
    prior.ok &&
    prior.data.entry.data.consumption !== null &&
    prior.data.entry.data.consumption.state !== "uncertain"
  ) {
    const result = failure("permission_denied", "external action was already settled");
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  if (priorRequest.ok && priorRequest.data.entry.data.consumption?.state === "uncertain") {
    const original = approvedResolvedExternalAction(
      priorRequest.data.entry.data.binding.approvedContent,
    );
    if (original.ok) {
      const actionRef = priorRequest.data.entry.data.consumption.actionRef;
      const evidence = await readExternalAction(root, original.data, actionRef);
      const freshTask = store.readTask(priorRequest.data.task.id);
      const freshWorkspace = store.readWorkspace();
      if (
        evidence.ok &&
        evidence.data.outcome === "succeeded" &&
        freshTask.ok &&
        freshWorkspace.ok &&
        freshWorkspace.data
      ) {
        const reconciliationTokens = new WeakSet<object>();
        const core = new WorkitCore(store, {
          ...contextFor(root, { ...deps, actor }, "host_observed"),
          nativeAuthority: cliActionAuthority(actor, reconciliationTokens),
          workerId: null,
        });
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
        if (reconciled.ok && evidence.data.step === "comment") {
          const remaining = await nativeExternalActionRunner(
            root,
            actor,
            core,
            "time",
          )(priorRequest.data.entry.data.binding.approvedContent, () =>
            executeResolvedExternalAction(original.data, root, "time", {
              host: "workit_cli",
              actor,
            }),
          );
          if (json) jsonResult(outOf(deps), remaining);
          else printHuman(remaining, deps);
          return remaining.ok ? 0 : 1;
        }
        if (json) jsonResult(outOf(deps), reconciled);
        else printHuman(reconciled, deps);
        return reconciled.ok ? 0 : 1;
      }
    }
    const result = failure(
      "external_outcome_unknown",
      "previous external action outcome is unknown",
    );
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  if (!json) write(outOf(deps), `External action preview: ${descriptor}`);
  const accepted = await observeConsent(deps);
  if (!accepted.accepted || !accepted.observed) {
    const result = failure(
      "permission_denied",
      "external action was not confirmed by the terminal",
    );
    if (json) jsonResult(outOf(deps), result);
    else printHuman(result, deps);
    return 1;
  }
  const core = new WorkitCore(store, {
    ...contextFor(root, { ...deps, actor }, "host_observed"),
    nativeAuthority: cliActionAuthority(actor),
    workerId: null,
  });
  const stableActionRef = externalActionRef("workit_cli", actor, descriptor);
  const decision = core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding: {
        taskId: task.id,
        workspaceId: workspace.data.id,
        scope: task.intent.data.scope,
        presented: `Approve ${descriptor}`,
        approvedContent: descriptor,
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    {
      actor,
      approved: true,
      callId: stableActionRef.kind === "host" ? stableActionRef.handle : "external-action",
    },
  );
  if (!decision.ok) {
    if (json) jsonResult(outOf(deps), decision);
    else printHuman(decision, deps);
    return 1;
  }
  const runner = nativeExternalActionRunner(root, actor, core);
  const result = await runner(descriptor, (step) =>
    executeResolvedExternalAction(resolved.data, root, step, { host: "workit_cli", actor }),
  );
  if (json) jsonResult(outOf(deps), result);
  else printHuman(result, deps);
  return result.ok ? 0 : 1;
}
