import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import {
  defaultLockTimeout,
  setDefaultLockTimeout,
} from "@/packages/workit-core/src/core/store-lock";
import { caller, scope, taskStartRequest } from "./task-fixtures";

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
    progress(taskId, {
      progress: { summary: "mine", nextAction: null, blockers: [] },
    }),
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
    progress(taskId, {
      expectedRevision: "00000000-0000-4000-8000-000000000000",
    }),
  );
  expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(probe.attempts()).toBe(1);
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
    // The attempt cap, not the 10 s lock budget, ended the retries; wall time
    // stays runner-independent (slow Windows runners took ~2.7 s here).
    expect(elapsed).toBeLessThan(10_000);
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
    other.task({
      schemaVersion: 1,
      action: "start",
      intent: taskStartRequest().intent,
    }).ok,
  ).toBe(true);
};

test("Given an explicit current expectedRevision and an unrelated task start, When a pause commits, Then the engine-filled workspace revision is retried and the call succeeds", () => {
  const { root, store, core, taskId } = started();
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const probe = interleave(
    store,
    () => startOther(root),
    (call) => call === 1,
  );
  const result = core.task({
    schemaVersion: 1,
    action: "pause",
    taskId,
    reason: "coupled retry probe",
    expectedRevision: task.data.revision,
  });
  expect(result).toMatchObject({ ok: true });
  expect(probe.attempts()).toBe(2);
});

test("Given an explicit current expectedWorkspaceRevision and a competing task write, When a pause commits, Then the engine-filled task revision is retried and the call succeeds", () => {
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
  const result = core.task({
    schemaVersion: 1,
    action: "pause",
    taskId,
    reason: "coupled retry probe",
    expectedWorkspaceRevision: workspace.data.revision,
  });
  expect(result).toMatchObject({ ok: true });
  expect(probe.attempts()).toBe(2);
});

test("Given an explicit expectedWorkspaceRevision that a task start invalidates, When a pause commits, Then revision_conflict reports the workspace revisions without retry", () => {
  const { root, store, core, taskId } = started();
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const probe = interleave(
    store,
    () => startOther(root),
    (call) => call === 1,
  );
  const result = core.task({
    schemaVersion: 1,
    action: "pause",
    taskId,
    reason: "coupled retry probe",
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
  });
  expect(result).toMatchObject({
    ok: false,
    code: "revision_conflict",
    error: expect.stringContaining("source task export changed"),
  });
  expect(imports).toBe(1);
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
  overrides: {
    purpose?: string;
    response?: string;
    binding?: Record<string, unknown>;
  } = {},
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
      contentRefs: [],
      ...overrides.binding,
    },
    response: overrides.response ?? "approved",
    requirementIds: [],
  };
};

test("Given a competing write during a decision, When the caller omitted revisions, Then the decision is recorded once", () => {
  const { root, store, core, taskId } = started();
  const request = decisionRequest(store, taskId);
  const competitor = new WorkitCore(new TaskStore(root), context(root));
  const probe = interleave(
    store,
    () => {
      expect(competitor.task(progress(taskId)).ok).toBe(true);
    },
    (call) => call === 1,
  );
  const result = core.decision(request);
  expect(result).toMatchObject({
    ok: true,
    data: { provenance: { kind: "agent_reported" } },
  });
  expect(probe.attempts()).toBe(2);
  const after = store.readTask(taskId);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.decisions.length).toBe(1);
});

for (const kind of ["stated", "plain"] as const)
  test(`Given the task closes between attempts, When a ${kind} decision retries, Then it is refused and nothing lands on the closed task`, () => {
    const { root, store, taskId } = started();
    const core = new WorkitCore(store, context(root));
    const probe = interleave(
      store,
      () => closeTask(root, taskId),
      (call) => call === 1,
    );
    const result = core.decision(
      kind === "stated"
        ? decisionRequest(store, taskId, {
            purpose: "design",
            response: "stated",
            binding: {
              statedChoice: { ref: "question-call-1", text: "take the second" },
            },
          })
        : decisionRequest(store, taskId),
    );
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
  expect(core.decision(request)).toMatchObject({
    ok: false,
    code: "invalid_transition",
  });
  expect(commits).toBe(2);
  const after = readTask(taskId);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.decisions).toEqual([]);
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
        new Promise<{
          codes: Record<string, number>;
          claims: string[];
          starts: number;
        }>((done, fail) => {
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
        }),
    ),
  );
  const totals: Record<string, number> = {};
  for (const run of runs)
    for (const [code, count] of Object.entries(run.codes))
      totals[code] = (totals[code] ?? 0) + count;
  expect(Object.keys(totals).filter((code) => code !== "ok" && code !== "busy")).toEqual([]);
  expect((totals.ok ?? 0) + (totals.busy ?? 0)).toBe(120);
  // How often the store's in-process lock budget runs out (busy, which is
  // retryable) depends on runner speed — windows-latest runs measured 74 and
  // 36 ok of 120 — so the floor is only that writes make progress at all;
  // the invariants are the ones above and below.
  expect(totals.ok ?? 0).toBeGreaterThan(0);
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const recorded = task.data.findings.map((entry) => entry.data.claim).toSorted();
  const reported = runs.flatMap((run) => run.claims).toSorted();
  // No lost update and no double apply: the record holds exactly the
  // findings the callers were told succeeded.
  expect(recorded).toEqual(reported);
  // Every ok call is either one finding or one task start.
  expect(recorded.length + runs.reduce((sum, run) => sum + run.starts, 0)).toBe(totals.ok ?? 0);
  const tasks = store.listTasks();
  if (!tasks.ok) throw new Error(tasks.error);
  expect(tasks.data.length).toBe(1 + runs.reduce((sum, run) => sum + run.starts, 0));
}, 60_000);
