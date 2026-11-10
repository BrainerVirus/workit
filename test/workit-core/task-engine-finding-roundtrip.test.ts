import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import { caller, scope, taskStartRequest } from "./task-fixtures";

// #317 (absorbs #319), #647 and retro 2026-11-10 B5: a finding round-trips in
// one turn, and every refusal on the way names its fix.

const now = "2026-01-01T00:00:00Z";
const srcRef = { kind: "file", path: "src/retry.ts", digest: null } as const;

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now,
  ...options,
});

const verifier = (): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller: actual }) =>
    success(null, null, {
      kind: "host_observed",
      host: actual.host,
      session: expected.session,
      workerId: expected.workerId,
    }),
});

/** A task whose lead started it, with paths `leadPaths`. */
const started = (leadPaths = ["."], host: "workit_cli" | "pi" = "workit_cli") => {
  const root = mkdtempSync(join(tmpdir(), "workit-finding-roundtrip-"));
  const store = new TaskStore(root);
  const lead = new WorkitCore(
    store,
    context(root, { caller: caller({ host }), nativeWorker: verifier() }),
  );
  const result = lead.task(
    taskStartRequest({
      intent: { objective: "x", scope: scope({ paths: leadPaths }), authorityRefs: [] },
    }),
  );
  if (!result.ok) throw new Error(result.error);
  const taskId = (result.data as { id: string }).id;
  return { root, store, lead, taskId };
};

/** A running reviewer helper on `src`, as OpenCode and Pi launch one. */
const runningReviewer = (world: ReturnType<typeof started>) => {
  const { store, lead, taskId, root } = world;
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const assigned = lead.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedWorkspaceRevision: workspace.data.revision,
    assignment: {
      role: "reviewer",
      objective: "review src",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const task = store.readTask(taskId);
  const after = store.readWorkspace();
  if (!task.ok || !after.ok || !after.data) throw new Error("state missing");
  const running = lead.observeWorkerLifecycle({
    taskId,
    workerId: assigned.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: after.data.revision,
    state: "running",
    session: { kind: "host", host: "workit_cli", handle: "reviewer-session" },
    observation: { event: "worker-started" },
  });
  if (!running.ok) throw new Error(running.error);
  return new WorkitCore(
    store,
    context(root, { caller: caller({ actor: "reviewer-session" }), workerId: assigned.data.id }),
  );
};

const recordFinding = (core: WorkitCore, taskId: string) => {
  const recorded = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId,
    claim: "retry loop swallows the timeout",
    consequence: "a hung call reads as success",
    scope: scope({ paths: ["src"] }),
    candidateId: null,
    refs: [srcRef],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  return recorded.data.id;
};

const recordEvidence = (
  core: WorkitCore,
  taskId: string,
  kind: "check" | "investigation" = "check",
  refs: unknown[] = [srcRef],
) => {
  const recorded = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    evidence: {
      kind,
      claim: "the timeout now propagates",
      requirementIds: [],
      result: "passed",
      summary: "bun test test/retry.test.ts",
      refs,
      exitCode: kind === "check" ? 0 : null,
      reviewContext: null,
    },
  });
  if (!recorded.ok) throw new Error(recorded.error);
  return recorded.data.id;
};

const resolve = (
  core: WorkitCore,
  taskId: string,
  findingId: string,
  evidenceIds: string[],
  disposition = "fixed",
) =>
  core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId,
    findingId,
    disposition,
    reason: "the loop rethrows now",
    evidenceIds,
    decisionIds: [],
  });

test("Given a reviewer that recorded a finding and later passing check evidence, When it resolves the finding as fixed with that evidence, Then the resolve succeeds in one call", () => {
  const world = started();
  const reviewer = runningReviewer(world);
  const findingId = recordFinding(reviewer, world.taskId);
  const checkId = recordEvidence(reviewer, world.taskId);
  const resolved = resolve(reviewer, world.taskId, findingId, [checkId]);
  expect(resolved).toMatchObject({
    ok: true,
    data: { data: { disposition: "fixed", resolution: { evidenceIds: [checkId] } } },
  });
});

test("Given a helper, When it resolves a finding it did not record or cites evidence it did not record, Then it is refused", () => {
  const world = started();
  const reviewer = runningReviewer(world);
  const leadFinding = recordFinding(world.lead, world.taskId);
  const ownCheck = recordEvidence(reviewer, world.taskId);
  expect(resolve(reviewer, world.taskId, leadFinding, [ownCheck])).toMatchObject({
    ok: false,
    code: "permission_denied",
    error: "helpers resolve only the findings they recorded; the lead resolves this one",
  });

  const ownFinding = recordFinding(reviewer, world.taskId);
  const leadCheck = recordEvidence(world.lead, world.taskId);
  const borrowed = resolve(reviewer, world.taskId, ownFinding, [leadCheck]);
  expect(borrowed).toMatchObject({ ok: false, code: "permission_denied" });
  if (borrowed.ok) throw new Error("expected a refusal");
  expect(borrowed.error).toContain("a helper resolves with evidence it recorded");
  expect(borrowed.error).not.toContain(leadCheck);

  const none = resolve(reviewer, world.taskId, ownFinding, []);
  expect(none).toMatchObject({ ok: false, code: "permission_denied" });
  expect(resolve(reviewer, world.taskId, ownFinding, [], "open")).toMatchObject({
    ok: false,
    code: "permission_denied",
  });
});

test("Given a tool host and a resolve with unrelated or missing evidence, When refused, Then the error names an evidence id that fits or the command that records one", () => {
  const world = started(["."], "pi");
  const findingId = recordFinding(world.lead, world.taskId);
  const missing = resolve(world.lead, world.taskId, findingId, [], "dismissed");
  expect(missing).toMatchObject({ ok: false, code: "permission_denied" });
  if (missing.ok) throw new Error("expected a refusal");
  expect(missing.error).toContain("none recorded in this task yet: workit evidence record");

  const unrelated = recordEvidence(world.lead, world.taskId, "investigation", [
    { kind: "file", path: "other.ts", digest: null },
  ]);
  const check = recordEvidence(world.lead, world.taskId);
  const wrong = resolve(world.lead, world.taskId, findingId, [unrelated]);
  expect(wrong).toMatchObject({ ok: false, code: "permission_denied" });
  if (wrong.ok) throw new Error("expected a refusal");
  expect(wrong.error).toContain(`evidence in this task that fits: ${check}`);
  expect(wrong.details?.guidance).toContain(check);
  expect(resolve(world.lead, world.taskId, findingId, [check])).toMatchObject({ ok: true });
});

test.each([
  ["resolve", { id: "0123456789ab", resolution: "fixed" }, "findingId"],
  ["record", { severity: "high", title: "t", file: "src/a.ts", branch: "b" }, "claim"],
])(
  "Given a finding %s payload with wrong keys, When refused, Then the error prints one valid example payload for that action",
  (action, keys, needed) => {
    const world = started();
    const refused = world.lead.finding({ schemaVersion: 1, action, taskId: world.taskId, ...keys });
    expect(refused).toMatchObject({ ok: false, code: "invalid_input" });
    if (refused.ok) throw new Error("expected a refusal");
    const example = refused.error.match(/Example: (\{.*\})$/u)?.[1];
    expect(example).toBeDefined();
    const payload = JSON.parse(example!) as Record<string, unknown>;
    expect(payload).toMatchObject({ action });
    expect(payload).toHaveProperty(needed);
    for (const key of Object.keys(keys)) expect(refused.error).toContain(key);
  },
);

test("Given lead paths [apps/**] and a worker scope [apps/web/**, lib/x/**], When assign is refused, Then the reason names lib/x/** and the lead globs, not the whole arrays", () => {
  const world = started(["apps/**"]);
  const workspace = world.store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const refused = world.lead.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: world.taskId,
    expectedWorkspaceRevision: workspace.data.revision,
    assignment: {
      role: "implementer",
      objective: "build",
      scope: scope({ paths: ["apps/web/**", "lib/x/**"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  expect(refused).toMatchObject({
    ok: false,
    code: "permission_denied",
    error: "worker assignment is outside task scope: lib/x/** is not inside lead paths apps/**",
  });
  if (refused.ok) throw new Error("expected a refusal");
  expect(JSON.stringify(refused)).not.toContain("apps/web/**");
});
