import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  approvedExternalAction,
  evaluateRequirements,
  externalActionDescriptor,
  success,
  type NativeAuthorityVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import type { Provenance } from "@/packages/workit-core/src/core/task-contract";
import {
  approvedBranchSetupIntent,
  branchSetupIntent,
  priorResolvedDrift,
} from "@/packages/workit-core/src/core/external-action";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";
import { assessment, taskStartRequest } from "./task-fixtures";

const provenance = (actor: string): Provenance => ({
  kind: "host_observed",
  host: "workit_cli",
  session: { kind: "host", host: "workit_cli", handle: actor },
  workerId: null,
  receipts: [{ kind: "host", host: "workit_cli", handle: `receipt:${actor}` }],
});

const verifier = (actor: string): NativeAuthorityVerifier => ({
  verifyDecision: () => success(null, null, provenance(actor)),
  verifyAction: () => success(null, null, provenance(actor)),
  verifyReconciliation: () => success(null, null, provenance(actor)),
});

const setup = (actor = "cli-intent") => {
  const root = mkdtempSync(join(tmpdir(), "workit-branch-intent-"));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    spawnSync("git", args, { cwd: root });
  writeFileSync(join(root, "base.txt"), "base\n");
  spawnSync("git", ["add", "base.txt"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host: "workit_cli", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeAuthority: verifier(actor),
  };
  const core = new WorkitCore(store, context);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  return { root, store, core, actor };
};

const resolveBranch = (root: string, target: string) => {
  const resolved = resolveExternalActionRequest(root, {
    operation: "git.branch_setup",
    payload: { target_branch: target },
  } as never);
  if (!resolved.ok) throw new Error(resolved.error);
  return {
    descriptor: externalActionDescriptor("git.branch_setup", resolved.data.descriptorPayload),
    resolved: resolved.data.descriptorPayload as { resolved: Record<string, unknown> },
  };
};

const recordApproval = (
  core: WorkitCore,
  store: TaskStore,
  taskId: string,
  descriptor: string,
  presented = "create the branch",
) => {
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const decision = core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId,
      expectedRevision: task.data.revision,
      purpose: "action",
      binding: {
        taskId,
        workspaceId: workspace.data.id,
        scope: task.data.intent.data.scope,
        presented,
        approvedContent: descriptor,
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    { kind: "decision", actor: "cli-intent" },
  );
  if (!decision.ok) throw new Error(decision.error);
};

test("branch intent carries across unrelated HEAD moves", () => {
  const { root, store, core } = setup();
  try {
    const first = resolveBranch(root, "feature/intent");
    const listed = store.listTasks();
    if (!listed.ok) throw new Error("tasks missing");
    recordApproval(core, store, listed.data[0].id, first.descriptor);
    writeFileSync(join(root, "later.txt"), "later\n");
    spawnSync("git", ["add", "later.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "later"], { cwd: root });
    const second = resolveBranch(root, "feature/intent");
    expect(second.descriptor).not.toBe(first.descriptor);
    expect(branchSetupIntent(second.descriptor)).toMatchObject(
      branchSetupIntent(first.descriptor) ?? {},
    );
    expect(approvedExternalAction(store, "workit_cli", "cli-intent", second.descriptor).ok).toBe(
      true,
    );
    expect(approvedBranchSetupIntent(store, "workit_cli", "cli-intent", second.descriptor).ok).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch drift names the moved element instead of demanding re-approval", () => {
  const { root, store, core } = setup();
  try {
    const first = resolveBranch(root, "feature/drift");
    const listed = store.listTasks();
    if (!listed.ok) throw new Error("tasks missing");
    recordApproval(core, store, listed.data[0].id, first.descriptor);
    const payload = (JSON.parse(first.descriptor) as { payload: Record<string, unknown> }).payload;
    delete payload.resolved;
    const headMoved = { ...first.resolved.resolved, head: "0".repeat(40) };
    expect(
      priorResolvedDrift(store, "workit_cli", "cli-intent", "git.branch_setup", payload, headMoved),
    ).toMatchObject({ ok: true });
    const remoteMoved = { ...first.resolved.resolved, remote_base: "1".repeat(40) };
    const remote = priorResolvedDrift(
      store,
      "workit_cli",
      "cli-intent",
      "git.branch_setup",
      payload,
      remoteMoved,
    );
    expect(remote.ok).toBe(false);
    if (remote.ok) throw new Error("expected drift failure");
    expect(String(remote.error)).toContain("remote_base");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stated choices record without a receipt but never authorize actions", () => {
  const { store, core } = setup("cli-stated");
  try {
    const listed = store.listTasks();
    if (!listed.ok) throw new Error("tasks missing");
    const taskId = listed.data[0].id;
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const stated = core.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: "Proceed with the stated approach?",
          approvedContent: "Proceed with the stated approach.",
          contentRefs: [],
          statedChoice: { ref: "question-call-1", text: "yes, do it" },
        },
        response: "stated",
        requirementIds: [],
      },
      undefined,
    );
    expect(stated.ok).toBe(true);
    const statedAction = core.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId,
        expectedRevision: task.data.revision,
        purpose: "action",
        binding: {
          taskId,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: "Run it?",
          approvedContent: "Run it.",
          contentRefs: [],
          statedChoice: { ref: "question-call-2", text: "yes, run it" },
        },
        response: "stated",
        requirementIds: [],
      },
      undefined,
    );
    expect(statedAction.ok).toBe(false);
    const missingChoice = core.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: "Proceed?",
          approvedContent: "Proceed.",
          contentRefs: [],
        },
        response: "stated",
        requirementIds: [],
      },
      undefined,
    );
    expect(missingChoice.ok).toBe(false);
    expect(approvedExternalAction(store, "workit_cli", "cli-stated", '{"operation":"x"}').ok).toBe(
      false,
    );
  } finally {
    const root = store.root;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stated design decision retires an open product choice", () => {
  const { store, core } = setup("cli-product");
  try {
    const listed = store.listTasks();
    if (!listed.ok) throw new Error("tasks missing");
    const taskId = listed.data[0].id;
    const assessed = core.policy({
      schemaVersion: 1,
      action: "assess",
      taskId,
      assessment: assessment({
        signals: {
          approachUnknown: { value: false, basis: "inferred", reason: "set", refs: [] },
          productChoiceOpen: { value: true, basis: "inferred", reason: "open", refs: [] },
          behaviorChange: { value: false, basis: "inferred", reason: "set", refs: [] },
          mechanicalLowRisk: { value: true, basis: "inferred", reason: "set", refs: [] },
          durableAgreementNeeded: { value: false, basis: "inferred", reason: "set", refs: [] },
          coordinationPlanNeeded: { value: false, basis: "inferred", reason: "set", refs: [] },
          helperUseful: { value: false, basis: "inferred", reason: "set", refs: [] },
          testFirstPractical: { value: false, basis: "inferred", reason: "set", refs: [] },
        },
      }),
    });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error(assessed.error);
    if (!assessed.data) throw new Error("assessment missing");
    const requirement = assessed.data.requirements.find(
      (item) => item.ruleId === "product-decision",
    );
    expect(requirement).toBeTruthy();
    if (!requirement) throw new Error("product-decision requirement missing");
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const stated = core.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId,
          workspaceId: workspace.data.id,
          scope: requirement.scope,
          presented: "Which approach?",
          approvedContent: "Take the second approach.",
          contentRefs: [],
          statedChoice: { ref: "question-call-9", text: "take the second one" },
        },
        response: "stated",
        requirementIds: [requirement.id],
      },
      undefined,
    );
    expect(stated.ok).toBe(true);
    if (!stated.ok) throw new Error(stated.error);
    const fresh = store.readTask(taskId);
    const freshWorkspace = store.readWorkspace();
    if (!fresh.ok || !freshWorkspace.ok || !freshWorkspace.data) throw new Error("state missing");
    const evaluated = evaluateRequirements(fresh.data, freshWorkspace.data, [], null, store.root);
    const product = evaluated.find((item) => item.requirementId === requirement.id);
    expect(product?.status).toBe("satisfied");
  } finally {
    const root = store.root;
    rmSync(root, { recursive: true, force: true });
  }
});
