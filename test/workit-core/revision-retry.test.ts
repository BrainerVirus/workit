import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TaskStore,
  WorkitCore,
  failure,
  standingReceiptFor,
  sha256,
  success,
  type Assessment,
  type NativeAuthorityVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import {
  defaultLockTimeout,
  setDefaultLockTimeout,
} from "@/packages/workit-core/src/core/store-lock";
import { assessment, caller, scope, taskStartRequest } from "./task-fixtures";

// Engine revision retry (design §0 item 14): a revision the caller omitted is
// not a compare-and-swap request, so losing the race to another writer on it
// re-reads, re-checks and re-applies instead of surfacing revision_conflict.
// Caller-supplied revisions keep strict CAS semantics.

const context = (root: string): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const signals = (spec: boolean): Assessment["signals"] => ({
  approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
  productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
  behaviorChange: { value: false, basis: "inferred", reason: "mechanical", refs: [] },
  mechanicalLowRisk: { value: true, basis: "inferred", reason: "mechanical", refs: [] },
  durableAgreementNeeded: { value: spec, basis: "inferred", reason: "spec", refs: [] },
  coordinationPlanNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
  helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
  testFirstPractical: { value: false, basis: "inferred", reason: "none", refs: [] },
});

const started = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-retry-"));
  writeFileSync(join(root, "a.ts"), "before");
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const result = core.task(taskStartRequest());
  if (!result.ok) throw new Error(result.error);
  const taskId = (result.data as { id: string }).id;
  return { root, store, core, taskId };
};

const assess = (core: WorkitCore, taskId: string, spec: boolean) => {
  const result = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    assessment: assessment({ signals: signals(spec) }),
  });
  if (!result.ok) throw new Error(result.error);
};

const progress = (taskId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  action: "progress",
  taskId,
  progress: { summary: "retry probe", nextAction: null, blockers: [] },
  ...extra,
});

/**
 * Wrap the store's commit methods so a competing write lands after the engine
 * read its records but before it takes the lock — the exact race under test.
 * `interfere(call)` decides per commit attempt whether to interleave.
 */
const interleave = (
  store: TaskStore,
  competitor: () => void,
  interfere: (call: number) => boolean,
) => {
  let calls = 0;
  for (const method of ["mutateTask", "mutateTaskAndWorkspace"] as const) {
    const original = (store as any)[method].bind(store);
    (store as any)[method] = (...args: unknown[]) => {
      calls += 1;
      if (interfere(calls)) competitor();
      return original(...args);
    };
  }
  return { attempts: () => calls };
};

test("Given a competing write between read and commit, When the caller omitted revisions, Then the engine retries and applies once", () => {
  const { root, store, core, taskId } = started();
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const result = core.task(
    progress(taskId, { progress: { summary: "mine", nextAction: null, blockers: [] } }),
  );
  expect(result).toMatchObject({ ok: true });
  expect(probe.attempts()).toBe(2);
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  expect(task.data.progress.summary).toBe("mine");
});

test("Given a competing write, When the caller passed an explicit expectedRevision, Then revision_conflict surfaces after one attempt", () => {
  const { root, store, core, taskId } = started();
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const before = store.readTask(taskId);
  if (!before.ok) throw new Error(before.error);
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const result = core.task(progress(taskId, { expectedRevision: before.data.revision }));
  expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(probe.attempts()).toBe(1);
});

test("Given a stale explicit expectedRevision and no contention, When the call runs, Then it is a revision_conflict without retry", () => {
  const { store, core, taskId } = started();
  const probe = interleave(
    store,
    () => {},
    () => false,
  );
  const result = core.task(
    progress(taskId, { expectedRevision: "00000000-0000-4000-8000-000000000000" }),
  );
  expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(probe.attempts()).toBe(1);
});

test("Given a requirement that lands between attempts, When the retry re-checks policy, Then it returns the policy error, not a stale success", () => {
  const { root, store, core, taskId } = started();
  assess(core, taskId, false);
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    // The competing reassessment adds a before:write durable-spec requirement.
    () => assess(competitor, taskId, true),
    (call) => call === 1,
  );
  const result = core.writer({ schemaVersion: 1, action: "acquire", taskId });
  expect(result).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
  // The gate is re-evaluated before any second commit attempt.
  expect(probe.attempts()).toBe(1);
  const workspace = store.readWorkspace();
  if (!workspace.ok) throw new Error(workspace.error);
  expect(workspace.data?.writer ?? null).toBeNull();
});

test("Given a competing write on every attempt, When the caller omitted revisions, Then the engine stops after a bounded number of attempts with busy", () => {
  const { root, store, core, taskId } = started();
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    () => true,
  );
  // A generous lock budget isolates the attempt cap from the wall-time cap.
  const budget = defaultLockTimeout();
  setDefaultLockTimeout(10_000);
  try {
    const begin = performance.now();
    const result = core.task(progress(taskId));
    const elapsed = performance.now() - begin;
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(probe.attempts()).toBe(8);
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    setDefaultLockTimeout(budget);
  }
});

test("Given slow competing writes on every attempt, When the lock budget elapses, Then retries stop before the attempt cap", () => {
  const { root, store, core, taskId } = started();
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    () => true,
  );
  const budget = defaultLockTimeout();
  setDefaultLockTimeout(100);
  try {
    const begin = performance.now();
    const result = core.task(progress(taskId));
    const elapsed = performance.now() - begin;
    expect(result).toMatchObject({ ok: false, code: "busy" });
    // 40 ms per interleaved write against a 100 ms budget: the deadline, not
    // the 8-attempt cap, ends the loop. The wall-clock bound is loose because
    // CI runners stretch the sleeps; the attempt count is the real check.
    expect(probe.attempts()).toBeLessThan(8);
    expect(elapsed).toBeLessThan(1_500);
  } finally {
    setDefaultLockTimeout(budget);
  }
});

test("Given a first attempt slower than the lock budget, When it loses the race, Then at least one retry still runs", () => {
  const { root, store, core, taskId } = started();
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const budget = defaultLockTimeout();
  setDefaultLockTimeout(100);
  try {
    expect(core.task(progress(taskId))).toMatchObject({ ok: true });
    expect(probe.attempts()).toBe(2);
  } finally {
    setDefaultLockTimeout(budget);
  }
});

const startOther = (root: string) => {
  const other = new WorkitCore(new TaskStore(root), context(root));
  expect(
    other.task({ schemaVersion: 1, action: "start", intent: taskStartRequest().intent }).ok,
  ).toBe(true);
};

test("Given an explicit current expectedRevision and an unrelated task start, When writer.acquire commits, Then the engine-filled workspace revision is retried and the call succeeds", () => {
  const { root, store, core, taskId } = started();
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const probe = interleave(
    store,
    () => startOther(root),
    (call) => call === 1,
  );
  const result = core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId,
    expectedRevision: task.data.revision,
  });
  expect(result).toMatchObject({ ok: true });
  expect(probe.attempts()).toBe(2);
});

test("Given an explicit current expectedWorkspaceRevision and a competing task write, When writer.acquire commits, Then the engine-filled task revision is retried and the call succeeds", () => {
  const { root, store, core, taskId } = started();
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const result = core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId,
    expectedWorkspaceRevision: workspace.data.revision,
  });
  expect(result).toMatchObject({ ok: true });
  expect(probe.attempts()).toBe(2);
});

test("Given an explicit expectedWorkspaceRevision that a task start invalidates, When writer.acquire commits, Then revision_conflict reports the workspace revisions without retry", () => {
  const { root, store, core, taskId } = started();
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const probe = interleave(
    store,
    () => startOther(root),
    (call) => call === 1,
  );
  const result = core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId,
    expectedWorkspaceRevision: workspace.data.revision,
  });
  expect(result).toMatchObject({
    ok: false,
    code: "revision_conflict",
    details: { expectedWorkspaceRevision: workspace.data.revision },
  });
  if (result.ok) throw new Error("conflict expected");
  expect(result.details.actualWorkspaceRevision).toBeDefined();
  expect(result.details.actualRevision).toBeUndefined();
  expect(probe.attempts()).toBe(1);
});

test("Given a changed import source, When the import omits revisions, Then the semantic revision_conflict is returned without retry", () => {
  const source = started();
  const destination = mkdtempSync(join(tmpdir(), "workit-retry-dest-"));
  const destinationStore = new TaskStore(destination);
  const destinationCore = new WorkitCore(destinationStore, context(destination));
  const exportBundle = () => {
    const exported = source.core.state({
      schemaVersion: 1,
      action: "export",
      taskId: source.taskId,
    });
    if (!exported.ok) throw new Error(exported.error);
    return exported.data;
  };
  expect(
    destinationCore.state({
      schemaVersion: 1,
      action: "import",
      bundle: exportBundle(),
      authorityRefs: [],
    }),
  ).toMatchObject({ ok: true });
  expect(source.core.task(progress(source.taskId)).ok).toBe(true);
  const changed = exportBundle();
  let imports = 0;
  const original = destinationStore.importTask.bind(destinationStore);
  destinationStore.importTask = (input) => {
    imports += 1;
    return original(input);
  };
  const result = destinationCore.state({
    schemaVersion: 1,
    action: "import",
    bundle: changed,
    authorityRefs: [],
  });
  expect(result).toMatchObject({
    ok: false,
    code: "revision_conflict",
    error: expect.stringContaining("source task export changed"),
  });
  expect(imports).toBe(1);
});

test("Given a workspace write during state.recover with omitted revisions, When recovery commits, Then it stays a single compare-and-swap attempt", () => {
  const { root, store, taskId } = started();
  const core = new WorkitCore(store, {
    ...context(root),
    nativeRecovery: () =>
      success(null, null, {
        state: "accounted_for" as const,
        pid: 0,
        processStart: null,
        ownerDigest: null,
      }),
  });
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  expect(
    store.mutateTask(taskId, task.data.revision, (value, mutation) =>
      success(mutation.revision, null, value),
    ).ok,
  ).toBe(true);
  const candidates = store.recoveryCandidates();
  if (!candidates.ok) throw new Error(candidates.error);
  const candidate = candidates.data.find((item) => item.target === "task");
  if (!candidate) throw new Error("missing recovery snapshot");
  writeFileSync(join(root, ".workit", "tasks", `${taskId}.json`), "{broken");
  let recoveries = 0;
  const original = store.recoverTask.bind(store);
  store.recoverTask = (...args: Parameters<TaskStore["recoverTask"]>) => {
    recoveries += 1;
    startOther(root);
    return original(...args);
  };
  const result = core.state({
    schemaVersion: 1,
    action: "recover",
    taskId,
    target: "task",
    expectedBytes: sha256("{broken"),
    snapshotDigest: candidate.digest,
    reason: "crash recovery",
    authorityRefs: [],
  });
  expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(recoveries).toBe(1);
});

const receiptVerifier = (calls: unknown[]): NativeAuthorityVerifier => ({
  verifyDecision: (input: Record<string, unknown>) => {
    calls.push(input);
    return success(null, null, {
      kind: "host_observed" as const,
      host: "workit_cli" as const,
      session: { kind: "host" as const, host: "workit_cli" as const, handle: "test" },
      workerId: null,
      receipts: [{ kind: "host" as const, host: "workit_cli" as const, handle: "receipt-once" }],
    });
  },
  verifyAction: () => failure("permission_denied", "not used"),
});

test("Given a competing write during a receipted decision, When the caller omitted revisions, Then the decision is recorded once and the receipt is not lost", () => {
  const { root, store, taskId } = started();
  const calls: unknown[] = [];
  const core = new WorkitCore(store, { ...context(root), nativeAuthority: receiptVerifier(calls) });
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const result = core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId,
      purpose: "action",
      binding: {
        taskId,
        workspaceId: workspace.data.id,
        scope: task.data.intent.data.scope,
        presented: "run the bounded action",
        approvedContent: "run the bounded action",
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    { kind: "decision" },
  );
  expect(result).toMatchObject({
    ok: true,
    data: { provenance: { kind: "host_observed", receipts: [{ handle: "receipt-once" }] } },
  });
  expect(probe.attempts()).toBe(2);
  expect(calls.length).toBe(1);
  const after = store.readTask(taskId);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.decisions.length).toBe(1);
});

const closeTask = (root: string, taskId: string) => {
  const closer = new WorkitCore(new TaskStore(root), context(root));
  expect(
    closer.task({
      schemaVersion: 1,
      action: "close",
      taskId,
      outcome: "stopped",
      summary: "closed by a competing session",
      decisionIds: [],
    }).ok,
  ).toBe(true);
};

const decisionRequest = (
  store: TaskStore,
  taskId: string,
  overrides: { purpose?: string; response?: string; binding?: Record<string, unknown> } = {},
) => {
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  return {
    schemaVersion: 1,
    action: "record",
    taskId,
    purpose: overrides.purpose ?? "action",
    binding: {
      taskId,
      workspaceId: workspace.data.id,
      scope: task.data.intent.data.scope,
      presented: "run the bounded action",
      approvedContent: "run the bounded action",
      contentRefs: [],
      ...overrides.binding,
    },
    response: overrides.response ?? "approved",
    requirementIds: [],
  };
};

for (const kind of ["receipted", "stated", "plain"] as const)
  test(`Given the task closes between attempts, When a ${kind} decision retries, Then it is refused and nothing lands on the closed task`, () => {
    const { root, store, taskId } = started();
    const core = new WorkitCore(store, { ...context(root), nativeAuthority: receiptVerifier([]) });
    const probe = interleave(
      store,
      () => closeTask(root, taskId),
      (call) => call === 1,
    );
    const result =
      kind === "receipted"
        ? core.observeDecision(decisionRequest(store, taskId), { kind: "decision" })
        : kind === "stated"
          ? core.observeDecision(
              decisionRequest(store, taskId, {
                purpose: "design",
                response: "stated",
                binding: { statedChoice: { ref: "question-call-1", text: "take the second" } },
              }),
              undefined,
            )
          : core.decision(decisionRequest(store, taskId));
    expect(result).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(probe.attempts()).toBe(1);
    const after = store.readTask(taskId);
    if (!after.ok) throw new Error(after.error);
    expect(after.data.status).toBe("closed");
    expect(after.data.decisions).toEqual([]);
  });

test("Given a retry whose re-read misses the closure, When the decision commits, Then the in-lock check still refuses the closed task", () => {
  const { root, store, taskId } = started();
  const core = new WorkitCore(store, context(root));
  const request = decisionRequest(store, taskId);
  const readTask = store.readTask.bind(store);
  const mutateTask = store.mutateTask.bind(store);
  let commits = 0;
  let spoof = false;
  // The engine's re-read after the lost race reports the task still active
  // (a check-then-commit gap); only the read under the lock sees the truth.
  store.readTask = (id: string) => {
    const value = readTask(id);
    if (!spoof || !value.ok) return value;
    spoof = false;
    return { ...value, data: { ...value.data, status: "active" as const } };
  };
  store.mutateTask = (...args: Parameters<TaskStore["mutateTask"]>) => {
    commits += 1;
    if (commits === 1) closeTask(root, taskId);
    const result = mutateTask(...args);
    if (commits === 1) spoof = true;
    return result;
  };
  expect(core.decision(request)).toMatchObject({ ok: false, code: "invalid_transition" });
  expect(commits).toBe(2);
  const after = readTask(taskId);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.decisions).toEqual([]);
});

const gitRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-retry-standing-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    spawnSync("git", args, { cwd: root });
  writeFileSync(join(root, "base.txt"), "base\n");
  spawnSync("git", ["add", "base.txt"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
};

const withStanding = (
  run: (value: {
    root: string;
    configDir: string;
    store: TaskStore;
    core: WorkitCore;
    taskId: string;
  }) => void,
) => {
  const root = gitRepo();
  const configDir = mkdtempSync(join(tmpdir(), "workit-retry-cfg-"));
  const rule = (classes: string[]) =>
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "t", glob: `${root}/**`, autoApprove: classes, vcs: { provider: "github" } },
        ],
      }),
    );
  rule(["commit"]);
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  try {
    const store = new TaskStore(root);
    const core = new WorkitCore(store, context(root));
    const begun = core.task(taskStartRequest());
    if (!begun.ok) throw new Error(begun.error);
    const taskId = (begun.data as { id: string }).id;
    expect(core.writer({ schemaVersion: 1, action: "acquire", taskId }).ok).toBe(true);
    run({ root, configDir, store, core, taskId });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
};

const standingRequest = (store: TaskStore, taskId: string) =>
  decisionRequest(store, taskId, {
    binding: {
      presented: "auto",
      approvedContent: JSON.stringify({
        operation: "git.commit",
        payload: { message: "auto one", resolved: { branch: "main" } },
      }),
      standing: { workspace: "t", class: "commit" },
    },
  });

test("Given the standing rule is removed between attempts, When a standing decision retries, Then it is re-verified and not recorded", () => {
  withStanding(({ root, configDir, store, core, taskId }) => {
    const competitor = new WorkitCore(new TaskStore(root), context(root));
    const probe = interleave(
      store,
      () => {
        expect(competitor.task(progress(taskId)).ok).toBe(true);
        writeFileSync(join(configDir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
      },
      (call) => call === 1,
    );
    const result = core.observeStandingDecision(standingRequest(store, taskId));
    expect(result).toMatchObject({ ok: false, code: "permission_denied" });
    expect(probe.attempts()).toBe(1);
    const after = store.readTask(taskId);
    if (!after.ok) throw new Error(after.error);
    expect(after.data.decisions).toEqual([]);
  });
});

test("Given the standing rule changes but stays live between attempts, When a standing decision retries, Then it records the re-verified provenance", () => {
  withStanding(({ root, configDir, store, core, taskId }) => {
    const competitor = new WorkitCore(new TaskStore(root), context(root));
    const before = standingReceiptFor(root, "t", "commit");
    const probe = interleave(
      store,
      () => {
        expect(competitor.task(progress(taskId)).ok).toBe(true);
        writeFileSync(
          join(configDir, "workspaces.json"),
          JSON.stringify({
            workspaces: [
              {
                name: "t",
                glob: `${root}/**`,
                autoApprove: ["commit", "branch"],
                vcs: { provider: "github" },
              },
            ],
          }),
        );
      },
      (call) => call === 1,
    );
    const result = core.observeStandingDecision(standingRequest(store, taskId));
    expect(result).toMatchObject({ ok: true });
    expect(probe.attempts()).toBe(2);
    if (!result.ok) throw new Error(result.error);
    const after = standingReceiptFor(root, "t", "commit");
    expect(after.configDigest).not.toBe(before.configDigest);
    expect(result.data.provenance.receipts).toEqual([after]);
  });
});

const coreModule = resolve(import.meta.dir, "../../packages/workit-core/src/core.ts");
const writerScript = (root: string, taskId: string, label: string, calls: number) => `
import { TaskStore, WorkitCore } from ${JSON.stringify(coreModule)};
const root = ${JSON.stringify(root)};
const core = new WorkitCore(new TaskStore(root), {
  root,
  caller: { host: "workit_cli", actor: ${JSON.stringify(label)} },
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});
const codes = {};
const claims = [];
let starts = 0;
for (let call = 0; call < ${calls}; call += 1) {
  const claim = ${JSON.stringify(label)} + "-" + call;
  const result = call % 5 === 4
    ? core.task({
        schemaVersion: 1,
        action: "start",
        intent: { objective: claim, scope: ${JSON.stringify(scope())}, authorityRefs: [{ kind: "external", url: "https://example.test/r" }] },
      })
    : core.finding({
        schemaVersion: 1,
        action: "record",
        taskId: ${JSON.stringify(taskId)},
        claim,
        consequence: "contention probe",
        scope: ${JSON.stringify(scope())},
        refs: [],
      });
  const code = result.ok ? "ok" : result.code;
  codes[code] = (codes[code] ?? 0) + 1;
  if (result.ok && call % 5 === 4) starts += 1;
  else if (result.ok) claims.push(claim);
}
process.stdout.write(JSON.stringify({ codes, claims, starts }));
`;

test("Given four processes writing without revisions, When they contend, Then no revision_conflict or recovery_required surfaces and every success is applied exactly once", async () => {
  const { root, store, taskId } = started();
  const runs = await Promise.all(
    ["p0", "p1", "p2", "p3"].map(
      (label) =>
        new Promise<{ codes: Record<string, number>; claims: string[]; starts: number }>(
          (done, fail) => {
            const child = spawn(process.execPath, ["-e", writerScript(root, taskId, label, 30)], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("close", () => {
              try {
                done(JSON.parse(out));
              } catch {
                fail(new Error(`writer output: ${out} ${err}`));
              }
            });
          },
        ),
    ),
  );
  const totals: Record<string, number> = {};
  for (const run of runs)
    for (const [code, count] of Object.entries(run.codes))
      totals[code] = (totals[code] ?? 0) + count;
  expect(Object.keys(totals).filter((code) => code !== "ok" && code !== "busy")).toEqual([]);
  expect((totals.ok ?? 0) + (totals.busy ?? 0)).toBe(120);
  // How often the store's in-process lock budget runs out (busy) depends on
  // runner speed — a windows-latest run measured 74 ok / 46 busy — so this is
  // a progress floor, not a throughput target.
  expect(totals.ok ?? 0).toBeGreaterThanOrEqual(40);
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const recorded = task.data.findings.map((entry) => entry.data.claim).toSorted();
  const reported = runs.flatMap((run) => run.claims).toSorted();
  // No lost update and no double apply: the record holds exactly the
  // findings the callers were told succeeded.
  expect(recorded).toEqual(reported);
  const tasks = store.listTasks();
  if (!tasks.ok) throw new Error(tasks.error);
  expect(tasks.data.length).toBe(1 + runs.reduce((sum, run) => sum + run.starts, 0));
}, 60_000);
