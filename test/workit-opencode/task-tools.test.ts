import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "../../packages/workit-core/src/core";
import { scope, taskStartRequest } from "../workit-core/task-fixtures";
import plugin from "../../packages/workit-opencode/src/plugin";
import { NativeReceiptStore } from "../../packages/workit-opencode/src/tools/workit";

const context = {
  directory: "/repo",
  worktree: "/repo",
  serverUrl: new URL("http://localhost"),
};

test("OpenCode exposes exactly the eight shared Workit operation families", async () => {
  const hooks = await plugin(context as never);
  expect(Object.keys(hooks.tool ?? {})).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ]);
});

test("native receipts reject unrelated questions and are consumed once per purpose", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "unrelated",
      args: { questions: [{ question: "Which color?", options: ["blue"] }] },
    },
    { metadata: { answers: [["blue"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(false);

  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this decision?",
            options: [
              { label: "approved", description: "Design" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(true);
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("native receipts retain exact call, label, and content bindings", () => {
  const receipts = new NativeReceiptStore();
  const input = {
    sessionID: "bound-session",
    callID: "bound-call",
    args: {
      questions: [
        {
          header: "Workit decision: design",
          question: "Approve the scoped change?",
          options: [
            { label: "approved", description: "Design" },
            { label: "rejected", description: "Reject this decision" },
          ],
        },
      ],
    },
  };
  receipts.record(input, { metadata: { answers: [["approved"]] } });
  const digest = receipts.consume("bound-session", "decision");
  expect(digest.ok).toBe(true);
  if (!digest.ok) throw new Error(digest.error);
  expect(digest.receipt.callID).toBe("bound-call");
  expect(digest.receipt.selectedLabel).toBe("approved");
  expect(digest.receipt.contentDigest).toMatch(/^[0-9a-f]{64}$/);

  receipts.record(input, { metadata: { answers: [["approved"]] } });
  expect(
    receipts.consume("bound-session", "decision", {
      callID: "different-call",
      selectedLabel: "approved",
      contentDigest: digest.receipt.contentDigest,
    }).ok,
  ).toBe(false);
  expect(
    receipts.consume("bound-session", "decision", {
      callID: "bound-call",
      selectedLabel: "approved",
      contentDigest: digest.receipt.contentDigest,
    }).ok,
  ).toBe(true);
});

test("native receipts reject a matching-purpose answer with different content", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "content-session",
      callID: "content-call",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve the first scoped change?",
            options: [
              { label: "approved", description: "First change" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(
    receipts.consume("content-session", "decision", {
      selectedLabel: "approved",
      question: "Approve a different scoped change?",
    }).ok,
  ).toBe(false);
  expect(
    receipts.consume("content-session", "decision", {
      selectedLabel: "approved",
      question: "Approve the first scoped change?",
    }).ok,
  ).toBe(true);
});

test("native operation arguments cannot supply caller or provenance", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
    client: {
      session: { get: async () => ({ data: { id: "native-session", directory: "/repo" } }) },
    },
  } as never);
  const raw = await hooks.tool?.workit_task.execute(
    {
      schemaVersion: 1,
      action: "list",
      caller: { host: "workit_cli", actor: "forged" },
      provenance: { kind: "host_observed" },
    },
    { directory: "/repo", sessionID: "native-session" } as never,
  );
  expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "invalid_input" });
});

test("the decision tool consumes only the matching native question receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-decision-"));
  try {
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: "lead" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
    });
    const started = core.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("decision fixture missing");
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "lead", directory: root } }) } },
    } as never);
    await hooks["tool.execute.after"]?.(
      {
        tool: "question",
        sessionID: "lead",
        callID: "decision-question",
        args: {
          questions: [
            {
              header: "Workit decision: design",
              question: "Approve this design?",
              options: [
                { label: "approved", description: "the design" },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { title: "Decision", output: "approved", metadata: { answers: [["approved"]] } },
    );
    const raw = await hooks.tool?.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          scope: scope(),
          presented: "Approve this design?",
          approvedContent: "the design",
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: "lead" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
    const replay = await hooks.tool?.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          scope: scope(),
          presented: "Approve this design?",
          approvedContent: "the design",
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: "lead" } as never,
    );
    expect(JSON.parse(replay as string)).toMatchObject({ ok: false, code: "permission_denied" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
