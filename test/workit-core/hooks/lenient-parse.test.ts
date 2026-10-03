import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { parseStoredRecord, taskRecordSchema } from "@/packages/workit-core/src/core/task-contract";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
  runHookProcess,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, startTask, tempRoot, withProtectedMain } from "./hook-fixtures";

// Keys a newer host release might add; none of them may change a decision.
const FUTURE = {
  prompt_id: "p-1",
  agent_id: "a-1",
  mcp_server: "x",
  future_field: { nested: true },
};

test("given a Codex PreToolUse payload with an unknown key, the hook still evaluates branch policy", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      const run = (command: string) =>
        dispatchHook(
          codexAdapter,
          fixture("codex", "pre-tool-use-bash", root, { ...FUTURE, tool_input: { command } }),
          {},
        );
      const denied = run("git checkout -b main");
      expect(denied.error).toBeNull();
      expect(denied.json).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
      const allowed = run("git checkout -b feature/next");
      expect(allowed.error).toBeNull();
      expect(allowed.json).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Claude and Cursor ignore unknown keys and still enforce branch policy", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      const claude = dispatchHook(
        claudeCodeAdapter,
        fixture("claude-code", "pre-tool-use-bash", root, FUTURE),
        {},
      );
      expect(claude.error).toBeNull();
      expect(claude.json).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      const cursor = dispatchHook(
        cursorAdapter,
        fixture("cursor", "before-shell-execution", root, FUTURE),
        {},
      );
      expect(cursor.error).toBeNull();
      expect(cursor.json).toMatchObject({ permission: "deny" });
      expect(cursor.exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a broken Codex payload passes through with a stderr diagnostic instead of denying", async () => {
  const root = tempRoot();
  try {
    for (const input of [
      "not json",
      JSON.stringify(fixture("codex", "pre-tool-use-bash", root, { model: "" })),
    ]) {
      let stdout = "";
      let stderr = "";
      const code = await runHookProcess(
        "codex_cli",
        Readable.from([input]),
        { write: (chunk: string) => (stdout += chunk) },
        { write: (chunk: string) => (stderr += chunk) },
        {},
      );
      expect(code).toBe(0);
      expect(stdout).not.toContain("deny");
      expect(stderr).toContain("[workit] hook input rejected");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const taskFile = (root: string, id: string) => path.join(root, ".workit", "tasks", `${id}.json`);

test("stored records with keys from a newer runtime stay readable; writes stay strict", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const file = taskFile(root, id);
    const record = JSON.parse(readFileSync(file, "utf8"));
    // New fields at the top level, inside an entry, and inside nested data.
    record.futureTopLevel = { anything: 1 };
    record.intent.futureEntryField = "x";
    record.intent.data.scope.futureScopeField = ["y"];
    record.progress.futureProgress = null;
    writeFileSync(file, JSON.stringify(record));

    const store = new TaskStore(root);
    const read = store.readTask(id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data).not.toHaveProperty("futureTopLevel");
    expect(read.data.intent).not.toHaveProperty("futureEntryField");
    expect(read.data.intent.data.scope).not.toHaveProperty("futureScopeField");
    expect(store.listTasks().ok).toBe(true);
    expect(store.listTaskIndex().ok).toBe(true);

    // A write by this reader persists only keys it can name.
    const workspace = store.readWorkspace();
    if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
    const paused = new WorkitCore(store, {
      root,
      caller: { host: "codex_cli", actor: "reader" },
      capabilities: [],
      constraints: [],
      now: "2026-01-02T00:00:00Z",
    }).task({
      schemaVersion: 1,
      action: "pause",
      taskId: id,
      expectedRevision: read.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "tolerance check",
    });
    expect(paused.ok).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).not.toHaveProperty("futureTopLevel");
    expect(taskRecordSchema.safeParse(written).success).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reader tolerance strips only unknown keys; real violations still fail", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const record = JSON.parse(readFileSync(taskFile(root, id), "utf8"));
    expect(taskRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
    expect(parseStoredRecord(taskRecordSchema, { ...record, extra: 1 }).success).toBe(true);
    // An unknown key next to a wrong type is still a schema failure.
    expect(
      parseStoredRecord(taskRecordSchema, { ...record, extra: 1, status: "finished" }).success,
    ).toBe(false);
    // The caller's value is never mutated.
    const input = { ...record, extra: 1 };
    parseStoredRecord(taskRecordSchema, input);
    expect(input.extra).toBe(1);
    // The store reports a corrupt record as before.
    writeFileSync(taskFile(root, id), JSON.stringify({ ...record, extra: 1, revision: 7 }));
    const read = new TaskStore(root).readTask(id);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("recovery_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
