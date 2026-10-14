// Task, worker and decision state across branch switches (#264, #267 B3):
// worker commands follow the worker's task, decisions recorded on a base
// branch stay in view on branches cut from it, and stale evidence is one
// counted gap with one command.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import type { Provenance, TaskView } from "@/packages/workit-core/src/core/task-contract";
import { compactTaskContext } from "@/packages/workit-core/src/core/task-context";
import { sessionCompactContext } from "@/packages/workit-core/src/hooks/context";
import { caller } from "./task-fixtures";

setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};
const repo = (branch = "develop") => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-branch-attr-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "switch", "-q", "-c", branch);
  return root;
};
const provenance: Provenance = {
  kind: "agent_reported",
  host: "workit_cli",
  session: { kind: "host", host: "workit_cli", handle: "cli" },
  workerId: null,
};
const coreFor = (root: string) =>
  new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
const assignment = {
  role: "implementer" as const,
  objective: "do the slice",
  scope: { description: "checkout", paths: ["."], exclusions: [] },
  decisionIds: [],
  requirementIds: [],
  candidateId: null,
  stoppingCondition: "report",
};
const assignOnCurrentBranch = (root: string) => {
  const assigned = coreFor(root).worker({ schemaVersion: 1, action: "assign", assignment });
  if (!assigned.ok) throw new Error(assigned.error);
  const task = new TaskStore(root).implicitTask({ provenance, create: false });
  if (!task.ok || !task.data) throw new Error("no implicit task");
  return { workerId: assigned.data.id, taskId: task.data.task.id };
};

test("Given a worker assigned on branch A and the checkout switched to B, When it is cancelled without a task id, Then A's task is resolved from the worker and the worker stops", () => {
  const root = repo("feature/a");
  const { workerId, taskId } = assignOnCurrentBranch(root);
  git(root, "switch", "-q", "-c", "feature/b");
  // B has a task of its own too: the worker id, not the branch, picks the task.
  assignOnCurrentBranch(root);
  const cancelled = coreFor(root).worker({
    schemaVersion: 1,
    action: "cancel",
    workerId,
    reason: "branch switched",
  });
  expect(cancelled).toMatchObject({ ok: true, data: { id: workerId, data: { state: "stopped" } } });
  const record = new TaskStore(root).readTask(taskId);
  if (!record.ok) throw new Error(record.error);
  expect(record.data.workers.find((entry) => entry.id === workerId)?.data.state).toBe("stopped");
});

test("Given a cancel resolved from the worker that then fails, Then the error names the exact --task command for the worker's task", () => {
  const root = repo("feature/a");
  const { workerId, taskId } = assignOnCurrentBranch(root);
  git(root, "switch", "-q", "-c", "feature/b");
  const failed = coreFor(root).worker({
    schemaVersion: 1,
    action: "cancel",
    workerId,
    reason: "stale",
    expectedRevision: "00000000-0000-4000-8000-0000000000ff",
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.error).toContain(
    `workit worker cancel --task ${taskId} --payload '{"workerId":"${workerId}","reason":"stale"}'`,
  );
});

test("Given a worker on no open task, When it is cancelled without a task id, Then the error says how to find its task and the exact command to run", () => {
  const root = repo("feature/a");
  assignOnCurrentBranch(root);
  const unknown = "00000000-0000-4000-8000-0000000000aa";
  const failed = coreFor(root).worker({
    schemaVersion: 1,
    action: "cancel",
    workerId: unknown,
    reason: "gone",
  });
  expect(failed).toMatchObject({ ok: false, code: "not_found" });
  if (failed.ok) return;
  expect(failed.error).toContain("workit task status --all");
  expect(failed.error).toContain(
    `workit worker cancel --task <task-id> --payload '{"workerId":"${unknown}","reason":"gone"}'`,
  );
});

const recordDecision = (root: string, text: string) => {
  const store = new TaskStore(root);
  const task = store.implicitTask({ provenance, create: true });
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data || !workspace.ok || !workspace.data) throw new Error("no task");
  const recorded = coreFor(root).decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.data.task.id,
    purpose: "design",
    binding: {
      taskId: task.data.task.id,
      workspaceId: workspace.data.id,
      scope: task.data.task.intent.data.scope,
      presented: text,
      contentRefs: [],
    },
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  return task.data.task.id;
};
const session = { host: "claude_code", handle: "conversation-1" };
const turn = (root: string) => {
  const text = sessionCompactContext(new TaskStore(root), session, {
    root,
    caller: { host: "claude_code", actor: session.handle },
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return text === null
    ? null
    : (JSON.parse(text) as {
        objective: string;
        decisions: Array<{ choice: string; origin?: string }>;
      });
};

test("Given decisions recorded on develop, When working on a feature branch cut from it, Then the per-turn context shows them labelled with their origin and they survive switching back and forth", () => {
  const root = repo("develop");
  recordDecision(root, "use the shared table component");
  git(root, "switch", "-q", "-c", "feature/x");
  // No task on the feature branch yet: the inherited decisions alone.
  const inherited = turn(root);
  expect(inherited?.objective).toBe("no task on this branch yet");
  expect(inherited?.decisions).toEqual([
    expect.objectContaining({
      choice: "use the shared table component",
      origin: "branch develop",
    }),
  ]);
  // The feature branch's own decision comes first; the base's stays labelled.
  recordDecision(root, "split the PR in two");
  const both = turn(root)!;
  expect(both.decisions.map((entry) => [entry.choice, entry.origin ?? null])).toEqual([
    ["split the PR in two", null],
    ["use the shared table component", "branch develop"],
  ]);
  // Back on develop its decision is its own; on the feature branch again it
  // is inherited again: nothing vanishes on a switch.
  git(root, "switch", "-q", "develop");
  expect(turn(root)!.decisions.map((entry) => [entry.choice, entry.origin ?? null])).toEqual([
    ["use the shared table component", null],
  ]);
  git(root, "switch", "-q", "feature/x");
  expect(turn(root)).toEqual(both);
});

test("Given a branch cut from the remote base and created from HEAD, Then both resolve the base branch's task", () => {
  const root = repo("develop");
  recordDecision(root, "keep the API stable");
  // `git checkout -b` from develop logs "Created from HEAD": the HEAD log names develop.
  git(root, "checkout", "-q", "-b", "feature/head");
  expect(turn(root)?.decisions[0]).toMatchObject({ origin: "branch develop" });
  // A start point spelled as a remote-tracking ref maps to its local task key.
  git(root, "update-ref", "refs/remotes/origin/develop", "develop");
  git(root, "switch", "-q", "-c", "feature/remote", "origin/develop");
  expect(turn(root)?.decisions[0]).toMatchObject({ origin: "branch develop" });
});

test("Given a branch with no base task and no task of its own, Then there is no per-turn context", () => {
  const root = repo("develop");
  git(root, "switch", "-q", "-c", "feature/y");
  expect(turn(root)).toBeNull();
});

test("Given stale evidence, Then the compact context shows one counted gap with one inspect command, not the evidence ids", () => {
  const root = repo("develop");
  const taskId = recordDecision(root, "anything");
  const store = new TaskStore(root);
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("no task");
  const evidence = Array.from({ length: 10 }, (_, index) => ({
    evidenceId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    status: "stale",
    reason: "changed",
  }));
  const view = {
    task: task.data,
    workspace: workspace.data,
    capabilities: [],
    requirements: [],
    evidence,
  } as unknown as TaskView;
  const gaps = (JSON.parse(compactTaskContext(view)) as { gaps: string[] }).gaps;
  expect(gaps).toEqual([`stale evidence: 10; workit task inspect --task ${taskId} --view full`]);
  for (const entry of evidence) expect(gaps.join("\n")).not.toContain(entry.evidenceId);
});
