import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import extension, { persistUncertainCancel } from "@/packages/workit-pi/extensions/workit";
import { nativeWorkerForEvidence } from "@/packages/workit-pi/src/worker";
import { piCapabilities } from "@/packages/workit-pi/src/context";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const makePi = () => {
  const tools: any[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands: any[] = [];
  const sent: any[] = [];
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(command: any, options: any) {
      commands.push({ name: command, ...options });
    },
    sendUserMessage(content: any, options: any) {
      sent.push({ content, options });
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    tools,
    commands,
    sent,
    handlers,
  };
  return pi;
};

const context = (root: string, hasUI = false, trusted = true, session = "pi-session") => {
  const sessionManager = {
    getSessionId: () => session,
    getSessionFile: () => "/tmp/pi-session.jsonl",
    getCwd: () => root,
    getEntries: () => [],
    getBranch: () => [],
  };
  return {
    cwd: root,
    hasUI,
    mode: hasUI ? "tui" : "json",
    isProjectTrusted: () => trusted,
    sessionManager,
    ui: { confirm: async () => true, select: async () => "approved" },
  } as any;
};

const startedTask = (root: string, paths = ["."]) => {
  const store = new TaskStore(root);
  const operationContext: OperationContext = {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const result = new WorkitCore(store, operationContext).task(
    taskStartRequest({
      intent: {
        objective: "test task",
        scope: { description: "the checkout", paths, exclusions: [] },
        authorityRefs: [],
      },
    }),
  );
  if (!result.ok) throw new Error(result.error);
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const task = store.readTask((result.data as { id: string }).id);
  if (!task.ok) throw new Error(task.error);
  return { store, task: task.data, workspace: workspace.data };
};

const decisionInput = (root: string) => {
  const { task, workspace } = startedTask(root);
  return {
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: {
      taskId: task.id,
      workspaceId: workspace.id,
      scope: task.intent.data.scope,
      presented: "Use the selected implementation approach?",
      contentRefs: [],
    },
    response: "approved",
    requirementIds: [],
  };
};

test("clean Pi package declares stock discovery and the seven families plus read-only context", async () => {
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../packages/workit-pi/package.json"), "utf8"),
  );
  expect(manifest.pi).toEqual({ extensions: ["./dist/workit.js"], skills: ["./skills"] });
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@brainervirus/workit-core");
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.85.1");
  const pi = makePi();
  await extension(pi as any);
  expect(
    pi.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("workit_") && name !== "workit_worker_control"),
  ).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_state",
    "workit_context",
  ]);
  expect(pi.tools.map((tool) => tool.name)).toContain("workit_worker_control");
  expect(pi.tools.every((tool) => tool.parameters.type === "object")).toBe(true);
  const depth = (node: unknown, current = 0): number => {
    if (Array.isArray(node))
      return node.reduce((max, item) => Math.max(max, depth(item, current)), current);
    if (node && typeof node === "object") {
      const keys = Object.keys(node);
      if (!keys.length) return current;
      return keys.reduce(
        (max, key) => Math.max(max, depth((node as Record<string, unknown>)[key], current + 1)),
        current,
      );
    }
    return current;
  };
  for (const tool of pi.tools.filter((item) => item.name.startsWith("workit_"))) {
    expect(depth(tool.parameters), tool.name).toBeLessThanOrEqual(8);
  }
  for (const tool of pi.tools) {
    expect(depth(tool.parameters), tool.name).toBeLessThanOrEqual(10);
  }
  expect(pi.commands.map((command) => command.name)).toContain("workit-worker");
});

test("Pi registers wk- slash aliases that expand the bundled skill commands", async () => {
  const pi = makePi();
  await extension(pi as any);
  for (const [alias, skill] of [
    ["wk-shape", "workit-shape"],
    ["wk-implement", "workit-implement"],
    ["wk-review", "workit-review"],
    ["wk-debug", "workit-debug"],
    ["wk-ship", "workit-ship"],
    ["wk-continue", "workit-continue"],
    ["wk-bdd", "workit-bdd"],
    ["wk-test-audit", "workit-test-audit"],
    ["wk-deslop", "workit-deslop"],
    ["wk-fanout", "workit-fanout"],
    ["wk-verify-app", "workit-verify-app"],
    ["wk-retro", "workit-retro"],
  ]) {
    const command = pi.commands.find((entry: any) => entry.name === alias);
    expect(command, alias).toBeDefined();
    await command.handler("extra args", {});
    expect(pi.sent.at(-1)).toEqual({
      content: `/skill:${skill} extra args`,
      options: { expandPromptTemplates: true },
    });
  }
});

test("Pi tool payloads use the shared parser and headless decisions record without a prompt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-tools-"));
  const pi = makePi();
  await extension(pi as any);
  const taskTool = pi.tools.find((tool) => tool.name === "workit_task");
  const invalid = await taskTool.execute(
    "call",
    { unknown: true },
    undefined,
    undefined,
    context(root),
  );
  expect(invalid.details).toMatchObject({ ok: false, code: "invalid_input" });
  const decisionTool = pi.tools.find((tool) => tool.name === "workit_decision");
  const headless = await decisionTool.execute(
    "call",
    decisionInput(root),
    undefined,
    undefined,
    context(root, false),
  );
  expect(headless.details).toMatchObject({ ok: true, data: { data: { response: "approved" } } });
  for (const hasUI of [false, true])
    expect(piCapabilities({ hasUI }).map((entry) => entry.name)).not.toContain(
      "interactive_decision",
    );
});

test("Pi tools transport nested payloads and arrays intact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-nested-"));
  const pi = makePi();
  await extension(pi as any);
  const taskTool = pi.tools.find((tool) => tool.name === "workit_task");
  const started = await taskTool.execute(
    "call",
    {
      schemaVersion: 1,
      action: "start",
      intent: {
        objective: "nested transport probe",
        scope: { description: "probe", paths: [], exclusions: [] },
        authorityRefs: [],
      },
    },
    undefined,
    undefined,
    context(root),
  );
  expect(started.details).toMatchObject({ ok: true });
  const taskId = (started.details as { data: { id: string } }).data.id;
  const closed = await taskTool.execute(
    "call",
    {
      schemaVersion: 1,
      action: "close",
      taskId,
      outcome: "stopped",
      summary: "transport probe done",
      decisionIds: [],
    },
    undefined,
    undefined,
    context(root),
  );
  expect(closed.details).toMatchObject({ ok: true });
});

test("Pi tools accept JSON-stringified nested payloads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-stringified-"));
  const pi = makePi();
  await extension(pi as any);
  const taskTool = pi.tools.find((tool) => tool.name === "workit_task");
  const started = await taskTool.execute(
    "call",
    {
      schemaVersion: "1",
      action: "start",
      intent: JSON.stringify({
        objective: "stringified transport probe",
        scope: { description: "probe", paths: [], exclusions: [] },
        authorityRefs: [],
      }),
    },
    undefined,
    undefined,
    context(root),
  );
  expect(started.details).toMatchObject({ ok: true });
  const taskId = (started.details as { data: { id: string } }).data.id;
  const stored = new TaskStore(root).readTask(taskId);
  expect(stored.ok).toBe(true);
  if (!stored.ok) throw new Error(stored.error);
  expect(stored.data.intent.data.objective).toBe("stringified transport probe");
});

test("Pi string decoding never masks the original contract failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-decode-error-"));
  const pi = makePi();
  await extension(pi as any);
  const taskTool = pi.tools.find((tool) => tool.name === "workit_task");
  // Literal free text that parses as JSON keeps its meaning: a valid call
  // with a numeric-looking summary still succeeds without decoding.
  const started = await taskTool.execute(
    "call",
    {
      schemaVersion: 1,
      action: "start",
      intent: {
        objective: "123",
        scope: { description: "probe", paths: [], exclusions: [] },
        authorityRefs: [],
      },
    },
    undefined,
    undefined,
    context(root),
  );
  expect(started.details).toMatchObject({ ok: true });
  // A genuinely bad call still reports the original failure, not a decoding
  // artifact: unknown action stays unknown action.
  const bad = await taskTool.execute(
    "call",
    { schemaVersion: 1, action: "frobnicate", intent: { objective: "x" } },
    undefined,
    undefined,
    context(root),
  );
  expect(bad.details).toMatchObject({ ok: false, code: "invalid_input" });
});

test("interactive Pi decisions record the stated response without confirming and reject untrusted writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-decision-"));
  const pi = makePi();
  await extension(pi as any);
  const decisionTool = pi.tools.find((tool) => tool.name === "workit_decision");
  let prompts = 0;
  const interactive = context(root, true);
  interactive.ui = {
    confirm: async () => {
      prompts += 1;
      return false;
    },
    select: async () => {
      prompts += 1;
      return "rejected";
    },
  };
  const result = await decisionTool.execute(
    "call",
    decisionInput(root),
    undefined,
    undefined,
    interactive,
  );
  expect(result.details).toMatchObject({ ok: true, data: { data: { response: "approved" } } });
  expect(prompts).toBe(0);

  const taskTool = pi.tools.find((tool) => tool.name === "workit_task");
  const denied = await taskTool.execute(
    "call",
    taskStartRequest(),
    undefined,
    undefined,
    context(root, true, false),
  );
  expect(denied.details).toMatchObject({ ok: false, code: "permission_denied" });
});

test("Pi child registration omits the coordinator-only context reader", async () => {
  const previous = process.env.WORKIT_PI_WORKER_ID;
  process.env.WORKIT_PI_WORKER_ID = "worker-child";
  try {
    const pi = makePi();
    await extension(pi as any);
    expect(pi.tools.map((tool) => tool.name)).not.toContain("workit_context");
  } finally {
    if (previous === undefined) delete process.env.WORKIT_PI_WORKER_ID;
    else process.env.WORKIT_PI_WORKER_ID = previous;
  }
});

test("Pi session context offers unfinished history once without writing task state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-history-"));
  const { store } = startedTask(root);
  const beforeWorkspace = store.readWorkspace();
  if (!beforeWorkspace.ok || !beforeWorkspace.data) throw new Error("workspace missing");
  const collidingSessionTask = new WorkitCore(store, {
    root,
    caller: { host: "codex_cli", actor: "new-pi-session" },
    capabilities: [],
    constraints: [],
    now: "2026-01-02T00:00:00Z",
  }).task(
    taskStartRequest({
      expectedWorkspaceRevision: beforeWorkspace.data.revision,
      intent: {
        objective: "same handle from Codex",
        scope: { description: "the checkout", paths: ["."], exclusions: [] },
        authorityRefs: [],
      },
    }),
  );
  expect(collidingSessionTask.ok).toBe(true);
  const beforeTasks = store.listTasks();
  const finalWorkspace = store.readWorkspace();
  const pi = makePi();
  await extension(pi as any);
  const ctx = context(root, false, true, "new-pi-session");
  const start = pi.handlers.get("before_agent_start")!;
  const first = await start({}, ctx);
  const second = await start({}, ctx);
  expect((first as any).message.content).toContain("<workit-history-offer>");
  expect((first as any).message.content).toContain("test task");
  expect((first as any).message.content).toContain("same handle from Codex");
  expect(second).toBeUndefined();
  expect(store.listTasks()).toEqual(beforeTasks);
  expect(store.readWorkspace()).toEqual(finalWorkspace);
});

test("Pi documentation context remains available headlessly", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-docs-action-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(path.join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    const pi = makePi();
    await extension(pi as any);
    const action = pi.tools.find((tool) => tool.name === "workit_context");
    const result = await action.execute(
      "docs-headless",
      { kind: "changelog" },
      undefined,
      undefined,
      context(root, false),
    );
    expect(result.details.code).not.toBe("needs_input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi workit_context returns Git context headlessly without project trust or Workit writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-context-read-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const before = readFileSync(path.join(root, ".git/HEAD"), "utf8");
    const pi = makePi();
    await extension(pi as any);
    const action = pi.tools.find((tool) => tool.name === "workit_context");
    const result = await action.execute(
      "context-read",
      { kind: "git" },
      undefined,
      undefined,
      context(root, false, false),
    );
    expect(result.details).toMatchObject({
      ok: true,
      data: { kind: "git", context: { workspace_root: root } },
    });
    expect(readFileSync(path.join(root, ".git/HEAD"), "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi affected-doc context passes edits through and public evidence captures the changed candidate", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-affected-docs-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    const doc = path.join(root, "docs", "guide.md");
    const source = path.join(root, "src", "app.ts");
    mkdirSync(path.join(root, "docs"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(doc, "# Guide\n");
    writeFileSync(source, "export const version = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(source, "export const version = 2;\n");
    spawnSync("git", ["add", source], { cwd: root });
    spawnSync("git", ["commit", "-qm", "source change"], { cwd: root });

    const pi = makePi();
    await extension(pi as any);
    const action = pi.tools.find((tool) => tool.name === "workit_context");
    const contextResult = await action.execute(
      "affected-docs",
      { kind: "affected", range: "HEAD~1...HEAD" },
      undefined,
      undefined,
      context(root, false),
    );
    expect(contextResult.details).toMatchObject({ ok: true, data: { kind: "affected" } });
    expect(contextResult.details.data.context).toContain("docs/guide.md");
    expect(contextResult.details.data.context).toContain("src/app.ts");

    const active = startedTask(root, ["docs"]);
    const evidenceTool = pi.tools.find((tool) => tool.name === "workit_evidence");
    const recordEvidence = async (claim: string) => {
      const current = active.store.readTask(active.task.id);
      if (!current.ok) throw new Error(current.error);
      const result = await evidenceTool.execute(
        "evidence-call",
        {
          schemaVersion: 1,
          action: "record",
          taskId: current.data.id,
          expectedRevision: current.data.revision,
          evidence: {
            kind: "check",
            claim,
            requirementIds: [],
            beforeCandidateId: null,
            candidateId: null,
            result: "passed",
            summary: claim,
            refs: [],
            exitCode: 0,
            reviewContext: null,
          },
        },
        undefined,
        undefined,
        context(root, true),
      );
      expect(result.details).toMatchObject({ ok: true });
    };
    await recordEvidence("affected docs before edit");
    const beforeTask = active.store.readTask(active.task.id);
    if (!beforeTask.ok) throw new Error(beforeTask.error);
    const beforeCandidate = beforeTask.data.candidates.at(-1);
    if (!beforeCandidate) throw new Error("pre-edit candidate missing");
    const before = readFileSync(doc, "utf8");
    const guard = pi.handlers.get("tool_call");
    expect(
      guard?.(
        { toolName: "edit", toolCallId: "in-scope", input: { path: "docs/guide.md" } },
        context(root, true),
      ),
    ).toBeUndefined();
    writeFileSync(doc, `${before}Updated from affected-doc evidence.\n`);
    expect(readFileSync(doc, "utf8")).toContain("Updated from affected-doc evidence.");
    expect(
      guard?.(
        { toolName: "edit", toolCallId: "out-of-scope", input: { path: "src/app.ts" } },
        context(root, true),
      ),
    ).toBeUndefined();
    expect(readFileSync(source, "utf8")).toBe("export const version = 2;\n");
    await recordEvidence("affected docs after edit");
    const afterTask = active.store.readTask(active.task.id);
    if (!afterTask.ok) throw new Error(afterTask.error);
    const afterCandidate = afterTask.data.candidates.at(-1);
    expect(afterCandidate?.id).not.toBe(beforeCandidate.id);
    expect(afterCandidate?.files.find((file) => file.path === "docs/guide.md")?.digest).not.toBe(
      beforeCandidate.files.find((file) => file.path === "docs/guide.md")?.digest,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi blocks noncompliant branch targets and leaves other commands to the host", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-route-"));
  const config = mkdtempSync(path.join(tmpdir(), "workit-pi-route-config-"));
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = config;
    writeFileSync(
      path.join(config, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
      }),
    );
    startedTask(root);
    const pi = makePi();
    await extension(pi as any);
    const guard = pi.handlers.get("tool_call");
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "protected", input: { command: "git switch -c main" } },
        context(root),
      ),
    ).toMatchObject({ block: true, reason: expect.stringContaining("protected_ref") });
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "pr", input: { command: "glab mr create --title t" } },
        context(root),
      ),
    ).toBeUndefined();
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "branch", input: { command: "git switch -c feature/raw" } },
        context(root),
      ),
    ).toBeUndefined();
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "other", input: { command: "git status --short" } },
        context(root),
      ),
    ).toBeUndefined();
  } finally {
    if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

test("Pi allows recognized raw branch and PR creation outside live work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-route-bare-"));
  try {
    const pi = makePi();
    await extension(pi as any);
    const guard = pi.handlers.get("tool_call");
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "branch", input: { command: "git switch -c feature/raw" } },
        context(root),
      ),
    ).toBeUndefined();
    expect(
      await guard?.(
        { toolName: "bash", toolCallId: "pr", input: { command: "glab mr create --title t" } },
        context(root),
      ),
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile without a live handle fails recovery_required instead of pretending", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-reconcile-"));
  const pi = makePi();
  await extension(pi as any);
  const { store, task, workspace } = startedTask(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    assignment: {
      role: "reviewer",
      objective: "offline review",
      scope: { description: "src", paths: ["src"], exclusions: [] },
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const control = pi.tools.find((tool) => tool.name === "workit_worker_control");
  const result = await control.execute(
    "control",
    { action: "reconcile", taskId: task.id, workerId: (assigned.data as { id: string }).id },
    undefined,
    undefined,
    context(root),
  );
  expect(result.details).toMatchObject({ ok: false, code: "recovery_required" });
  rmSync(root, { recursive: true, force: true });
});

const assignPiReviewer = (
  root: string,
  store: TaskStore,
  taskId: string,
  taskRev: string,
  wsRev: string,
) => {
  const core = new WorkitCore(store, {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: taskRev,
    expectedWorkspaceRevision: wsRev,
    assignment: {
      role: "reviewer",
      objective: "offline review",
      scope: { description: "src", paths: ["src"], exclusions: [] },
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  return (assigned.data as { id: string }).id;
};

test("uncertain cancel persists unknown state, and a missing task fails distinctly", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-cancel-"));
  try {
    const { store, task, workspace } = startedTask(root);
    const workerId = assignPiReviewer(root, store, task.id, task.revision, workspace.revision);
    const handle = {
      sessionId: `pi-worker-${workerId}`,
      pid: 4242,
      workerId,
      child: null,
      spawned: true,
      exit: null,
    } as any;
    // The real cancel path only reaches uncertainty for a launched worker.
    const freshTask = store.readTask(task.id);
    const freshWorkspace = store.readWorkspace();
    if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data)
      throw new Error("task refresh failed");
    const running = new WorkitCore(store, {
      root,
      caller: { host: "pi", actor: "pi-session" },
      callerAttested: true,
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
      nativeWorker: nativeWorkerForEvidence(() => handle),
    }).observeWorkerLifecycle({
      taskId: task.id,
      workerId,
      expectedRevision: freshTask.data.revision,
      expectedWorkspaceRevision: freshWorkspace.data.revision,
      state: "running",
      session: { kind: "host", host: "pi", handle: handle.sessionId },
      observation: { pid: handle.pid },
    });
    expect(running.ok).toBe(true);
    const exit = { state: "unknown", observed: false, code: null, signal: null, stderr: "" } as any;
    expect(persistUncertainCancel(store, context(root), task.id, workerId, handle, exit)).toBe(
      true,
    );
    const current = store.readTask(task.id);
    expect(
      current.ok && current.data.workers.find((entry) => entry.id === workerId)?.data.state,
    ).toBe("unknown");
    expect(
      persistUncertainCancel(store, context(root), "missing-task", workerId, handle, exit),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel without a live handle fails recovery_required instead of pretending", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-cancel-control-"));
  try {
    const pi = makePi();
    await extension(pi as any);
    const { store, task, workspace } = startedTask(root);
    const workerId = assignPiReviewer(root, store, task.id, task.revision, workspace.revision);
    const control = pi.tools.find((tool) => tool.name === "workit_worker_control");
    const result = await control.execute(
      "control",
      { action: "cancel", taskId: task.id, workerId },
      undefined,
      undefined,
      context(root),
    );
    expect(result.details).toMatchObject({
      ok: false,
      code: "recovery_required",
      error: "worker process is not live in this session",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
