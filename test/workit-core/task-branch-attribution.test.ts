// Task, worker and decision state across branch switches (#264, #267 B3):
// worker commands follow the worker's task, decisions recorded on a base
// branch stay in view on branches cut from it, and stale evidence is one
// counted gap with one command.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskCommand } from "@/packages/workit-cli/src/task";
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

/** `workit <argv> --json` through the CLI's task command, in `root`. */
const cli = async (root: string, argv: string[]) => {
  let stdout = "";
  const code = await runTaskCommand([...argv, "--json"], {
    cwd: root,
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: () => undefined },
  });
  return { code, json: JSON.parse(stdout) as { ok: boolean; code?: string; error?: string } };
};

test("Given a cancel resolved from the worker that then fails, Then the error names the exact --task command for the worker's task", async () => {
  const root = repo("feature/a");
  const { workerId, taskId } = assignOnCurrentBranch(root);
  git(root, "switch", "-q", "-c", "feature/b");
  const failed = await cli(root, [
    "worker",
    "cancel",
    workerId,
    "--revision",
    "00000000-0000-4000-8000-0000000000ff",
    "--payload",
    JSON.stringify({ reason: "it's stale" }),
  ]);
  expect(failed.code).toBe(1);
  expect(failed.json.error).toContain(
    `run \`workit worker cancel ${workerId} --task ${taskId} --payload '{"reason":"it'\\''s stale"}'\``,
  );
});

test("Given a worker on no open task, When it is cancelled without a task id, Then the error says how to find its task and the exact command to run", async () => {
  const root = repo("feature/a");
  assignOnCurrentBranch(root);
  const unknown = "00000000-0000-4000-8000-0000000000aa";
  const failed = await cli(root, ["worker", "cancel", unknown]);
  expect(failed.json).toMatchObject({ ok: false, code: "not_found" });
  expect(failed.json.error).toBe(
    `worker ${unknown} is on no open task; find its task with \`workit task status --all\`, then run \`workit worker cancel ${unknown} --task <task-id>\``,
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

// --- Review mv7eee3w: the safety claims, each with a test that fails without it.

const decide = (root: string, text: string, who: Provenance = provenance) => {
  const store = new TaskStore(root);
  const task = store.implicitTask({ provenance: who, create: true });
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
  return { taskId: task.data.task.id, decisionId: recorded.data.id };
};
const conversation = (handle: string): Provenance => ({
  kind: "agent_reported",
  host: "claude_code",
  session: { kind: "host", host: "claude_code", handle },
  workerId: null,
});
const choices = (root: string) =>
  turn(root)?.decisions.map((entry) => [entry.choice, entry.origin ?? null]) ?? null;
const commit = (root: string, message: string) =>
  git(root, "commit", "-q", "--allow-empty", "-m", message);

test("Given a decision revoked on the base branch, Then a branch cut from it does not inherit it", () => {
  const root = repo("develop");
  const { taskId, decisionId } = decide(root, "use the old client");
  const revoked = coreFor(root).decision({
    schemaVersion: 1,
    action: "revoke",
    taskId,
    decisionId,
    reason: "superseded",
  });
  expect(revoked.ok).toBe(true);
  git(root, "switch", "-q", "-c", "feature/x");
  expect(turn(root)).toBeNull();
});

test("Given the base branch's task is bound to another conversation, Then its decisions are not injected", () => {
  const root = repo("develop");
  decide(root, "someone else's call", conversation("conversation-2"));
  git(root, "switch", "-q", "-c", "feature/x");
  expect(turn(root)).toBeNull();
});

test("Given this conversation's own task is the base task, Then its decisions show once, as its own", () => {
  const root = repo("develop");
  decide(root, "our call", conversation(session.handle));
  git(root, "switch", "-q", "-c", "feature/x");
  // The session-bound task is develop's: it is both current and the origin.
  expect(choices(root)).toEqual([["our call", null]]);
});

test("Given the base task gets a new decision, Then the next turn shows it (the base is part of the cache key)", () => {
  const root = repo("develop");
  const { taskId } = decide(root, "first");
  git(root, "switch", "-q", "-c", "feature/x");
  expect(choices(root)).toEqual([["first", "branch develop"]]);
  const workspace = new TaskStore(root).readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("no workspace");
  const base = new TaskStore(root).readTask(taskId);
  if (!base.ok) throw new Error(base.error);
  const second = coreFor(root).decision({
    schemaVersion: 1,
    action: "record",
    taskId,
    purpose: "design",
    binding: {
      taskId,
      workspaceId: workspace.data.id,
      scope: base.data.intent.data.scope,
      presented: "second",
      contentRefs: [],
    },
    response: "approved",
    requirementIds: [],
  });
  expect(second.ok).toBe(true);
  // Both land in the same second, so their order is by id: compare as a set.
  expect(choices(root)?.toSorted()).toEqual([
    ["first", "branch develop"],
    ["second", "branch develop"],
  ]);
});

test("Given a branch name deleted and recreated from HEAD on another base, Then the base is the current branch's, not the old one's", () => {
  const root = repo("develop");
  decide(root, "develop rule");
  git(root, "checkout", "-q", "-b", "feature/x");
  git(root, "switch", "-q", "main");
  commit(root, "main moves on");
  decide(root, "main rule");
  git(root, "branch", "-q", "-D", "feature/x");
  git(root, "checkout", "-q", "-b", "feature/x");
  expect(choices(root)).toEqual([["main rule", "branch main"]]);
});

test("Given a branch created from HEAD and renamed onto a name an older branch used, Then its base comes from its own creation", () => {
  const root = repo("develop");
  decide(root, "develop rule");
  git(root, "checkout", "-q", "-b", "feature/b");
  git(root, "switch", "-q", "main");
  commit(root, "main moves on");
  decide(root, "main rule");
  git(root, "branch", "-q", "-D", "feature/b");
  git(root, "checkout", "-q", "-b", "feature/a");
  git(root, "branch", "-m", "feature/b");
  expect(choices(root)).toEqual([["main rule", "branch main"]]);
});

test("Given a branch whose creation entry is gone from its reflog, Then it inherits nothing", () => {
  const root = repo("develop");
  decide(root, "develop rule");
  git(root, "switch", "-q", "-c", "feature/x");
  commit(root, "work");
  expect(choices(root)).toEqual([["develop rule", "branch develop"]]);
  // Expiry drops the oldest entries: the first line is no longer the creation.
  const log = path.join(root, ".git", "logs", "refs", "heads", "feature", "x");
  writeFileSync(log, readFileSync(log, "utf8").split("\n").slice(1).join("\n"));
  expect(turn(root)).toBeNull();
});

test("Given a branch cut from a local branch with a slash in its name, Then the name is not read as remote/branch", () => {
  const root = repo("base");
  decide(root, "rule of the branch named base");
  git(root, "switch", "-q", "-c", "feature/base");
  git(root, "switch", "-q", "-c", "feature/child", "feature/base");
  // feature/base has no task; `base` must not be taken for it.
  expect(turn(root)).toBeNull();
});

test("Given a worker on a closed task, When it is cancelled without a task id, Then the closed task is not used", () => {
  const root = repo("feature/a");
  const { workerId, taskId } = assignOnCurrentBranch(root);
  const core = coreFor(root);
  expect(core.worker({ schemaVersion: 1, action: "cancel", workerId, reason: "done" }).ok).toBe(
    true,
  );
  const closed = core.task({
    schemaVersion: 1,
    action: "close",
    taskId,
    outcome: "stopped",
    summary: "abandoned",
  });
  expect(closed.ok).toBe(true);
  expect(
    core.worker({ schemaVersion: 1, action: "cancel", workerId, reason: "again" }),
  ).toMatchObject({ ok: false, code: "not_found" });
});

test("Given a helper session after the checkout moved to another branch's task, Then its own calls resolve to the task it was assigned on", () => {
  const root = repo("feature/a");
  const { workerId, taskId } = assignOnCurrentBranch(root);
  git(root, "switch", "-q", "-c", "feature/b");
  assignOnCurrentBranch(root);
  const helper = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ actor: "helper" }),
    capabilities: [],
    constraints: [],
    workerId,
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  expect(helper.task({ schemaVersion: 1, action: "inspect" })).toMatchObject({
    ok: true,
    data: { id: taskId },
  });
});

test("Given a worker command without a usable worker id, Then it is invalid input naming the form, not a lookup", () => {
  const root = repo("feature/a");
  assignOnCurrentBranch(root);
  for (const workerId of [undefined, "not-a-uuid"])
    expect(
      coreFor(root).worker({ schemaVersion: 1, action: "cancel", workerId, reason: "x" }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
      error: expect.stringContaining("workit worker cancel|report <workerId>"),
    });
});
