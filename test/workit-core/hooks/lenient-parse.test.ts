import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import * as z from "zod";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { parseStoredRecord, taskRecordSchema } from "@/packages/workit-core/src/core/task-contract";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
  runHookProcess,
} from "@/packages/workit-core/src/hooks/index";
import { commandText } from "@/packages/workit-core/src/hooks/hosts/fields";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { fixture, startTask, tempRoot, withProtectedMain } from "./hook-fixtures";
import { eventsFileOf, eventsOf, rawRecordOf, rewriteTaskLog } from "../store-files";

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
      JSON.stringify(fixture("codex", "pre-tool-use-bash", root, { tool_input: {} })),
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

// A task's on-disk record is its event log; these replace it with one
// opening event (as another runtime might leave it) and replay it raw.
const writeRecord = (root: string, id: string, record: unknown): string => {
  rewriteTaskLog(root, id, record);
  return readFileSync(eventsFileOf(root, id), "utf8");
};

test("stored records with keys from a newer runtime stay readable; writes stay strict", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const record = rawRecordOf(root, id);
    // New fields at the top level, inside an entry, and inside nested data.
    record.futureTopLevel = { anything: 1 };
    record.intent.futureEntryField = "x";
    record.intent.data.scope.futureScopeField = ["y"];
    record.progress.futureProgress = null;
    writeRecord(root, id, record);

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
    // The write is a patch of the keys this reader can name: the newer
    // runtime's keys stay in the log, untouched and unread.
    const written = rawRecordOf(root, id);
    expect(written.status).toBe("paused");
    expect(written.futureTopLevel).toEqual({ anything: 1 });
    expect(JSON.stringify(eventsOf(root, id).at(-1)?.data.ops)).not.toContain("future");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reader tolerance strips only unknown keys; real violations still fail", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const record = rawRecordOf(root, id);
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
    writeRecord(root, id, { ...record, extra: 1, revision: 7 });
    const read = new TaskStore(root).readTask(id);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("recovery_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex shell policy needs only cwd and command: new permission modes and argv commands still deny", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      const run = (tool_input: unknown, extra: Record<string, unknown> = {}) =>
        dispatchHook(
          codexAdapter,
          { hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input, ...extra },
          {},
        );
      const denied = (result: ReturnType<typeof run>) =>
        (result.json.hookSpecificOutput as { permissionDecision?: string }).permissionDecision ===
        "deny";
      // Only cwd, tool and command: no session, model, turn or transcript.
      expect(denied(run({ command: "git checkout -b main" }))).toBe(true);
      expect(denied(run({ command: "git checkout -b main" }, { permission_mode: "weird" }))).toBe(
        true,
      );
      expect(denied(run({ command: ["git", "checkout", "-b", "main"] }))).toBe(true);
      expect(denied(run({ command: ["bash", "-lc", "git checkout -b main"] }))).toBe(true);
      expect(denied(run({ command: ["git", "checkout", "-b", "feature/ok"] }))).toBe(false);
      // unified-exec is a shell tool too.
      expect(denied(run({ command: "git checkout -b main" }, { tool_name: "unified-exec" }))).toBe(
        true,
      );
      // cwd stays strict: it must be an absolute existing directory.
      expect(run({ command: "git checkout -b main" }, { cwd: "." }).error).toBe(
        "cwd must be an existing absolute directory",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Cursor shell policy follows the command cwd across a multi-root workspace", async () => {
  await withProtectedMain((configDir) => {
    const first = tempRoot();
    const second = tempRoot();
    const nested = path.join(second, "nested");
    mkdirSync(nested);
    writeFileSync(
      path.join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "strict",
            // Only the nested repository is strict, so the cwd itself must decide.
            glob: `${realpathSync(nested)}/**`,
            branchPolicy: { preset: "custom", allowed: ["fix/*"], protected: ["main"] },
          },
        ],
      }),
    );
    try {
      const run = (cwd?: string) =>
        dispatchHook(
          cursorAdapter,
          fixture("cursor", "before-shell-execution", first, {
            workspace_roots: [first, second],
            command: "git checkout -b feature/x",
            cwd,
          }),
          {},
        );
      expect(run(first).json).toEqual({ permission: "allow" });
      expect(run(second).json).toEqual({ permission: "allow" });
      expect(run().json).toEqual({ permission: "allow" });
      const denied = run(nested);
      expect(denied.json).toMatchObject({ permission: "deny" });
      expect(denied.exitCode).toBe(2);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

test("a union keeps the branch that drops the fewest keys", () => {
  const schema = z
    .object({
      value: z.union([
        z.object({ a: z.string() }).strict(),
        z.object({ a: z.string(), b: z.string() }).strict(),
      ]),
    })
    .strict();
  const parsed = parseStoredRecord(schema, { value: { a: "x", b: "y", future: 1 } });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data).toEqual({ value: { a: "x", b: "y" } });
    expect(parsed.stripped).toEqual(["value.future"]);
  }
});

test("a field the writer declares critical makes an older reader fail closed and never write", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const file = eventsFileOf(root, id);
    const record = rawRecordOf(root, id);
    const write = (value: unknown) => writeRecord(root, id, value);
    // Ignorable: an undeclared field is dropped and the record reads.
    write({ ...record, ignorable: 1, critical: ["evidence.*.data.observer"] });
    expect(new TaskStore(root).readTask(id).ok).toBe(true);
    // Critical: the declared path (here nested under an entry) cannot be dropped.
    record.intent.data.mustUnderstand = { mode: "strict" };
    const bytes = write({ ...record, critical: ["intent.data.mustUnderstand"] });
    const store = new TaskStore(root);
    const read = store.readTask(id);
    expect(read).toMatchObject({ ok: false, code: "recovery_required" });
    expect(!read.ok && read.error).toContain("intent.data.mustUnderstand");
    expect(!read.ok && read.error).toContain("upgrade Workit");
    expect(store.listTasks().ok).toBe(false);
    // A mutation reads first, so it refuses and the file is untouched.
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
      expectedRevision: record.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "must not write",
    });
    expect(paused.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // A parent key covering a critical path is just as critical.
    const parent = { ...record, critical: ["intent.data.mustUnderstand.mode"] };
    write(parent);
    expect(new TaskStore(root).readTask(id).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell wrappers yield their script after the first script flag", () => {
  const script = "git checkout -b main";
  for (const argv of [
    ["bash", "-c", script],
    ["bash", "-lc", script],
    ["bash", "-e", "-c", script],
    ["/usr/bin/zsh", "-l", "-c", script],
    ["powershell.exe", "-NoProfile", "-Command", script],
    ["pwsh", "-c", script],
    ["cmd", "/c", script],
    ["C:\\Windows\\System32\\cmd.exe", "/C", script],
  ])
    expect(commandText(argv), argv.join(" ")).toBe(script);
  expect(commandText(["git", "checkout", "-b", "main"])).toBe(script);
  expect(commandText(["bash", "script.sh", "-c", "x"])).toBe("bash script.sh -c x");
  expect(commandText(["git", "commit", "-m", "two words"])).toBe('git commit -m "two words"');
});

test("Codex denies protected branches inside shell wrappers", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      for (const command of [
        ["bash", "-e", "-c", "git checkout -b main"],
        ["powershell.exe", "-Command", "git checkout -b main"],
        ["cmd", "/c", "git checkout -b main"],
      ]) {
        const result = dispatchHook(
          codexAdapter,
          { hook_event_name: "PreToolUse", cwd: root, tool_name: "bash", tool_input: { command } },
          {},
        );
        expect(
          (result.json.hookSpecificOutput as { permissionDecision?: string }).permissionDecision,
          command.join(" "),
        ).toBe("deny");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a critical path declared with an array index covers every element", () => {
  const root = tempRoot();
  try {
    const id = startTask(root, { host: "codex_cli", actor: "reader" });
    const record = rawRecordOf(root, id);
    record.intent.data.authorityRefs = [
      { kind: "external", url: "https://example.com/a", future: true },
    ];
    writeRecord(root, id, record);
    // Undeclared, the unknown key inside the array element is ignorable.
    expect(new TaskStore(root).readTask(id).ok).toBe(true);
    writeRecord(root, id, { ...record, critical: ["intent.data.authorityRefs.0.future"] });
    const read = new TaskStore(root).readTask(id);
    expect(read).toMatchObject({ ok: false, code: "recovery_required" });
    expect(!read.ok && read.error).toContain("intent.data.authorityRefs.*.future");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex session without an id gets no writer-acquire actor and no shared offer key", () => {
  const root = tempRoot();
  try {
    startTask(root, { host: "codex_cli", actor: "someone-else" }, "unbound history");
    const start = () =>
      JSON.stringify(
        dispatchHook(
          codexAdapter,
          { hook_event_name: "SessionStart", cwd: root, source: "startup" },
          {},
        ).json,
      );
    const first = start();
    expect(first).toContain("<workit-codex-mutations>");
    expect(first).not.toContain("--actor");
    expect(first).not.toContain("writer acquire");
    // Two id-less sessions are not the same session: neither suppresses the other.
    const withId = (session_id: string) =>
      JSON.stringify(
        dispatchHook(
          codexAdapter,
          { hook_event_name: "SessionStart", cwd: root, source: "startup", session_id },
          {},
        ).json,
      );
    expect(withId("codex-a")).toContain("--actor codex-a");
    const other = tempRoot();
    try {
      // Two open tasks: no single active task is shown, so both are offered.
      startTask(other, { host: "codex_cli", actor: "x" }, "first parked");
      const store = new TaskStore(other);
      const workspace = store.readWorkspace();
      if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
      const second = new WorkitCore(store, {
        root: other,
        caller: { host: "codex_cli", actor: "y" },
        capabilities: [],
        constraints: [],
        now: "2026-01-02T00:00:00Z",
      }).task(taskStartRequest({ expectedWorkspaceRevision: workspace.data.revision }));
      expect(second.ok).toBe(true);
      const idless = () =>
        JSON.stringify(
          dispatchHook(
            codexAdapter,
            { hook_event_name: "SessionStart", cwd: other, source: "startup" },
            {},
          ).json,
        );
      expect(idless()).toContain("<workit-history-offer>");
      expect(idless()).toContain("<workit-history-offer>");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
