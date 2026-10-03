import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TaskStore,
  WorkitCore,
  type Assessment,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import { assessment, caller, scope, taskStartRequest } from "./task-fixtures";

// Engine revision retry (design §0 item 14): a call that omitted every
// revision is not asking for compare-and-swap, so losing the race to another
// writer re-reads, re-checks and re-applies instead of surfacing
// revision_conflict. Explicit revisions keep strict CAS semantics.

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
  const begin = performance.now();
  const result = core.task(progress(taskId));
  const elapsed = performance.now() - begin;
  expect(result).toMatchObject({ ok: false, code: "busy" });
  expect(probe.attempts()).toBe(8);
  expect(elapsed).toBeLessThan(2_000);
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
