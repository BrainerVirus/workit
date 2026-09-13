import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicableDecision,
  evaluateRequirements,
  WorkitCore,
  TaskStore,
  captureCandidate,
  decisionDigest,
  type NativeAuthorityVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import {
  reserveAction as reserveBoundedAction,
  verifyNativeAction,
} from "@/packages/workit-core/src/core/authority";
import { assessment, caller, ref, scope, taskStartRequest } from "./task-fixtures";

const context = (root: string, authority = verifier()): OperationContext =>
  ({
    root,
    caller: caller(),
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeAuthority: authority,
  }) as OperationContext;

const attested = (host: "workit_cli" | "cursor" = "workit_cli", handle = "receipt") => {
  const receipt = { kind: "host" as const, host, handle };
  return {
    kind: "host_observed" as const,
    host,
    session: { kind: "host" as const, host, handle: "test" },
    workerId: null,
    receipts: [receipt],
  };
};

const verifier = (calls: Array<Record<string, unknown>> = []): NativeAuthorityVerifier => ({
  verifyDecision: (input: Record<string, unknown>) => {
    calls.push({ kind: "decision", ...input });
    if ((input.observation as { kind?: string } | undefined)?.kind !== "decision")
      return {
        ok: false as const,
        schemaVersion: 1 as const,
        code: "permission_denied" as const,
        error: "untrusted decision observation",
        details: {},
      };
    return {
      ok: true,
      schemaVersion: 1 as const,
      revision: null,
      workspaceRevision: null,
      data: attested("workit_cli"),
    };
  },
  verifyAction: (input: Record<string, unknown>) => {
    calls.push({ kind: "action", ...input });
    const observation = input.observation as
      | { kind?: string; provenance?: { host?: string }; actionRef?: unknown }
      | undefined;
    const expected = input.expected as { actionRef?: unknown };
    if (
      observation?.kind !== "action" ||
      observation.provenance?.host !== (input.caller as { host?: string }).host ||
      (observation.actionRef !== undefined &&
        JSON.stringify(observation.actionRef) !== JSON.stringify(expected.actionRef))
    )
      return {
        ok: false as const,
        schemaVersion: 1 as const,
        code: "permission_denied" as const,
        error: "untrusted action observation",
        details: {},
      };
    return {
      ok: true,
      schemaVersion: 1 as const,
      revision: null,
      workspaceRevision: null,
      data: attested("workit_cli"),
    };
  },
});

const active = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-authority-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as any).id as string);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active task missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

const actionBinding = (task: ReturnType<typeof active>["task"], workspaceId: string) => ({
  taskId: task.id,
  workspaceId,
  scope: task.intent.data.scope,
  presented: "run the bounded action",
  approvedContent: "run the bounded action",
  contentRefs: [],
});

const nativeObservationFor = (
  host: "workit_cli" | "cursor",
  handle: string,
  effect: "none" | "performed" | "unknown" = "performed",
) => {
  const receipt = {
    kind: "host" as const,
    host,
    handle: `receipt-${handle}`,
  };
  return {
    kind: "action" as const,
    receipt,
    effect,
    provenance: {
      kind: "host_observed" as const,
      host,
      session: { kind: "host" as const, host, handle: "test" },
      workerId: null,
      receipts: [receipt],
    },
  };
};

const nativeObservation = (
  handle: string,
  effect: "none" | "performed" | "unknown" = "performed",
) => nativeObservationFor("workit_cli", handle, effect);

const nativeDecision = (handle: string) => ({
  ...nativeObservation(`decision-${handle}`),
  kind: "decision" as const,
});

const recordNativeDecision = (core: WorkitCore, request: Record<string, unknown>, handle: string) =>
  core.observeDecision(request, nativeDecision(handle));

test("decision.record keeps claimed approval agent-reported and native observation is explicit", () => {
  const { core, task, workspace } = active();
  const binding = actionBinding(task, workspace.id);
  const result = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding,
    response: "approved",
    requirementIds: [],
  });
  expect(result).toMatchObject({ ok: true, data: { data: { purpose: "action", revoked: null } } });
  if (!result.ok) throw new Error(result.error);
  expect(result.data.data.digest).toBe(decisionDigest(result.data.data));
  expect(result.data.provenance).toMatchObject({ kind: "agent_reported", host: "workit_cli" });
});

test("same-host forged native observations are rejected by the trusted verifier", () => {
  const { core, task, workspace } = active();
  const request = {
    schemaVersion: 1,
    action: "record" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action" as const,
    binding: actionBinding(task, workspace.id),
    response: "approved" as const,
    requirementIds: [],
  };
  expect(core.observeDecision(request, nativeObservation("forged"))).toMatchObject({
    ok: false,
    code: "permission_denied",
  });
});

test("native approval receipts are bound once to the exact decision purpose and bytes", () => {
  const { root, store, task, workspace } = active();
  const calls: Array<Record<string, unknown>> = [];
  const core = new WorkitCore(store, context(root, verifier(calls)));
  const binding = actionBinding(task, workspace.id);
  const firstRequest = {
    schemaVersion: 1,
    action: "record" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action" as const,
    binding,
    response: "approved" as const,
    requirementIds: [],
  };
  const receiptObservation = nativeDecision("receipt-reuse");
  const first = core.observeDecision(firstRequest, receiptObservation);
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) throw new Error(first.error);
  expect(calls[0]?.expected).toMatchObject({
    taskId: task.id,
    workspaceId: workspace.id,
    purpose: "action",
    response: "approved",
    binding,
    requirementIds: [],
  });
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  expect(
    core.observeDecision(
      { ...firstRequest, expectedRevision: current.data.revision, purpose: "design" },
      receiptObservation,
    ),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("cross-host settlement observations cannot settle a caller-bound reservation", () => {
  const { core, store, task, workspace } = active();
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding: actionBinding(task, workspace.id),
      response: "approved",
      requirementIds: [],
    },
    "cross-host",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const reservation = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "cross-host-action" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: workspace.revision,
    observation: nativeObservation("cross-host-action"),
  });
  if (!reservation.ok) throw new Error(reservation.error);
  expect(
    core.settleAction({
      ...reservation.data,
      outcome: "succeeded",
      observation: {
        ...nativeObservationFor("cursor", "cross-host", "performed"),
        actionRef: reservation.data.actionRef,
      },
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("verified action authority cannot cross its owning core or store", () => {
  const { core, store, task, workspace, root } = active();
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding: actionBinding(task, workspace.id),
      response: "approved",
      requirementIds: [],
    },
    "owner-scope",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const actionRef = { kind: "host" as const, host: "workit_cli" as const, handle: "owner-scope" };
  const owner = {};
  const authority = verifyNativeAction(
    verifier(),
    {
      observation: nativeObservation("owner-scope"),
      expected: {
        taskId: task.id,
        workspaceId: workspace.id,
        decisionId: recorded.data.id,
        actionRef,
        taskRevision: current.data.revision,
        workspaceRevision: workspace.revision,
        outcome: "reserve",
        decision: recorded.data.data,
      },
      caller: caller(),
    },
    { owner, store, root },
  );
  if (!authority.ok) throw new Error(authority.error);
  expect(
    reserveBoundedAction({
      store: new TaskStore(store.root),
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef,
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      authority: authority.data,
      authorityOwner: {},
      authorityCaller: caller(),
      native: { now: "2026-01-01T00:00:00Z" },
    } as any),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    reserveBoundedAction({
      store,
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef,
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      authority: authority.data,
      authorityOwner: owner,
      authorityCaller: caller(),
      native: { now: "2026-01-01T00:00:00Z" },
    } as any),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("finding.record preserves agent-reported provenance without native observation", () => {
  const { core, task } = active();
  const result = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    claim: "agent finding",
    consequence: "needs review",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  expect(result).toMatchObject({ ok: true, data: { provenance: { kind: "agent_reported" } } });
});

test("content-bound decisions are inapplicable without a verified checkout root", () => {
  const { core, store, task, workspace, root } = active();
  const file = join(root, "bound.md");
  writeFileSync(file, "bound");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const binding = {
    ...actionBinding(task, workspace.id),
    contentRefs: [{ kind: "file" as const, path: "bound.md", digest }],
  };
  const decision = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "design",
    binding,
    response: "approved",
    requirementIds: [],
  });
  if (!decision.ok) throw new Error(decision.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  expect(applicableDecision(current.data, "design", binding)).toEqual([]);
});

test("agent-reported approval cannot reserve, while a receipt-bound native approval can", () => {
  const { core, store, task, workspace } = active();
  const request = {
    schemaVersion: 1,
    action: "record" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action" as const,
    binding: actionBinding(task, workspace.id),
    response: "approved" as const,
    requirementIds: [],
  };
  const reported = core.decision(request);
  if (!reported.ok) throw new Error(reported.error);
  const blocked = core.reserveAction({
    taskId: task.id,
    decisionId: reported.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "agent-action" },
    expectedRevision: reported.revision!,
    expectedWorkspaceRevision: workspace.revision,
    observation: nativeObservation("agent-action"),
  });
  expect(blocked).toMatchObject({ ok: false, code: "permission_denied" });
  const nativeTask = store.readTask(task.id);
  if (!nativeTask.ok) throw new Error(nativeTask.error);
  const observed = recordNativeDecision(
    core,
    { ...request, expectedRevision: nativeTask.data.revision },
    "approval",
  );
  expect(observed).toMatchObject({ ok: true, data: { provenance: { kind: "host_observed" } } });
  if (!observed.ok) throw new Error(observed.error);
  const reserveTask = store.readTask(task.id);
  if (!reserveTask.ok) throw new Error(reserveTask.error);
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: observed.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-action" },
      expectedRevision: reserveTask.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      observation: nativeObservation("native-action"),
    }),
  ).toMatchObject({ ok: true });
});

test("settlement requires a receipt-bound native observation and exact action binding", () => {
  const { core, store, task, workspace } = active();
  const request = {
    schemaVersion: 1,
    action: "record" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action" as const,
    binding: actionBinding(task, workspace.id),
    response: "approved" as const,
    requirementIds: [],
  };
  const recorded = recordNativeDecision(core, request, "settlement");
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const reservation = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "settled-action" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: workspace.revision,
    observation: nativeObservation("settled-action"),
  });
  if (!reservation.ok) throw new Error(reservation.error);
  expect(core.settleAction({ ...reservation.data, outcome: "not_started" } as any)).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
  expect(
    core.settleAction({
      ...reservation.data,
      outcome: "not_started",
      observation: {
        ...nativeObservation("wrong-action", "none"),
        actionRef: { kind: "host", host: "workit_cli", handle: "wrong" },
      },
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    core.settleAction({
      ...reservation.data,
      outcome: "not_started",
      observation: {
        ...nativeObservation("no-effect", "none"),
        actionRef: reservation.data.actionRef,
      },
    }),
  ).toMatchObject({ ok: true });
});

test("stale limitation document bytes stop accepted-limitations applicability", () => {
  const { core, store, task, workspace, root } = active();
  const file = join(root, "limitation.md");
  writeFileSync(file, "approved limitation");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: task.id,
    expectedRevision: task.revision,
    assessment: assessment(),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const current = store.readTask(task.id);
  if (!current.ok || !current.data.policy) throw new Error("policy missing");
  const requirement = current.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) throw new Error("limitation-capable requirement missing");
  const binding = {
    ...actionBinding(current.data, workspace.id),
    contentRefs: [{ kind: "file" as const, path: "limitation.md", digest }],
  };
  const decision = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    purpose: "limitation",
    binding,
    response: "approved",
    requirementIds: [requirement.id],
  });
  expect(decision).toMatchObject({ ok: true });
  if (!decision.ok) throw new Error(decision.error);
  const decisionTask = store.readTask(task.id);
  if (!decisionTask.ok) throw new Error(decisionTask.error);
  const before = core.task({
    schemaVersion: 1,
    action: "inspect",
    taskId: task.id,
    view: "summary",
  });
  if (!before.ok) throw new Error(before.error);
  expect(
    (before.data as any).requirements.find((item: any) => item.requirementId === requirement.id)
      ?.status,
  ).toBe("accepted_limitation");
  writeFileSync(file, "drifted limitation");
  const blind = evaluateRequirements(decisionTask.data, workspace, [], null, root);
  expect(blind.find((item) => item.requirementId === requirement.id)?.status).toBe("unsatisfied");
  const after = core.task({
    schemaVersion: 1,
    action: "inspect",
    taskId: task.id,
    view: "summary",
  });
  if (!after.ok) throw new Error(after.error);
  expect(
    (after.data as any).requirements.find((item: any) => item.requirementId === requirement.id)
      ?.status,
  ).toBe("unsatisfied");
});

test("document approval rejects a symlinked ancestor outside the checkout", () => {
  const { core, task, workspace, root } = active();
  const outside = mkdtempSync(join(tmpdir(), "workit-outside-"));
  mkdirSync(join(outside, "nested"));
  const file = join(outside, "nested", "approved.md");
  writeFileSync(file, "outside");
  symlinkSync(join(outside, "nested"), join(root, "linked"), "dir");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  expect(
    core.decision({
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "limitation",
      binding: {
        ...actionBinding(task, workspace.id),
        contentRefs: [{ kind: "file" as const, path: "linked/approved.md", digest }],
      },
      response: "approved",
      requirementIds: [],
    }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("dismissal rejects evidence unrelated to the finding claim and references", () => {
  const { core, store, task } = active();
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    claim: "unsafe behavior",
    consequence: "unsafe closure",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref({ url: "https://example.test/finding" })],
  });
  if (!finding.ok) throw new Error(finding.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    evidence: {
      kind: "investigation",
      claim: "unrelated investigation",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "failed",
      summary: "different issue",
      refs: [ref({ url: "https://example.test/other" })],
      exitCode: 1,
      reviewContext: null,
    },
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const afterEvidence = store.readTask(task.id);
  if (!afterEvidence.ok) throw new Error(afterEvidence.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: afterEvidence.data.revision,
      findingId: finding.data.id,
      disposition: "dismissed",
      reason: "not supported",
      evidenceIds: [evidence.data.id],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("bounded progress persists after an intermediate native settlement", () => {
  const { core, store, task, workspace } = active();
  const request = {
    schemaVersion: 1,
    action: "record" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action" as const,
    binding: {
      ...actionBinding(task, workspace.id),
      approvedContent: JSON.stringify({ steps: ["one", "two"] }),
    },
    response: "approved" as const,
    requirementIds: [],
  };
  const recorded = recordNativeDecision(core, request, "persisted-workflow");
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const first = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "step-one" },
    step: "one",
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: workspace.revision,
    observation: nativeObservation("step-one"),
  });
  if (!first.ok) throw new Error(first.error);
  expect(
    core.settleAction({
      ...first.data,
      outcome: "succeeded",
      observation: {
        ...nativeObservation("step-one", "performed"),
        actionRef: first.data.actionRef,
      },
    }),
  ).toMatchObject({ ok: true });
  const after = store.readTask(task.id);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.actionProgress).toEqual([
    { decisionId: recorded.data.id, steps: ["one", "two"], completedSteps: ["one"] },
  ]);
  const restarted = new WorkitCore(new TaskStore(store.root), context(store.root));
  const restartedTask = new TaskStore(store.root).readTask(task.id);
  const restartedWorkspace = new TaskStore(store.root).readWorkspace();
  if (!restartedTask.ok || !restartedWorkspace.ok || !restartedWorkspace.data)
    throw new Error("state missing after restart");
  const second = restarted.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "step-two" },
    step: "two",
    expectedRevision: restartedTask.data.revision,
    expectedWorkspaceRevision: restartedWorkspace.data.revision,
    observation: nativeObservation("step-two"),
  });
  expect(second).toMatchObject({
    ok: true,
    data: { completedSteps: ["one"], remainingSteps: ["two"] },
  });
  if (!second.ok) throw new Error(second.error);
  expect(
    restarted.settleAction({
      ...second.data,
      outcome: "succeeded",
      observation: {
        ...nativeObservation("step-two", "performed"),
        actionRef: second.data.actionRef,
      },
    }),
  ).toMatchObject({ ok: true });
});

test("two invocations cannot reserve one bounded approval", () => {
  const { core, store, task, workspace } = active();
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding: actionBinding(task, workspace.id),
      response: "approved",
      requirementIds: [],
    },
    "one-time",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const input = {
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host" as const, host: "workit_cli" as const, handle: "native-1" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
    observation: nativeObservation("native-1"),
  };
  expect(core.reserveAction(input)).toMatchObject({ ok: true });
  const after = store.readTask(task.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data) throw new Error("state missing");
  expect(
    core.reserveAction({
      ...input,
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
      observation: nativeObservation("native-1-repeat"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("ambiguous settlement blocks blind retry and not_started releases only with native evidence", () => {
  const { core, store, task, workspace } = active();
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding: actionBinding(task, workspace.id),
      response: "approved",
      requirementIds: [],
    },
    "unknown",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const reservation = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
    observation: nativeObservation("native-1-unknown"),
  });
  if (!reservation.ok) throw new Error(reservation.error);
  const settled = core.settleAction({
    ...reservation.data,
    outcome: "unknown",
    observation: {
      ...nativeObservation("unknown", "unknown"),
      actionRef: reservation.data.actionRef,
    },
  });
  expect(settled).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  const after = store.readTask(task.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data) throw new Error("state missing");
  const restarted = new WorkitCore(new TaskStore(store.root), context(store.root));
  expect(
    restarted.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-2" },
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
      observation: nativeObservation("native-2-unknown"),
    }),
  ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
});

test("bounded workflows advance once and cannot repeat a completed step", () => {
  const { core, store, task, workspace } = active();
  const binding = {
    ...actionBinding(task, workspace.id),
    approvedContent: JSON.stringify({ steps: ["one", "two"] }),
  };
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding,
      response: "approved",
      requirementIds: [],
    },
    "bounded",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const first = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "one" },
    step: "one",
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
    observation: nativeObservation("one"),
  });
  if (!first.ok) throw new Error(first.error);
  const settledFirst = core.settleAction({
    ...first.data,
    outcome: "succeeded",
    observation: { ...nativeObservation("one", "performed"), actionRef: first.data.actionRef },
  });
  if (!settledFirst.ok) throw new Error(settledFirst.error);
  const afterFirst = store.readTask(task.id);
  const afterFirstWorkspace = store.readWorkspace();
  if (!afterFirst.ok || !afterFirstWorkspace.ok || !afterFirstWorkspace.data)
    throw new Error("state missing");
  const second = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "two" },
    step: "two",
    expectedRevision: afterFirst.data.revision,
    expectedWorkspaceRevision: afterFirstWorkspace.data.revision,
    observation: nativeObservation("two"),
  });
  expect(second).toMatchObject({
    ok: true,
    data: { completedSteps: ["one"], remainingSteps: ["two"] },
  });
  if (!second.ok) throw new Error(second.error);
  expect(
    core.settleAction({
      ...second.data,
      outcome: "succeeded",
      observation: { ...nativeObservation("two", "performed"), actionRef: second.data.actionRef },
    }),
  ).toMatchObject({ ok: true });
  const afterSecond = store.readTask(task.id);
  const afterSecondWorkspace = store.readWorkspace();
  if (!afterSecond.ok || !afterSecondWorkspace.ok || !afterSecondWorkspace.data)
    throw new Error("state missing");
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "repeat" },
      step: "one",
      expectedRevision: afterSecond.data.revision,
      expectedWorkspaceRevision: afterSecondWorkspace.data.revision,
      observation: nativeObservation("repeat"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("decision applicability rejects purpose, binding, scope, rejection, revocation, and byte drift", () => {
  const { core, store, task, workspace } = active();
  const binding = actionBinding(task, workspace.id);
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "design",
      binding,
      response: "approved",
      requirementIds: [],
    },
    "drift",
  );
  expect(recorded).toMatchObject({ ok: true });
  if (!recorded.ok) throw new Error(recorded.error);
  expect(core.applicableDecision(task.id, "action", binding)).toMatchObject({ data: [] });
  expect(
    core.applicableDecision(task.id, "design", { ...binding, presented: "changed" }),
  ).toMatchObject({
    data: [],
  });
  const forged = store.mutateTask(
    task.id,
    recorded.revision!,
    (current, mutation) =>
      ({
        ok: true,
        schemaVersion: 1,
        revision: mutation.revision,
        workspaceRevision: null,
        data: {
          ...current,
          decisions: current.decisions.map((entry) =>
            entry.id === recorded.data.id
              ? {
                  ...entry,
                  data: {
                    ...entry.data,
                    binding: { ...entry.data.binding, approvedContent: "forged" },
                  },
                }
              : entry,
          ),
        },
      }) as any,
  );
  expect(forged.ok).toBe(true);
  const latest = store.readTask(task.id);
  if (!latest.ok) throw new Error(latest.error);
  expect(core.applicableDecision(task.id, "design", binding)).toMatchObject({ data: [] });
});

test("action reservation rejects changed approved document bytes and scope", () => {
  const { core, store, task, workspace, root } = active();
  const file = join(root, "approved.md");
  writeFileSync(file, "approved");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const binding = {
    ...actionBinding(task, workspace.id),
    contentRefs: [{ kind: "file" as const, path: "approved.md", digest }],
  };
  const recorded = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: task.revision,
      purpose: "action",
      binding,
      response: "approved",
      requirementIds: [],
    },
    "document-drift",
  );
  if (!recorded.ok) throw new Error(recorded.error);
  writeFileSync(file, "drifted");
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      binding: { ...binding, scope: scope({ paths: ["other"] }) },
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      observation: nativeObservation("native-1-drift"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      observation: nativeObservation("native-1-drift-repeat"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("rejected and revoked decisions never authorize actions, and provenance is not agent-controlled", () => {
  const { core, store, task, workspace } = active();
  const rejected = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "rejected",
    requirementIds: [],
    provenance: { kind: "host_observed" },
  });
  expect(rejected).toMatchObject({ ok: false, code: "invalid_input" });
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "rejected",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const after = store.readTask(task.id);
  if (!after.ok) throw new Error(after.error);
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      observation: nativeObservation("rejected"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  const approved = recordNativeDecision(
    core,
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.id,
      expectedRevision: after.data.revision,
      purpose: "action",
      binding: actionBinding(task, workspace.id),
      response: "approved",
      requirementIds: [],
    },
    "revocation",
  );
  if (!approved.ok) throw new Error(approved.error);
  const approvedTask = store.readTask(task.id);
  if (!approvedTask.ok) throw new Error(approvedTask.error);
  const revoked = core.decision({
    schemaVersion: 1,
    action: "revoke",
    taskId: task.id,
    expectedRevision: approvedTask.data.revision,
    decisionId: approved.data.id,
    reason: "withdrawn",
  });
  expect(revoked).toMatchObject({ ok: true, data: { data: { revoked: { reason: "withdrawn" } } } });
  const revokedTask = store.readTask(task.id);
  if (!revokedTask.ok) throw new Error(revokedTask.error);
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: approved.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-2" },
      expectedRevision: revokedTask.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      observation: nativeObservation("revoked"),
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("finding resolution requires verification, evidence-backed dismissal, and permitted deferral", () => {
  const { core, store, task } = active();
  const candidate = captureCandidate(store.root, task.intent.data.scope, []);
  if (!candidate.ok) throw new Error(candidate.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    evidence: {
      kind: "check",
      claim: "verification",
      requirementIds: [],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "verified",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const findingTask = store.readTask(task.id);
  if (!findingTask.ok) throw new Error(findingTask.error);
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: findingTask.data.revision,
    claim: "bad",
    consequence: "unsafe",
    scope: task.intent.data.scope,
    candidateId: candidate.data.id,
    refs: [ref()],
  });
  expect(finding).toMatchObject({ ok: true, data: { data: { disposition: "open" } } });
  if (!finding.ok) throw new Error(finding.error);
  const fixedTask = store.readTask(task.id);
  if (!fixedTask.ok) throw new Error(fixedTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: fixedTask.data.revision,
      findingId: finding.data.id,
      disposition: "fixed",
      reason: "verified",
      evidenceIds: [evidence.data.id],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: true, data: { data: { disposition: "fixed" } } });
  const resolvedTask = store.readTask(task.id);
  if (!resolvedTask.ok) throw new Error(resolvedTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: resolvedTask.data.revision,
      findingId: finding.data.id,
      disposition: "dismissed",
      reason: "unsupported",
      evidenceIds: [],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("dismissal needs evidence and deferral needs an applicable permitted limitation", () => {
  const { core, store, task, workspace } = active();
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: task.id,
    expectedRevision: task.revision,
    assessment: assessment(),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const assessedTask = store.readTask(task.id);
  if (!assessedTask.ok || !assessedTask.data.policy) throw new Error("policy missing");
  const requirement = assessedTask.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) throw new Error("limitation-capable requirement missing");
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: assessedTask.data.revision,
    claim: "unsupported",
    consequence: "unknown",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  if (!finding.ok) throw new Error(finding.error);
  const findingTask = store.readTask(task.id);
  if (!findingTask.ok) throw new Error(findingTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: findingTask.data.revision,
      findingId: finding.data.id,
      disposition: "dismissed",
      reason: "unsupported claim",
      evidenceIds: [],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  const afterDismissalAttempt = store.readTask(task.id);
  if (!afterDismissalAttempt.ok) throw new Error(afterDismissalAttempt.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: afterDismissalAttempt.data.revision,
    evidence: {
      kind: "investigation",
      claim: "unsupported",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "passed",
      summary: "not reproduced",
      refs: [ref()],
      exitCode: 0,
      reviewContext: null,
    },
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const afterEvidence = store.readTask(task.id);
  if (!afterEvidence.ok) throw new Error(afterEvidence.error);
  const dismissed = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: afterEvidence.data.revision,
    findingId: finding.data.id,
    disposition: "dismissed",
    reason: "unsupported claim",
    evidenceIds: [evidence.data.id],
    decisionIds: [],
  });
  expect(dismissed).toMatchObject({ ok: true, data: { data: { disposition: "dismissed" } } });
  const reopened = store.readTask(task.id);
  if (!reopened.ok) throw new Error(reopened.error);
  const reopenedFinding = reopened.data.findings.find((entry) => entry.id === finding.data.id);
  if (!reopenedFinding) throw new Error("finding missing");
  const reopenedAgain = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: reopened.data.revision,
    findingId: finding.data.id,
    disposition: "open",
    reason: "new evidence",
    evidenceIds: [evidence.data.id],
    decisionIds: [],
  });
  expect(reopenedAgain).toMatchObject({ ok: true, data: { data: { disposition: "open" } } });
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const limitationBinding = actionBinding(current.data, workspace.id);
  const limitation = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    purpose: "limitation",
    binding: limitationBinding,
    response: "approved",
    requirementIds: [requirement.id],
  });
  if (!limitation.ok) throw new Error(limitation.error);
  const beforeDefer = store.readTask(task.id);
  if (!beforeDefer.ok) throw new Error(beforeDefer.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: beforeDefer.data.revision,
      findingId: finding.data.id,
      disposition: "deferred",
      reason: "accepted limitation",
      evidenceIds: [],
      decisionIds: [limitation.data.id],
    }),
  ).toMatchObject({ ok: true, data: { data: { disposition: "deferred" } } });
});

test("new candidate evidence reopens a resolved finding", () => {
  const { core, store, task } = active();
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    claim: "bad",
    consequence: "unsafe",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  if (!finding.ok) throw new Error(finding.error);
  const resolvedTask = store.readTask(task.id);
  if (!resolvedTask.ok) throw new Error(resolvedTask.error);
  const dismissed = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: resolvedTask.data.revision,
    findingId: finding.data.id,
    disposition: "dismissed",
    reason: "unsupported",
    evidenceIds: ["00000000-0000-4000-8000-000000000001"],
    decisionIds: [],
  });
  expect(dismissed.ok).toBe(false);
  writeFileSync(join(store.root, "new.txt"), "new evidence");
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    evidence: {
      kind: "investigation",
      claim: "new observation",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "failed",
      summary: "new",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(evidence.ok).toBe(true);
  const latest = store.readTask(task.id);
  if (!latest.ok) throw new Error(latest.error);
  expect(latest.data.findings[0]?.data.disposition).toBe("open");
});

test("malformed JSON steps reject reservation while prose stays unbounded", () => {
  const reserve = (approvedContent: string) => {
    const { core, store, task, workspace } = active();
    const recorded = recordNativeDecision(
      core,
      {
        schemaVersion: 1,
        action: "record" as const,
        taskId: task.id,
        purpose: "action" as const,
        binding: { ...actionBinding(task, workspace.id), approvedContent },
        response: "approved" as const,
        requirementIds: [],
      },
      `steps-${approvedContent.length}`,
    );
    if (!recorded.ok) throw new Error(recorded.error);
    const current = store.readTask(task.id);
    if (!current.ok) throw new Error(current.error);
    return core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "step-one" },
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: workspace.revision,
      observation: nativeObservation(`reserve-${approvedContent.length}`),
    });
  };
  expect(reserve(JSON.stringify({ steps: "all" }))).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
  expect(reserve("run the approved maintenance window")).toMatchObject({ ok: true });
});
