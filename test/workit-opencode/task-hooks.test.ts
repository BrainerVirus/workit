import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, success } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import plugin from "@/packages/workit-opencode/src/plugin";
import { workerContextFor } from "@/packages/workit-opencode/src/runtime";
import { createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";

const user = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "p",
      messageID: "u",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

const assistant = (text: string) => ({
  info: { role: "assistant" as const, id: "a", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "a-p",
      messageID: "a",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

const activeTask = (root: string, actor = "lead", paths = ["."]) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
  });
  const started = core.task(
    taskStartRequest({
      intent: { objective: "test task", scope: scope({ paths }), authorityRefs: [] },
    }),
  );
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active task missing");
  return { store, core, task: task.data, workspace: workspace.data };
};

const userFor = (sessionID: string) => ({
  info: {
    role: "user" as const,
    id: `u-${sessionID}`,
    sessionID,
    time: { created: 0, updated: 0 },
  },
  parts: [
    {
      type: "text" as const,
      text: "continue",
      id: `p-${sessionID}`,
      messageID: `u-${sessionID}`,
      sessionID,
      time: { created: 0, updated: 0 },
    },
  ],
});

const workerAssignment = (
  core: WorkitCore,
  taskId: string,
  taskRevision: string,
  workspaceRevision: string,
  role: "reviewer" | "implementer",
) =>
  core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: taskRevision,
    expectedWorkspaceRevision: workspaceRevision,
    assignment: {
      role,
      objective: "inspect the assigned area",
      scope: scope({ paths: [role === "reviewer" ? "review" : "src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report the result",
    },
  });

const observeWorker = (
  root: string,
  actor: string,
  workerId: string,
  taskId: string,
  session: string,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
    nativeWorker: {
      verifyWorker: ({ expected, caller }) =>
        success(null, null, {
          kind: "host_observed",
          host: caller.host,
          session: expected.session,
          workerId: expected.workerId,
          receipts: [{ kind: "host", host: caller.host, handle: "native-worker" }],
        }),
    },
  });
  return core.observeWorkerLifecycle({
    taskId,
    workerId,
    expectedRevision,
    expectedWorkspaceRevision,
    state: "running",
    session: { kind: "host", host: "opencode", handle: session },
    observation: { event: "worker-started" },
  });
};

test("chat transformation does not infer methods from assistant phrases", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = {
    messages: [
      user("start"),
      assistant("I will implement this without design or tests."),
      user("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const text = output.messages[2].parts
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
  expect(text).not.toContain("workflow-detection");
  expect(text).not.toContain("workflow-tdd");
  expect(text).not.toContain("workflow-brainstorm");
});

test("nested native task workers are denied when lineage is not direct", async () => {
  const hooks = await plugin({
    client: { session: { get: async () => ({ data: { parentID: "worker" } }) } },
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  await expect(
    hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "worker", callID: "call" },
      { args: {} },
    ),
  ).rejects.toThrow("delegation_lineage_denied");
});

test("cancelled native workers are not silently reassigned", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  await hooks["tool.execute.after"]?.(
    { tool: "task", sessionID: "lead", callID: "task-call", args: {} },
    { title: "task", output: "worker cancellation is uncertain", metadata: {} },
  );
  await expect(
    hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "lead", callID: "next-call" },
      { args: {} },
    ),
  ).rejects.toThrow("recovery_required");
});

test("session discovery injects one bootstrap and one compact restoration", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-"));
  try {
    activeTask(root);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "lead", directory: root } }) } },
    } as never);
    const output = { messages: [userFor("lead")] };
    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    const text = output.messages[0].parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    expect(text.match(/<workit-contract>/g)?.length).toBe(1);
    expect(text.match(/<workit-task-context>/g)?.length).toBe(1);

    const compact = { context: [] as string[] };
    await hooks["experimental.session.compacting"]?.(
      { sessionID: "lead" } as never,
      compact as never,
    );
    await hooks["experimental.session.compacting"]?.(
      { sessionID: "lead" } as never,
      compact as never,
    );
    expect(compact.context).toHaveLength(1);
    expect(compact.context[0]).toContain("<workit-task-context>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct-child reviewer and implementer contexts are exact and lineage-bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-workers-"));
  try {
    const active = activeTask(root, "coord");
    const assignment = workerAssignment(
      active.core,
      active.task.id,
      active.task.revision,
      active.workspace.revision,
      "reviewer",
    );
    expect(assignment.ok).toBe(true);
    if (!assignment.ok) throw new Error(assignment.error);
    const assignedTask = active.store.readTask(active.task.id);
    const assignedWorkspace = active.store.readWorkspace();
    if (!assignedTask.ok || !assignedWorkspace.ok || !assignedWorkspace.data)
      throw new Error("assigned state missing");
    const observed = observeWorker(
      root,
      "coord",
      assignment.data.id,
      active.task.id,
      "reviewer-session",
      assignedTask.data.revision,
      assignedWorkspace.data.revision,
    );
    expect(observed.ok).toBe(true);

    const reviewerHooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: {
        session: {
          get: async ({ path: { id } }: { path: { id: string } }) => ({
            data: { id, directory: root, parentID: "coord" },
          }),
        },
      },
    } as never);
    await reviewerHooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      { title: "task", output: "started", metadata: { sessionID: "reviewer-session" } },
    );
    const reviewerOutput = { messages: [userFor("reviewer-session")] };
    await reviewerHooks["experimental.chat.messages.transform"]?.(
      {} as never,
      reviewerOutput as never,
    );
    const reviewerText = reviewerOutput.messages[0].parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    expect(reviewerText).toContain("<workit-worker-context>");
    expect(reviewerText).toContain('"role":"reviewer"');
    expect(reviewerText).toContain('"readOnly":true');
    expect(reviewerText).not.toContain("<workit-contract>");
    await expect(
      reviewerHooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "reviewer-session", callID: "reviewer-write" },
        { args: { filePath: join(root, "review/file.ts") } },
      ),
    ).rejects.toThrow("read-only worker");

    const currentTask = active.store.readTask(active.task.id);
    const currentWorkspace = active.store.readWorkspace();
    if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("current worker state missing");
    const implementer = workerAssignment(
      active.core,
      active.task.id,
      currentTask.data.revision,
      currentWorkspace.data.revision,
      "implementer",
    );
    expect(implementer.ok).toBe(true);
    if (!implementer.ok) throw new Error(implementer.error);
    const implementerTask = active.store.readTask(active.task.id);
    const implementerWorkspace = active.store.readWorkspace();
    if (!implementerTask.ok || !implementerWorkspace.ok || !implementerWorkspace.data)
      throw new Error("implementer assignment missing");
    expect(
      observeWorker(
        root,
        "coord",
        implementer.data.id,
        active.task.id,
        "implementer-session",
        implementerTask.data.revision,
        implementerWorkspace.data.revision,
      ).ok,
    ).toBe(true);
    await reviewerHooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch-implementer", args: {} },
      { title: "task", output: "started", metadata: { sessionID: "implementer-session" } },
    );
    const implementerOutput = { messages: [userFor("implementer-session")] };
    await reviewerHooks["experimental.chat.messages.transform"]?.(
      {} as never,
      implementerOutput as never,
    );
    const implementerText = implementerOutput.messages[0].parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    expect(implementerText).toContain("<workit-worker-context>");
    expect(implementerText).toContain('"role":"implementer"');
    expect(implementerText).toContain('"readOnly":false');
    expect(implementerText).toContain('"paths":["src"]');

    const mismatchedHooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: {
        session: {
          get: async ({ path: { id } }: { path: { id: string } }) => ({
            data: { id, directory: root, parentID: "other-coordinator" },
          }),
        },
      },
    } as never);
    const mismatchedOutput = { messages: [userFor("reviewer-session")] };
    await mismatchedHooks["experimental.chat.messages.transform"]?.(
      {} as never,
      mismatchedOutput as never,
    );
    const mismatchedText = mismatchedOutput.messages[0].parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    expect(mismatchedText).not.toContain("<workit-worker-context>");
    expect(mismatchedText).not.toContain('"role":"reviewer"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known write surfaces enforce the current writer while unknown shell writes stay agent-guided", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-writer-"));
  try {
    const active = activeTask(root, "owner");
    const acquired = active.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: {
        session: { get: async () => ({ data: { id: "other", directory: root } }) },
      },
    } as never);
    const calls = [
      { tool: "write", args: { path: "src/file.ts" } },
      { tool: "edit", args: { path: "src/file.ts" } },
      { tool: "bash", args: { command: "echo changed > src/file.ts" } },
    ];
    for (const input of calls)
      await expect(
        hooks["tool.execute.before"]?.(
          { ...input, sessionID: "other", callID: input.tool },
          { args: input.args },
        ),
      ).rejects.toThrow("writer_conflict");
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "other", callID: "opaque" },
        { args: { command: 'python -c \'open("src/file.ts", "w").write("x")\'' } },
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode affected-doc context gates an edit and public evidence captures the changed candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-affected-docs-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    const doc = join(root, "docs", "guide.md");
    const source = join(root, "src", "app.ts");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "src"));
    writeFileSync(doc, "# Guide\n");
    writeFileSync(source, "export const version = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(source, "export const version = 2;\n");
    spawnSync("git", ["add", source], { cwd: root });
    spawnSync("git", ["commit", "-qm", "source change"], { cwd: root });

    const contextResult = await (createWorkitTools() as any).workit_external_action.execute(
      { operation: "context.read", payload: { kind: "affected", range: "HEAD~1...HEAD" } },
      { directory: root, sessionID: "owner" },
    );
    const affected = JSON.parse(
      typeof contextResult === "string" ? contextResult : contextResult.output,
    );
    expect(affected).toMatchObject({ ok: true, data: { kind: "affected" } });
    expect(affected.data.context).toContain("docs/guide.md");
    expect(affected.data.context).toContain("src/app.ts");

    const active = activeTask(root, "owner", ["docs"]);
    const acquired = active.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
    const publicTools = createWorkitTools({
      client: { session: { get: async () => ({ data: { id: "owner", directory: root } }) } },
    }) as any;
    const recordEvidence = async (claim: string) => {
      const current = active.store.readTask(active.task.id);
      if (!current.ok) throw new Error(current.error);
      const result = await publicTools.workit_evidence.execute(
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
        { directory: root, sessionID: "owner" },
      );
      const value = JSON.parse(typeof result === "string" ? result : result.output);
      expect(value).toMatchObject({ ok: true });
    };
    await recordEvidence("affected docs before edit");
    const beforeTask = active.store.readTask(active.task.id);
    if (!beforeTask.ok) throw new Error(beforeTask.error);
    const beforeCandidate = beforeTask.data.candidates.at(-1);
    if (!beforeCandidate) throw new Error("pre-edit candidate missing");
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "owner", directory: root } }) } },
    } as never);
    const before = readFileSync(doc, "utf8");
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "owner", callID: "in-scope" },
        { args: { path: "docs/guide.md" } },
      ),
    ).resolves.toBeUndefined();
    writeFileSync(doc, `${before}Updated from affected-doc evidence.\n`);
    expect(readFileSync(doc, "utf8")).toContain("Updated from affected-doc evidence.");
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "owner", callID: "out-of-scope" },
        { args: { path: "src/app.ts" } },
      ),
    ).rejects.toThrow("scope");
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

test("ambiguous implementer sessions cannot authorize product writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-ambiguous-writer-"));
  try {
    const active = activeTask(root, "coord");
    const first = workerAssignment(
      active.core,
      active.task.id,
      active.task.revision,
      active.workspace.revision,
      "implementer",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    let task = active.store.readTask(active.task.id);
    let workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("assigned state missing");
    expect(
      observeWorker(
        root,
        "coord",
        first.data.id,
        active.task.id,
        "child",
        task.data.revision,
        workspace.data.revision,
      ).ok,
    ).toBe(true);
    task = active.store.readTask(active.task.id);
    workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("running state missing");
    const acquired = new WorkitCore(active.store, {
      root,
      caller: { host: "opencode", actor: "child" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
      workerId: first.data.id,
    }).writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.task.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: first.data.id,
    });
    if (!acquired.ok) throw new Error(acquired.error);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: {
        session: {
          get: async ({ path: { id } }: { path: { id: string } }) => ({
            data: { id, directory: root, parentID: "coord" },
          }),
        },
      },
    } as never);
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "child", callID: "single" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).resolves.toBeUndefined();

    task = active.store.readTask(active.task.id);
    workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("writer state missing");
    const second = workerAssignment(
      active.core,
      active.task.id,
      task.data.revision,
      workspace.data.revision,
      "implementer",
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    task = active.store.readTask(active.task.id);
    workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("second assignment missing");
    expect(
      observeWorker(
        root,
        "coord",
        second.data.id,
        active.task.id,
        "child",
        task.data.revision,
        workspace.data.revision,
      ).ok,
    ).toBe(true);
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "child", callID: "ambiguous" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).rejects.toThrow("permission_denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const coordinatorClient = (root: string, coordinator = "coord") => ({
  session: {
    get: async ({ path: { id } }: { path: { id: string } }) => ({
      data:
        id === coordinator
          ? { id, directory: root }
          : { id, directory: root, parentID: coordinator },
    }),
  },
});

const dispatchFixture = async (root: string, assignments = 1) => {
  const active = activeTask(root, "coord");
  const ids: string[] = [];
  for (let index = 0; index < assignments; index += 1) {
    const task = active.store.readTask(active.task.id);
    const workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const assigned = workerAssignment(
      active.core,
      active.task.id,
      task.data.revision,
      workspace.data.revision,
      "reviewer",
    );
    if (!assigned.ok) throw new Error(assigned.error);
    ids.push(assigned.data.id);
  }
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL("http://localhost"),
    client: coordinatorClient(root),
  } as never);
  return { active, ids, hooks };
};

const workerState = (
  active: ReturnType<typeof activeTask>,
  workerId: string,
): { state: string; session: unknown } => {
  const task = active.store.readTask(active.task.id);
  if (!task.ok) throw new Error(task.error);
  const worker = task.data.workers.find((entry) => entry.id === workerId);
  if (!worker) throw new Error("worker missing");
  return { state: worker.data.state, session: worker.data.session };
};

test("a prepared OpenCode dispatch binds the created child session", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-bind-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "coord", callID: "launch" },
      { args: {} },
    );
    const reserved = active.store.readTask(active.task.id);
    expect(
      reserved.ok && reserved.data.workers.find((entry) => entry.id === ids[0])?.provenance,
    ).toMatchObject({
      kind: "host_observed",
      session: { handle: "coord" },
      receipts: [{ kind: "host", host: "opencode", handle: "task:launch" }],
    });
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "child-1", parentID: "coord", directory: root } },
      },
    } as never);
    expect(workerState(active, ids[0])).toMatchObject({
      state: "running",
      session: { handle: "child-1" },
    });
    // The launch consumed the reservation, so a late "never started" claim cannot land.
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      { title: "task", output: "cancelled", metadata: { childCreated: false } },
    );
    expect(workerState(active, ids[0]).state).toBe("running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task call that proves no child was created stops the worker as never started", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-nostart-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "coord", callID: "launch" },
      { args: {} },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "assigned", session: null });
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      {
        title: "task",
        output: "cancelled",
        metadata: { childCreated: false, status: "cancelled" },
      },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "stopped", session: null });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: "coord", callID: "next" },
        { args: {} },
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a generic cancellation or missing metadata never marks an unbound worker stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-generic-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "coord", callID: "launch" },
      { args: {} },
    );
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      { title: "task", output: "worker cancellation is uncertain", metadata: {} },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "assigned", session: null });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: "coord", callID: "next" },
        { args: {} },
      ),
    ).rejects.toThrow("recovery_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous assignments refuse dispatch recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-ambiguous-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root, 2);
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "coord", callID: "launch" },
      { args: {} },
    );
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      {
        title: "task",
        output: "cancelled",
        metadata: { childCreated: false, status: "cancelled" },
      },
    );
    for (const id of ids)
      expect(workerState(active, id)).toMatchObject({ state: "assigned", session: null });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: "coord", callID: "next" },
        { args: {} },
      ),
    ).rejects.toThrow("recovery_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed task result stops the bound worker without waiting for end events", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-completed-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "child", directory: root, parentID: "coord" } },
      },
    } as never);
    expect(workerState(active, ids[0]).state).toBe("running");
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      {
        title: "task",
        output: '<task id="child" state="completed"><task_result>done</task_result></task>',
        metadata: { sessionId: "child", parentSessionId: "coord" },
      },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "stopped" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-completed task result leaves the bound worker running", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-error-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "child", directory: root, parentID: "coord" } },
      },
    } as never);
    expect(workerState(active, ids[0]).state).toBe("running");
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      {
        title: "task",
        output: '<task id="child" state="error"><task_result>boom</task_result></task>',
        metadata: { sessionId: "child", parentSessionId: "coord" },
      },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "running" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restarted plugin loses the reservation and stays blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-dispatch-restart-"));
  try {
    const { active, ids, hooks } = await dispatchFixture(root);
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "coord", callID: "launch" },
      { args: {} },
    );
    const restarted = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: coordinatorClient(root),
    } as never);
    await restarted["tool.execute.after"]?.(
      { tool: "task", sessionID: "coord", callID: "launch", args: {} },
      {
        title: "task",
        output: "cancelled",
        metadata: { childCreated: false, status: "cancelled" },
      },
    );
    expect(workerState(active, ids[0])).toMatchObject({ state: "assigned", session: null });
    await expect(
      restarted["tool.execute.before"]?.(
        { tool: "task", sessionID: "coord", callID: "next" },
        { args: {} },
      ),
    ).rejects.toThrow("recovery_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode native write shapes normalize filePath and apply_patch targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-native-writes-"));
  try {
    const active = activeTask(root, "owner");
    const acquired = active.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "owner", directory: root } }) } },
    } as never);
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "write" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "owner", callID: "edit" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "apply_patch", sessionID: "owner", callID: "patch" },
        { args: { patchText: "*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch" } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "apply_patch", sessionID: "owner", callID: "move" },
        { args: { patchText: "*** Begin Patch\n*** Move to: src/renamed.ts\n*** End Patch" } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "outside" },
        { args: { filePath: "/tmp/outside.ts" } },
      ),
    ).rejects.toThrow("invalid_input");
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "apply_patch", sessionID: "owner", callID: "opaque" },
        { args: { patchText: "*** Begin Patch\nplain content\n*** End Patch" } },
      ),
    ).rejects.toThrow("invalid_input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker context names the worker identity for self-references", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-worker-context-"));
  try {
    const active = activeTask(root, "coord");
    const first = workerAssignment(
      active.core,
      active.task.id,
      active.task.revision,
      active.workspace.revision,
      "reviewer",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    let task = active.store.readTask(active.task.id);
    let workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("assigned state missing");
    expect(
      observeWorker(
        root,
        "coord",
        first.data.id,
        active.task.id,
        "child",
        task.data.revision,
        workspace.data.revision,
      ).ok,
    ).toBe(true);
    const directChildren = new Map([["child", "coord"]]);
    const raw = workerContextFor(root, "child", "coord", directChildren);
    expect(raw).not.toBeNull();
    const context = JSON.parse(raw!);
    expect(context.workerId).toBe(first.data.id);
    expect(context.session).toEqual({ kind: "host", host: "opencode", handle: "child" });
    expect(context.taskId).toBe(active.task.id);
    expect(workerContextFor(root, "unknown", "coord", directChildren)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lead writes with several active tasks require writer ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-multi-task-"));
  try {
    const first = activeTask(root, "coord");
    const core = new WorkitCore(new TaskStore(root), {
      root,
      caller: { host: "opencode", actor: "coord" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
    });
    const started = core.task(
      taskStartRequest({
        intent: { objective: "second task", scope: scope({ paths: ["."] }), authorityRefs: [] },
        expectedWorkspaceRevision: undefined,
      }),
    );
    if (!started.ok) throw new Error(started.error);
    expect((started.data as { id: string }).id).not.toBe(first.task.id);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: coordinatorClient(root),
    } as never);
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "coord", callID: "multi" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).rejects.toThrow("multiple active tasks require writer ownership");
    const acquired = first.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: first.task.id,
      workerId: null,
    });
    if (!acquired.ok) throw new Error(acquired.error);
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "coord", callID: "owned" },
        { args: { filePath: join(root, "src/file.ts") } },
      ),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
