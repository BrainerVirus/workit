// A task whose PR merged and whose delivery was verified closes itself (#322):
// on the next read, from the ledger alone, and never for an unverified merge.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, success } from "@/packages/workit-core/src/core";
import type { Provenance } from "@/packages/workit-core/src/core/task-contract";
import * as ledger from "@/packages/workit-core/src/ledger";
import { closeDeliveredTasks } from "@/packages/workit-core/src/core/task-delivery";
import { appendObserved, readLedger } from "@/packages/workit-core/src/ledger";
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
const repo = (branch: string) => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-task-delivery-")));
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
const startTask = (root: string) => {
  const found = new TaskStore(root).implicitTask({ provenance, create: true });
  if (!found.ok || !found.data) throw new Error("no implicit task");
  return found.data.task.id;
};
const actor = { host: "cli", session: "s1", agentId: null };
const record = (root: string, type: string, branch: string, extra: object = {}) => {
  const row = appendObserved(root, {
    type,
    actor,
    branch,
    head: "abc123",
    pr: 7,
    ...extra,
  });
  if (!row.ok) throw new Error(row.error);
};
const statusOf = (root: string, taskId: string) => {
  const read = new TaskStore(root).readTask(taskId);
  if (!read.ok) throw new Error(read.error);
  return read.data;
};
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const listOpen = (root: string) => {
  closeDeliveredTasks(new TaskStore(root), stamp());
  const listed = coreFor(root).task({ schemaVersion: 1, action: "list" });
  if (!listed.ok) throw new Error(listed.error);
  return listed.data as { id: string }[];
};

test("Given a branch task whose PR merged and delivery verified, When tasks are listed, Then it is closed with a reason and no longer open", () => {
  const root = repo("feature/done");
  const taskId = startTask(root);
  record(root, "pr.merged", "feature/done", {
    mergeSha: "def456",
    method: "squash",
  });
  record(root, "delivery.verified", "feature/done", {
    expect: "merged",
    observations: [],
  });
  expect(listOpen(root).map((item) => item.id)).not.toContain(taskId);
  const task = statusOf(root, taskId);
  expect(task.status).toBe("closed");
  expect(task.closure?.summary).toContain("#7");
  expect(new TaskStore(root).implicitTask({ provenance, create: false })).toMatchObject({
    ok: true,
    data: null,
  });
});

test("Given a merged PR without verified delivery, When tasks are listed, Then the task stays active and names what is missing", () => {
  const root = repo("feature/unverified");
  const taskId = startTask(root);
  record(root, "pr.merged", "feature/unverified", {
    mergeSha: "def456",
    method: "squash",
  });
  expect(listOpen(root).map((item) => item.id)).toContain(taskId);
  const task = statusOf(root, taskId);
  expect(task.status).toBe("active");
  expect(task.progress.nextAction).toContain("workit verify-delivery merged");
});

test("Given a task with no PR, When tasks are listed, Then it is untouched", () => {
  const root = repo("feature/nopr");
  const taskId = startTask(root);
  const before = statusOf(root, taskId);
  expect(listOpen(root).map((item) => item.id)).toContain(taskId);
  expect(statusOf(root, taskId)).toEqual(before);
});

test("Given an unchanged ledger, When implicitTask runs twice, Then the second call does not read the ledger; a new merge plus verified delivery is swept on the next call", async () => {
  const root = repo("feature/cached");
  const taskId = startTask(root);
  const touch = () => closeDeliveredTasks(new TaskStore(root), stamp(), { cached: true });
  // Settle the ledger past the racy window so the signature is trusted.
  record(root, "commit.recorded", "feature/cached");
  await Bun.sleep(2100);
  touch();
  const reads = spyOn(ledger, "readLedger");
  try {
    touch();
    expect(reads).toHaveBeenCalledTimes(0);
    record(root, "pr.merged", "feature/cached", { mergeSha: "def456", method: "squash" });
    record(root, "delivery.verified", "feature/cached", { expect: "merged", observations: [] });
    touch();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
  } finally {
    reads.mockRestore();
  }
  expect(statusOf(root, taskId).status).toBe("closed");
});

test("Given a merged and verified delivery, Then the closure cites both ledger row ids", () => {
  const root = repo("feature/cite");
  const taskId = startTask(root);
  record(root, "pr.merged", "feature/cite", { mergeSha: "def456" });
  record(root, "delivery.verified", "feature/cite", { expect: "merged", observations: [] });
  listOpen(root);
  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  const ids = rows.value.rows.map((row) => row.id);
  const summary = statusOf(root, taskId).closure?.summary ?? "";
  for (const id of ids) expect(summary).toContain(id);
});

test("Given a branch name reused after an earlier merge, When tasks are listed, Then the newer task is not closed", async () => {
  const root = repo("feature/reused");
  record(root, "pr.merged", "feature/reused", { mergeSha: "def456" });
  record(root, "delivery.verified", "feature/reused", { expect: "merged", observations: [] });
  await Bun.sleep(1100);
  const taskId = startTask(root);
  expect(listOpen(root).map((item) => item.id)).toContain(taskId);
  expect(statusOf(root, taskId).status).toBe("active");
});

test("Given delivery verified for a different PR than the merged one, When tasks are listed, Then the task stays active", () => {
  const root = repo("feature/mismatch");
  const taskId = startTask(root);
  record(root, "pr.merged", "feature/mismatch", { mergeSha: "def456" });
  record(root, "delivery.verified", "feature/mismatch", {
    expect: "merged",
    pr: 8,
    observations: [],
  });
  expect(listOpen(root).map((item) => item.id)).toContain(taskId);
  expect(statusOf(root, taskId).status).toBe("active");
});

test("Given a task with a running worker, When the delivery is verified, Then it is skipped until the worker is gone and an uncached list closes it", () => {
  const root = repo("feature/worker");
  const assigned = coreFor(root).worker({
    schemaVersion: 1,
    action: "assign",
    assignment: {
      role: "implementer",
      objective: "do the slice",
      scope: { description: "checkout", paths: ["."], exclusions: [] },
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const workerId = assigned.data.id;
  const taskId = new TaskStore(root).implicitTask({ provenance, create: false });
  if (!taskId.ok || !taskId.data) throw new Error("no task");
  const id = taskId.data.task.id;
  const setState = (state: "unknown" | "stopped") => {
    const store = new TaskStore(root);
    const current = store.readTask(id);
    if (!current.ok) throw new Error(current.error);
    const changed = store.mutateTask(id, current.data.revision, (task, context) =>
      success(context.revision, null, {
        ...task,
        workers: task.workers.map((worker) =>
          worker.id === workerId ? { ...worker, data: { ...worker.data, state } } : worker,
        ),
      }),
    );
    if (!changed.ok) throw new Error(changed.error);
  };
  setState("unknown");
  record(root, "pr.merged", "feature/worker", { mergeSha: "def456" });
  record(root, "delivery.verified", "feature/worker", { expect: "merged", observations: [] });
  expect(listOpen(root).map((item) => item.id)).toContain(id);
  expect(statusOf(root, id).status).toBe("active");
  setState("stopped");
  expect(listOpen(root).map((item) => item.id)).not.toContain(id);
  expect(statusOf(root, id).status).toBe("closed");
});
