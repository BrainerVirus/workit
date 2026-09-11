import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  TaskStore,
  WorkitCore,
  OPERATION_SCHEMA_MAX_DEPTH,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
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

const context = (root: string, hasUI = false, trusted = true) => {
  const sessionManager = {
    getSessionId: () => "pi-session",
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
      approvedContent: "Proceed with the implementation.",
      contentRefs: [],
    },
    response: "approved",
    requirementIds: [],
  };
};

const nodeExecutable = "node";

const assertCurrentNode = () => {
  const result = spawnSync(nodeExecutable, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(result.stdout.trim()).toBe(`v${SUPPORT_MATRIX.node.current}`);
};

test("clean Pi package declares stock discovery and the eight families plus external action", async () => {
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
    "workit_writer",
    "workit_state",
    "workit_external_action",
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
    expect(depth(tool.parameters), tool.name).toBeLessThanOrEqual(OPERATION_SCHEMA_MAX_DEPTH);
  }
  expect(pi.commands.map((command) => command.name)).toContain("workit-worker");
});

test("Pi package ships the fourteen canonical method skills", () => {
  expect(readdirSync(path.join(import.meta.dir, "../../packages/workit-pi/skills")).sort()).toEqual(
    [
      "workit-babysit",
      "workit-behavioral-tdd",
      "workit-blast-radius",
      "workit-challenge",
      "workit-debug",
      "workit-deslop",
      "workit-diagram",
      "workit-green-run",
      "workit-handoff",
      "workit-implement",
      "workit-mockup",
      "workit-plan",
      "workit-review",
      "workit-steer",
    ],
  );
});

test("Pi registers wk- slash aliases that expand the bundled skill commands", async () => {
  const pi = makePi();
  await extension(pi as any);
  for (const [alias, skill] of [
    ["wk-challenge", "workit-challenge"],
    ["wk-babysit", "workit-babysit"],
    ["wk-implement", "workit-implement"],
    ["wk-plan", "workit-plan"],
    ["wk-debug", "workit-debug"],
    ["wk-review", "workit-review"],
    ["wk-handoff", "workit-handoff"],
    ["wk-tdd", "workit-behavioral-tdd"],
    ["wk-blast-radius", "workit-blast-radius"],
    ["wk-deslop", "workit-deslop"],
    ["wk-diagram", "workit-diagram"],
    ["wk-mockup", "workit-mockup"],
    ["wk-green-run", "workit-green-run"],
    ["wk-steer", "workit-steer"],
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

test("Pi tool payloads use the shared parser and headless decisions need input", async () => {
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
  expect(headless.details).toMatchObject({
    ok: false,
    code: "needs_input",
    details: { capability: "interactive_decision" },
  });
  expect(
    piCapabilities({ hasUI: false }).find((entry) => entry.name === "interactive_decision")
      ?.assurance,
  ).toBe("unavailable");
  expect(
    piCapabilities({ hasUI: true }).find((entry) => entry.name === "interactive_decision")
      ?.assurance,
  ).toBe("enforced");
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

test("interactive Pi decisions use the native answer and reject untrusted writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-decision-"));
  const pi = makePi();
  await extension(pi as any);
  const decisionTool = pi.tools.find((tool) => tool.name === "workit_decision");
  const result = await decisionTool.execute(
    "call",
    decisionInput(root),
    undefined,
    undefined,
    context(root, true),
  );
  expect(result.details).toMatchObject({ ok: true, data: { data: { response: "approved" } } });

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

test("Pi optional actions use native UI and the exact resolved descriptor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-action-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    const file = path.join(root, "tracked.txt");
    writeFileSync(file, "fixture\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const started = startedTask(root);
    const writerTask = started.store.readTask(started.task.id);
    const writerWorkspace = started.store.readWorkspace();
    if (!writerTask.ok || !writerWorkspace.ok || !writerWorkspace.data)
      throw new Error("writer state missing");
    expect(
      new WorkitCore(started.store, {
        root,
        caller: { host: "pi", actor: "pi-session" },
        capabilities: [],
        constraints: [],
        now: "2026-01-01T00:00:00Z",
      }).writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: writerTask.data.id,
        expectedRevision: writerTask.data.revision,
        expectedWorkspaceRevision: writerWorkspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    writeFileSync(path.join(root, "first-change.txt"), "first\n");
    spawnSync("git", ["add", "first-change.txt"], { cwd: root });
    let confirms = 0;
    const actionContext = context(root, true);
    actionContext.ui = {
      confirm: async () => {
        confirms += 1;
        if (confirms === 1) {
          writeFileSync(path.join(root, "drift.txt"), "drift\n");
          spawnSync("git", ["add", "drift.txt"], { cwd: root });
        }
        return true;
      },
    };
    const pi = makePi();
    await extension(pi as any);
    const action = pi.tools.find((tool) => tool.name === "workit_external_action");
    const result = await action.execute(
      "native-action-call",
      { operation: "git.commit", payload: { message: "no staged change" } },
      undefined,
      undefined,
      actionContext,
    );
    expect(result.details).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    ).toBe("fixture");
    const retry = await action.execute(
      "native-action-retry",
      { operation: "git.commit", payload: { message: "no staged change" } },
      undefined,
      undefined,
      actionContext,
    );
    expect(retry.details).toMatchObject({ ok: true });
    expect(confirms).toBe(2);
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    ).toBe("no staged change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi child registration omits coordinator-only optional actions", async () => {
  const previous = process.env.WORKIT_PI_WORKER_ID;
  process.env.WORKIT_PI_WORKER_ID = "worker-child";
  try {
    const pi = makePi();
    await extension(pi as any);
    expect(pi.tools.map((tool) => tool.name)).not.toContain("workit_external_action");
  } finally {
    if (previous === undefined) delete process.env.WORKIT_PI_WORKER_ID;
    else process.env.WORKIT_PI_WORKER_ID = previous;
  }
});

test("Pi documentation context remains available headlessly without mutation approval", async () => {
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
    const action = pi.tools.find((tool) => tool.name === "workit_external_action");
    const result = await action.execute(
      "docs-headless",
      { operation: "context.read", payload: { kind: "changelog" } },
      undefined,
      undefined,
      context(root, false),
    );
    expect(result.details.code).not.toBe("needs_input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi context.read returns Git context headlessly without project trust or Workit writes", async () => {
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
    const action = pi.tools.find((tool) => tool.name === "workit_external_action");
    const result = await action.execute(
      "context-read",
      { operation: "context.read", payload: { kind: "git" } },
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

test("Pi affected-doc context gates an edit and public evidence captures the changed candidate", async () => {
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
    const action = pi.tools.find((tool) => tool.name === "workit_external_action");
    const contextResult = await action.execute(
      "affected-docs",
      { operation: "context.read", payload: { kind: "affected", range: "HEAD~1...HEAD" } },
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
    const currentTask = active.store.readTask(active.task.id);
    const currentWorkspace = active.store.readWorkspace();
    if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("writer state missing");
    const acquired = new WorkitCore(active.store, {
      root,
      caller: { host: "pi", actor: "pi-session" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    }).writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: currentTask.data.id,
      expectedRevision: currentTask.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
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
    ).toMatchObject({ block: true });
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

test("npm installs the packed package without workspace protocol dependencies", async () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const packageRoot = path.join(repoRoot, "packages/workit-pi");
  const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-install-"));
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--workspace", packageRoot, "--pack-destination", stage],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0].filename;
  const consumer = path.join(stage, "consumer");
  mkdirSync(consumer);
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      consumer,
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(stage, filename),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  try {
    expect(installed.status, installed.stderr || installed.stdout).toBe(0);
    expect(
      readFileSync(
        path.join(consumer, "node_modules/@brainervirus/workit-pi/package.json"),
        "utf8",
      ),
    ).toContain('"name": "@brainervirus/workit-pi"');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("stock Pi discovers the package manifest through its local package manager", async () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const packageRoot = path.join(repoRoot, "packages/workit-pi");
  const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-discovery-"));
  const isolated = path.join(stage, "project");
  const agentDir = path.join(stage, "agent");
  mkdirSync(isolated);
  mkdirSync(agentDir);
  const piBin = path.join(
    repoRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  assertCurrentNode();
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--workspace", packageRoot, "--pack-destination", stage],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0].filename;
  const extracted = path.join(stage, "extract");
  mkdirSync(extracted);
  const unpacked = spawnSync("tar", ["-xzf", path.join(stage, filename), "-C", extracted], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (unpacked.status !== 0) throw new Error(unpacked.stderr || unpacked.stdout);
  const installed = spawnSync(
    nodeExecutable,
    [piBin, "install", path.join(extracted, "package"), "-l", "--approve"],
    {
      cwd: isolated,
      env,
      encoding: "utf8",
    },
  );
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout);
  const child = spawn(
    nodeExecutable,
    [piBin, "--mode", "rpc", "--no-session", "--approve", "--offline", "--no-context-files"],
    {
      cwd: isolated,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  const responses = new Map<string, any>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf("\n");
      if (end < 0) break;
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === "response" && typeof message.command === "string")
        responses.set(message.command, message);
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    child.stdin.write('{"id":"commands","type":"get_commands"}\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi discovery timeout: ${stderr}`)), 10000);
      const poll = () => {
        if (responses.has("get_commands")) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(poll, 10);
      };
      poll();
    });
    expect(
      (responses.get("get_commands").data.commands as Array<{ name: string }>)
        .filter((command) => command.name.startsWith("skill:workit-"))
        .map((command) => command.name)
        .sort(),
    ).toHaveLength(14);
    expect(
      (responses.get("get_commands").data.commands as Array<{ name: string }>).map(
        (command) => command.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "wk-challenge",
        "wk-babysit",
        "wk-implement",
        "wk-plan",
        "wk-debug",
        "wk-review",
        "wk-handoff",
        "wk-tdd",
        "wk-blast-radius",
        "wk-deslop",
        "wk-diagram",
        "wk-mockup",
        "wk-green-run",
        "wk-steer",
      ]),
    );
    expect(stderr).toBe("");
  } finally {
    child.kill();
    rmSync(stage, { recursive: true, force: true });
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
