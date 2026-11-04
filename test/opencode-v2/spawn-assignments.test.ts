// #640: a lead that assigns several workers and launches them in one turn.
// Each OpenCode `subagent` call binds the assignment its prompt is for, the
// calls run concurrently, and no child ever takes another child's brief.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { createV2Lifecycle, type V2SessionInfo } from "@/packages/workit-opencode/src/v2/lifecycle";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

type Role = "reviewer" | "investigator" | "implementer";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-v2-spawn-"));
  for (const args of [
    ["init", "-q", "-b", "feature/spawn"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const store = new TaskStore(root);
  let tick = 0;
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor: "lead" },
    capabilities: [],
    constraints: [],
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  const started = core.task(
    taskStartRequest({
      intent: { objective: "fan out", scope: scope({ paths: ["."] }), authorityRefs: [] },
    }),
  );
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const assign = (role: Role, objective: string, paths: string[]): string => {
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const assigned = core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      assignment: {
        role,
        objective,
        scope: scope({ paths }),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
    });
    if (!assigned.ok) throw new Error(assigned.error);
    return assigned.data.id;
  };
  const sessions = new Map<string, V2SessionInfo>([["lead", { id: "lead", directory: root }]]);
  const lifecycle = createV2Lifecycle({
    root,
    getSession: async (sessionID) => sessions.get(sessionID) ?? null,
  });
  const worker = (id: string) => {
    const task = store.readTask(taskId);
    if (!task.ok) throw new Error(task.error);
    const found = task.data.workers.find((entry) => entry.id === id);
    if (!found) throw new Error(`worker ${id} missing`);
    return found.data;
  };
  const launch = (id: string, input: Record<string, unknown>) =>
    lifecycle.executeBefore({ tool: "subagent", sessionID: "lead", id, input });
  const created = (child: string, title?: string) => {
    sessions.set(child, { id: child, parentID: "lead", directory: root });
    return lifecycle.handleEvent({
      type: "session.created",
      data: {
        sessionID: child,
        parentID: "lead",
        location: { directory: root },
        ...(title === undefined ? {} : { title }),
      },
    });
  };
  const completed = (id: string, child: string) => {
    sessions.set(child, { id: child, parentID: "lead", directory: root });
    return lifecycle.executeAfter({
      tool: "subagent",
      sessionID: "lead",
      id,
      input: {},
      status: "completed",
      result: { metadata: { sessionID: child } },
    });
  };
  return {
    root,
    assign,
    worker,
    launch,
    created,
    completed,
    lifecycle,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

/** A fanout-style brief: the lines a lead pastes into the subagent prompt. */
const brief = (goal: string, paths: string[]) =>
  `MODE: new\nGOAL: ${goal}\nSCOPE: ${paths.join(", ")}\nTIER: standard\nWORKTREE: /tmp/wt`;

const SLICES = [
  { goal: "document the release flow", paths: ["docs/**"] },
  { goal: "harden the cli argument parser", paths: ["src/cli/**"] },
  { goal: "cover the parser with tests", paths: ["test/cli/**"] },
] as const;

test("Given three workers with three briefs, When the lead launches all three in one turn, Then each child binds its own brief", async () => {
  const value = fixture();
  try {
    const ids = SLICES.map((slice) => value.assign("implementer", slice.goal, [...slice.paths]));
    // The lead launches in the reverse of assignment order: FIFO would swap them.
    await Promise.all(
      [2, 1, 0].map((index) =>
        value.launch(`call_${index}`, {
          description: `slice ${index}`,
          prompt: brief(SLICES[index].goal, [...SLICES[index].paths]),
          agent: "general",
        }),
      ),
    );
    expect(value.lifecycle.pendingLaunch("lead")).toBe(true);
    // Children appear out of order; each title is its call's description.
    await value.created("ses_b", "slice 1");
    await value.created("ses_c", "slice 2");
    await value.created("ses_a", "slice 0");
    expect(value.worker(ids[0])).toMatchObject({ state: "running", session: { handle: "ses_a" } });
    expect(value.worker(ids[1])).toMatchObject({ state: "running", session: { handle: "ses_b" } });
    expect(value.worker(ids[2])).toMatchObject({ state: "running", session: { handle: "ses_c" } });
    expect(value.lifecycle.pendingLaunch("lead")).toBe(false);
  } finally {
    value.cleanup();
  }
});

test("Given concurrent launches with one description, When their children appear, Then the titles tell them apart and each binds its own worker", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review the docs slice", ["docs/**"]);
    const b = value.assign("reviewer", "review the source slice", ["src/**"]);
    const first = { description: "review", prompt: "review the docs slice", agent: "general" };
    const second = { description: "review", prompt: "review the source slice", agent: "general" };
    await Promise.all([value.launch("call_a", first), value.launch("call_b", second)]);
    // The second call's description gained its worker id, so the child titles differ.
    expect(second.description).toBe(`review [${b}]`);
    expect(first.description).toBe("review");
    await value.created("ses_b", second.description);
    await value.created("ses_a", first.description);
    expect(value.worker(a).session).toMatchObject({ handle: "ses_a" });
    expect(value.worker(b).session).toMatchObject({ handle: "ses_b" });
  } finally {
    value.cleanup();
  }
});

test("Given two open launches and an untitled child, When it appears, Then it waits for its own call's result instead of taking a launch", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review the docs slice", ["docs/**"]);
    const b = value.assign("reviewer", "review the source slice", ["src/**"]);
    await value.launch("call_a", { prompt: `WORKER: ${a}` });
    await value.launch("call_b", { prompt: `WORKER: ${b}` });
    await value.created("ses_b");
    expect(value.worker(a).state).toBe("assigned");
    expect(value.worker(b).state).toBe("assigned");
    await value.completed("call_b", "ses_b");
    await value.completed("call_a", "ses_a");
    expect(value.worker(a).session).toMatchObject({ handle: "ses_a" });
    expect(value.worker(b).session).toMatchObject({ handle: "ses_b" });
  } finally {
    value.cleanup();
  }
});

test("Given a child bound to one launch, When another call reports it as its child, Then that call does not take it", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review the docs slice", ["docs/**"]);
    const b = value.assign("reviewer", "review the source slice", ["src/**"]);
    await value.launch("call_a", { description: "docs", prompt: `WORKER: ${a}` });
    await value.launch("call_b", { description: "src", prompt: `WORKER: ${b}` });
    await value.created("ses_a", "docs");
    await value.completed("call_b", "ses_a");
    expect(value.worker(a).session).toMatchObject({ handle: "ses_a" });
    expect(value.worker(b).state).toBe("assigned");
    expect(value.lifecycle.pendingLaunch("lead")).toBe(true);
  } finally {
    value.cleanup();
  }
});

test("Given reviewers A (docs) then B (src), When the lead launches one for src, Then B binds, not the older A (#640 repro)", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review docs", ["docs/**"]);
    const b = value.assign("reviewer", "review src", ["src/**"]);
    await value.launch("call_1", { prompt: "ROLE: reviewer\nSCOPE: src/**" });
    await value.completed("call_1", "ses_1");
    expect(value.worker(b).session).toMatchObject({ handle: "ses_1" });
    expect(value.worker(a).state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given the same brief assigned twice, When the lead launches it, Then the newer assignment binds and the stale one stays assigned", async () => {
  const value = fixture();
  try {
    const stale = value.assign("implementer", SLICES[0].goal, [...SLICES[0].paths]);
    const fresh = value.assign("implementer", SLICES[0].goal, [...SLICES[0].paths]);
    await value.launch("call_1", { prompt: brief(SLICES[0].goal, [...SLICES[0].paths]) });
    await value.completed("call_1", "ses_1");
    expect(value.worker(fresh).session).toMatchObject({ handle: "ses_1" });
    expect(value.worker(stale).state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given a stale assignment and a newer one for another slice, When the lead launches the newer brief, Then the stale one does not win", async () => {
  const value = fixture();
  try {
    const stale = value.assign("implementer", SLICES[0].goal, [...SLICES[0].paths]);
    const fresh = value.assign("implementer", SLICES[1].goal, [...SLICES[1].paths]);
    await value.launch("call_1", { prompt: brief(SLICES[1].goal, [...SLICES[1].paths]) });
    await value.completed("call_1", "ses_1");
    expect(value.worker(fresh).session).toMatchObject({ handle: "ses_1" });
    expect(value.worker(stale).state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given two assignments and a launch that names neither, Then it is refused before anything is recorded, naming both workers", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review docs", ["docs/**"]);
    const b = value.assign("reviewer", "review src", ["src/**"]);
    const refused = value.launch("call_1", { prompt: "please review" });
    await expect(refused).rejects.toThrow(/fits 2 assigned Workit workers.*WORKER: <id>/);
    await expect(refused).rejects.toThrow(new RegExp(`${a}.*${b}`));
    expect(value.lifecycle.pendingLaunch("lead")).toBe(false);
    expect(value.worker(a).state).toBe("assigned");
    expect(value.worker(b).state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given a WORKER line, Then the named worker binds even when it is the older one", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review docs", ["docs/**"]);
    value.assign("reviewer", "review src", ["src/**"]);
    await value.launch("call_1", { prompt: `WORKER: ${a}\nreview it` });
    await value.completed("call_1", "ses_1");
    expect(value.worker(a).session).toMatchObject({ handle: "ses_1" });
  } finally {
    value.cleanup();
  }
});

test("Given a worker already being launched, When a second call names it, Then that call is refused and the other worker is not taken", async () => {
  const value = fixture();
  try {
    const a = value.assign("reviewer", "review docs", ["docs/**"]);
    const b = value.assign("reviewer", "review src", ["src/**"]);
    await value.launch("call_1", { prompt: `WORKER: ${a}` });
    await expect(value.launch("call_2", { prompt: `WORKER: ${a}` })).rejects.toThrow(
      new RegExp(`worker ${a} is already being launched`),
    );
    expect(value.worker(b).state).toBe("assigned");
    // B is still free for its own launch.
    await value.launch("call_3", { prompt: `WORKER: ${b}` });
    await value.completed("call_3", "ses_b");
    expect(value.worker(b).session).toMatchObject({ handle: "ses_b" });
  } finally {
    value.cleanup();
  }
});
