import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, externalActionDescriptor } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";
import plugin from "@/packages/workit-opencode/src/plugin";
import { NativeReceiptStore, createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";
import { tool } from "@opencode-ai/plugin";

const context = {
  directory: "/repo",
  worktree: "/repo",
  serverUrl: new URL("http://localhost"),
};

const fakeClock = (initial: string) => {
  const RealDate = globalThis.Date;
  let current = initial;
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      super(args.length ? args[0] : current);
    }
    static now(): number {
      return RealDate.parse(current);
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor;
  return {
    set(value: string) {
      current = value;
    },
    restore() {
      globalThis.Date = RealDate;
    },
  };
};

const createChangelogActionFixture = (actor: string, initial?: Uint8Array) => {
  const root = mkdtempSync(join(tmpdir(), `workit-opencode-${actor}-`));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    spawnSync("git", args, { cwd: root });
  writeFileSync(join(root, "initial.txt"), "initial\n");
  if (initial !== undefined) writeFileSync(join(root, "CHANGELOG.md"), initial);
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const store = new TaskStore(root);
  const setupCore = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = setupCore.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
  const writer = setupCore.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workerId: null,
  });
  if (!writer.ok) throw new Error(writer.error);
  const decisionTask = store.readTask(task.data.id);
  const decisionWorkspace = store.readWorkspace();
  if (!decisionTask.ok || !decisionWorkspace.ok || !decisionWorkspace.data)
    throw new Error("writer refresh failed");
  const receipts = new NativeReceiptStore();
  const tools = createWorkitTools({
    receipts,
    client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
  }) as any;
  return {
    root,
    store,
    actor,
    task: decisionTask.data,
    workspace: decisionWorkspace.data,
    receipts,
    tools,
  };
};

const approveChangelogAction = async (
  fixture: ReturnType<typeof createChangelogActionFixture>,
  request: { operation: "changelog.apply"; payload: Record<string, unknown> },
) => {
  const resolved = resolveExternalActionRequest(fixture.root, request);
  if (!resolved.ok) throw new Error(resolved.error);
  const descriptor = externalActionDescriptor(
    resolved.data.request.operation,
    resolved.data.descriptorPayload,
  );
  fixture.receipts.record(
    {
      sessionID: fixture.actor,
      callID: `changelog-${fixture.actor}`,
      args: {
        questions: [
          {
            header: "Workit decision: action",
            question: `Approve ${descriptor}`,
            options: [
              { label: "approved", description: descriptor },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  return fixture.tools.workit_decision.execute(
    {
      schemaVersion: 1,
      action: "record",
      taskId: fixture.task.id,
      expectedRevision: fixture.task.revision,
      purpose: "action",
      binding: {
        taskId: fixture.task.id,
        workspaceId: fixture.workspace.id,
        scope: fixture.task.intent.data.scope,
        presented: `Approve ${descriptor}`,
        approvedContent: descriptor,
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    { directory: fixture.root, sessionID: fixture.actor },
  );
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
    "workit_external_action",
  ]);
});

test("OpenCode invokes the host-owned documentation context headlessly through the shared effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-action-"));
  try {
    const tools = createWorkitTools();
    const result = await tools.workit_external_action.execute(
      { operation: "context.read", payload: { kind: "changelog" } },
      { directory: process.cwd(), sessionID: "opencode-action-test" } as never,
    );
    const serialized = typeof result === "string" ? result : (result as { output: string }).output;
    expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 1, ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode context.read returns Git context without approval or Workit writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-read-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    const tools = createWorkitTools();
    const result = await (tools as any).workit_external_action.execute(
      { operation: "context.read", payload: { kind: "git" } },
      { directory: root, sessionID: "context-read" },
    );
    const value = JSON.parse(typeof result === "string" ? result : result.output);
    expect(value).toMatchObject({
      ok: true,
      data: { kind: "git", context: { workspace_root: root } },
    });
    expect(typeof value.data.context.branch).toBe("string");
    expect(
      spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    ).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode context.read release includes a deterministic draft without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-release-context-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "release.txt"), "release\n");
    spawnSync("git", ["add", "release.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "release candidate"], { cwd: root });
    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    const tools = createWorkitTools() as any;
    const result = await tools.workit_external_action.execute(
      { operation: "context.read", payload: { kind: "release", range: "HEAD~1...HEAD" } },
      { directory: root, sessionID: "release-context" },
    );
    const value = JSON.parse(typeof result === "string" ? result : result.output);
    expect(value).toMatchObject({ ok: true, data: { kind: "release" } });
    expect(value.data.context).toContain("## Release Notes Draft");
    expect(value.data.context).toContain("release candidate");
    expect(value.data.context).toContain("release.txt");
    expect(
      spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    ).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode context.read rejects option-like ranges before invoking Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-range-"));
  const injected = join(tmpdir(), `workit-context-output-${process.pid}`);
  rmSync(injected, { force: true });
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const tools = createWorkitTools() as any;
    const result = await tools.workit_external_action.execute(
      { operation: "context.read", payload: { kind: "changelog", range: `--output=${injected}` } },
      { directory: root, sessionID: "context-range" },
    );
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(existsSync(injected)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(injected, { force: true });
  }
});

test("OpenCode context.read reports Git capability failure for a non-repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-nonrepo-"));
  try {
    const tools = createWorkitTools() as any;
    const result = await tools.workit_external_action.execute(
      { operation: "context.read", payload: { kind: "git" } },
      { directory: root, sessionID: "context-nonrepo" },
    );
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { capability: "git" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode YouTrack context reads a fixed file without migration or secret fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-youtrack-"));
  const configHome = mkdtempSync(join(tmpdir(), "workit-opencode-config-"));
  const previous = {
    xdg: process.env.XDG_CONFIG_HOME,
    direct: process.env.WORKFLOW_YOUTRACK_CONFIG,
    toolkit: process.env.WORKFLOW_TOOLKIT_CONFIG,
    toolkitDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  };
  try {
    delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = configHome;
    const current = join(configHome, "workit");
    mkdirSync(current, { recursive: true });
    writeFileSync(
      join(current, "youtrack.json"),
      JSON.stringify({
        baseUrl: "https://youtrack.example.test",
        tokenFile: "secret.token",
        hidden: "do-not-return",
      }),
    );
    const tools = createWorkitTools() as any;
    const result = await tools.workit_external_action.execute(
      { operation: "context.read", payload: { kind: "youtrack", mode: "meetings" } },
      { directory: root, sessionID: "context-youtrack" },
    );
    const value = JSON.parse(typeof result === "string" ? result : result.output);
    expect(value).toMatchObject({
      ok: true,
      data: { context: { config: { baseUrl: "https://youtrack.example.test" } } },
    });
    expect(JSON.stringify(value)).not.toContain("secret.token");
    expect(JSON.stringify(value)).not.toContain("do-not-return");
  } finally {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.direct === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previous.direct;
    if (previous.toolkit === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous.toolkit;
    if (previous.toolkitDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous.toolkitDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("OpenCode YouTrack context rejects spec and plan paths outside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-youtrack-root-"));
  const outside = mkdtempSync(join(tmpdir(), "workit-opencode-context-youtrack-outside-"));
  const configPath = join(root, "youtrack.json");
  const outsideSpec = join(outside, "spec.md");
  const link = join(root, "linked-spec.md");
  const previous = process.env.WORKFLOW_YOUTRACK_CONFIG;
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ baseUrl: "https://youtrack.example.test", greetings: { morning: "hola" } }),
    );
    writeFileSync(outsideSpec, "**YouTrack:** NSR-40\n");
    symlinkSync(outsideSpec, link);
    process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
    const tools = createWorkitTools() as any;
    for (const specPath of [outsideSpec, "linked-spec.md"]) {
      const result = await tools.workit_external_action.execute(
        { operation: "context.read", payload: { kind: "youtrack", specPath } },
        { directory: root, sessionID: "context-youtrack-boundary" },
      );
      expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
        ok: false,
        code: "capability_unavailable",
      });
    }
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("OpenCode changelog.apply uses the approved target and existing writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-changelog-apply-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n");
    spawnSync("git", ["add", "CHANGELOG.md"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const actor = "opencode-changelog-action";
    const store = new TaskStore(root);
    const setupCore = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = setupCore.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    expect(
      setupCore.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    const decisionTask = store.readTask(task.data.id);
    const decisionWorkspace = store.readWorkspace();
    if (!decisionTask.ok || !decisionWorkspace.ok || !decisionWorkspace.data)
      throw new Error("writer refresh failed");
    const request = {
      operation: "changelog.apply" as const,
      payload: {
        path: "CHANGELOG.md",
        entries: [{ category: "Added", text: "Native changelog action" }],
      },
    };
    const resolved = resolveExternalActionRequest(root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    const descriptor = externalActionDescriptor(
      resolved.data.request.operation,
      resolved.data.descriptorPayload,
    );
    const receipts = new NativeReceiptStore();
    receipts.record(
      {
        sessionID: actor,
        callID: "changelog-question",
        args: {
          questions: [
            {
              header: "Workit decision: action",
              question: `Approve ${descriptor}`,
              options: [
                { label: "approved", description: descriptor },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    }) as any;
    const decision = await tools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: decisionTask.data.id,
        expectedRevision: decisionTask.data.revision,
        purpose: "action",
        binding: {
          taskId: decisionTask.data.id,
          workspaceId: decisionWorkspace.data.id,
          scope: decisionTask.data.intent.data.scope,
          presented: `Approve ${descriptor}`,
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: actor },
    );
    expect(JSON.parse(typeof decision === "string" ? decision : decision.output)).toMatchObject({
      ok: true,
    });
    const result = await tools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("Native changelog action");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode changelog.apply refuses approval-time file drift without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-changelog-drift-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    const changelog = join(root, "CHANGELOG.md");
    writeFileSync(changelog, "# Changelog\n\n## [Unreleased]\n\n");
    spawnSync("git", ["add", "CHANGELOG.md"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const actor = "opencode-changelog-drift";
    const store = new TaskStore(root);
    const setupCore = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = setupCore.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    expect(
      setupCore.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    const decisionTask = store.readTask(task.data.id);
    const decisionWorkspace = store.readWorkspace();
    if (!decisionTask.ok || !decisionWorkspace.ok || !decisionWorkspace.data)
      throw new Error("writer refresh failed");
    const request = {
      operation: "changelog.apply" as const,
      payload: {
        path: "CHANGELOG.md",
        entries: [{ category: "Added", text: "Must not apply after drift" }],
      },
    };
    const resolved = resolveExternalActionRequest(root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    const descriptor = externalActionDescriptor(
      resolved.data.request.operation,
      resolved.data.descriptorPayload,
    );
    const receipts = new NativeReceiptStore();
    receipts.record(
      {
        sessionID: actor,
        callID: "changelog-drift-question",
        args: {
          questions: [
            {
              header: "Workit decision: action",
              question: `Approve ${descriptor}`,
              options: [
                { label: "approved", description: descriptor },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    }) as any;
    const decision = await tools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: decisionTask.data.id,
        expectedRevision: decisionTask.data.revision,
        purpose: "action",
        binding: {
          taskId: decisionTask.data.id,
          workspaceId: decisionWorkspace.data.id,
          scope: decisionTask.data.intent.data.scope,
          presented: `Approve ${descriptor}`,
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: actor },
    );
    expect(JSON.parse(typeof decision === "string" ? decision : decision.output)).toMatchObject({
      ok: true,
    });
    const before = readFileSync(changelog, "utf8");
    writeFileSync(changelog, `${before}outside approval drift\n`);
    const result = await tools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "permission_denied",
    });
    expect(readFileSync(changelog, "utf8")).toBe(`${before}outside approval drift\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode changelog.apply binds missing-file state separately from the skeleton bytes", async () => {
  const fixture = createChangelogActionFixture("opencode-changelog-missing");
  try {
    const request = {
      operation: "changelog.apply" as const,
      payload: {
        path: "CHANGELOG.md",
        entries: [{ category: "Added", text: "Must not replace a newly-created file" }],
      },
    };
    const approval = await approveChangelogAction(fixture, request);
    expect(JSON.parse(typeof approval === "string" ? approval : approval.output)).toMatchObject({
      ok: true,
    });
    const skeleton =
      "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n## [Unreleased]\n\n";
    writeFileSync(join(fixture.root, "CHANGELOG.md"), skeleton);
    const result = await fixture.tools.workit_external_action.execute(request, {
      directory: fixture.root,
      sessionID: fixture.actor,
    });
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "permission_denied",
    });
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toBe(skeleton);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode changelog.apply rejects invalid UTF-8 drift before writing", async () => {
  const fixture = createChangelogActionFixture(
    "opencode-changelog-invalid",
    Buffer.from("# Changelog\n\n## [Unreleased]\n\n", "utf8"),
  );
  try {
    const request = {
      operation: "changelog.apply" as const,
      payload: {
        path: "CHANGELOG.md",
        entries: [{ category: "Added", text: "Must not overwrite binary drift" }],
      },
    };
    const approval = await approveChangelogAction(fixture, request);
    expect(JSON.parse(typeof approval === "string" ? approval : approval.output)).toMatchObject({
      ok: true,
    });
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
    writeFileSync(join(fixture.root, "CHANGELOG.md"), invalid);
    const result = await fixture.tools.workit_external_action.execute(request, {
      directory: fixture.root,
      sessionID: fixture.actor,
    });
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"))).toEqual(invalid);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode action route consumes the exact native receipt before committing", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-native-action-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    writeFileSync(join(root, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: root });
    const actor = "opencode-action-session";
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = core.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    expect(
      core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    const decisionTask = store.readTask(task.data.id);
    const decisionWorkspace = store.readWorkspace();
    if (!decisionTask.ok || !decisionWorkspace.ok || !decisionWorkspace.data)
      throw new Error("writer refresh failed");
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.commit",
      payload: { message: "native commit" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const descriptor = externalActionDescriptor(
      resolved.data.request.operation,
      resolved.data.descriptorPayload,
    );
    const receipts = new NativeReceiptStore();
    receipts.record(
      {
        sessionID: actor,
        callID: "action-question",
        args: {
          questions: [
            {
              header: "Workit decision: action",
              question: `Approve ${descriptor}`,
              options: [
                { label: "approved", description: descriptor },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    });
    const nativeTools = tools as any;
    const decision = await nativeTools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: decisionTask.data.id,
        expectedRevision: decisionTask.data.revision,
        purpose: "action",
        binding: {
          taskId: decisionTask.data.id,
          workspaceId: decisionWorkspace.data.id,
          scope: decisionTask.data.intent.data.scope,
          presented: `Approve ${descriptor}`,
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: actor } as never,
    );
    expect(
      JSON.parse(typeof decision === "string" ? decision : (decision as { output: string }).output),
    ).toMatchObject({ ok: true });
    const action = await nativeTools.workit_external_action.execute(
      { operation: "git.commit", payload: { message: "native commit" } },
      { directory: root, sessionID: actor } as never,
    );
    expect(
      JSON.parse(typeof action === "string" ? action : (action as { output: string }).output),
    ).toMatchObject({ ok: true });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    ).toBe("native commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode child sessions cannot invoke the coordinator-only action route", async () => {
  const tools = createWorkitTools({
    client: {
      session: {
        get: async () => ({
          data: { id: "child", directory: process.cwd(), parentID: "coordinator" },
        }),
      },
    },
  }) as any;
  const result = await tools.workit_external_action.execute(
    { operation: "git.commit", payload: { message: "forbidden" } },
    { directory: process.cwd(), sessionID: "child" },
  );
  const serialized = typeof result === "string" ? result : result.output;
  expect(JSON.parse(serialized)).toMatchObject({ ok: false, code: "permission_denied" });
});

test("OpenCode reports a missing hosting CLI before reserving a pull request", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-no-gh-"));
  const oldConfig = process.env.WORKFLOW_VCS_CONFIG;
  const oldPath = process.env.PATH;
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], {
      cwd: root,
    });
    const emptyBin = mkdtempSync(join(tmpdir(), "workit-empty-bin-"));
    symlinkSync(
      spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(),
      join(emptyBin, "git"),
    );
    const tokenPath = join(root, "token");
    const configPath = join(root, "vcs.json");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "github", github: { tokenFile: tokenPath } }),
    );
    process.env.WORKFLOW_VCS_CONFIG = configPath;
    process.env.PATH = emptyBin;
    const tools = createWorkitTools() as any;
    const result = await tools.workit_external_action.execute(
      {
        operation: "hosting.pull_request",
        payload: { title: "No CLI", body: "must not reserve" },
      },
      { directory: root, sessionID: "no-gh" },
    );
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { capability: "hosting.pull_request", outcome: "not_started" },
    });
    rmSync(emptyBin, { recursive: true, force: true });
  } finally {
    if (oldConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = oldConfig;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode hosting action reconciles a matching provider result without retrying the effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-hosting-read-"));
  const oldConfig = process.env.WORKFLOW_VCS_CONFIG;
  const oldPath = process.env.PATH;
  const oldFetch = globalThis.fetch;
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], { cwd: root });
    const bin = mkdtempSync(join(tmpdir(), "workit-fake-gh-"));
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nexit 1\n");
    chmodSync(gh, 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const tokenPath = join(root, "token");
    const configPath = join(root, "vcs.json");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "github",
        github: { tokenFile: tokenPath },
        pr: { pushBranch: false },
      }),
    );
    process.env.WORKFLOW_VCS_CONFIG = configPath;
    const actor = "opencode-hosting-session";
    const store = new TaskStore(root);
    const setupCore = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = setupCore.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    expect(
      setupCore.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    const decisionTask = store.readTask(task.data.id);
    const decisionWorkspace = store.readWorkspace();
    if (!decisionTask.ok || !decisionWorkspace.ok || !decisionWorkspace.data)
      throw new Error("writer refresh failed");
    const request = {
      operation: "hosting.pull_request" as const,
      payload: { title: "Offline PR", body: "test", target_branch: "main" },
    };
    const resolved = resolveExternalActionRequest(root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    const descriptor = externalActionDescriptor(
      resolved.data.request.operation,
      resolved.data.descriptorPayload,
    );
    const receipts = new NativeReceiptStore();
    receipts.record(
      {
        sessionID: actor,
        callID: "hosting-question",
        args: {
          questions: [
            {
              header: "Workit decision: action",
              question: `Approve ${descriptor}`,
              options: [
                { label: "approved", description: descriptor },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    }) as any;
    const decision = await tools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: decisionTask.data.id,
        expectedRevision: decisionTask.data.revision,
        purpose: "action",
        binding: {
          taskId: decisionTask.data.id,
          workspaceId: decisionWorkspace.data.id,
          scope: decisionTask.data.intent.data.scope,
          presented: `Approve ${descriptor}`,
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: actor },
    );
    expect(JSON.parse(typeof decision === "string" ? decision : decision.output)).toMatchObject({
      ok: true,
    });
    const source = resolved.data.descriptorPayload as {
      target_branch: string;
      resolved: { source_branch: string; source_commit: string; marker: string };
    };
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [
        {
          number: 99,
          body: source.resolved.marker,
          base: { ref: source.target_branch },
          head: { ref: source.resolved.source_branch, sha: source.resolved.source_commit },
        },
      ],
    })) as unknown as typeof fetch;
    const first = await tools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(JSON.parse(typeof first === "string" ? first : first.output)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    const second = await tools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(JSON.parse(typeof second === "string" ? second : second.output)).toMatchObject({
      ok: true,
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = oldConfig;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([undefined, 5])(
  "OpenCode YouTrack update uses separate approved comment/time effects and does not replay success (%s minutes)",
  async (minutes?: number) => {
    const root = mkdtempSync(
      join(tmpdir(), `workit-opencode-youtrack-success-${minutes ?? "comment-only"}-`),
    );
    const configPath = join(root, "youtrack.json");
    const tokenPath = join(root, "youtrack.token");
    const previousConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
    const previousWrite = process.env.WORKFLOW_YT_WRITE;
    const previousFetch = globalThis.fetch;
    const clock = fakeClock("2026-01-01T23:59:00Z");
    try {
      writeFileSync(tokenPath, "test-token\n");
      chmodSync(tokenPath, 0o600);
      writeFileSync(
        configPath,
        JSON.stringify({ baseUrl: "https://yt.example", tokenFile: tokenPath, timezone: "UTC" }),
      );
      process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
      process.env.WORKFLOW_YT_WRITE = "1";
      let commentPosts = 0;
      let timePosts = 0;
      globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
        const url = String(_input);
        if (init?.method === "POST" && url.includes("/comments")) {
          commentPosts += 1;
          clock.set("2026-01-02T00:01:00Z");
          return { ok: true, text: async () => "{}" };
        }
        if (init?.method === "POST" && url.includes("/workItems")) {
          timePosts += 1;
          return { ok: true, text: async () => JSON.stringify({ id: "work-1" }) };
        }
        throw new Error(`unexpected YouTrack read: ${url}`);
      }) as unknown as typeof fetch;

      const actor = "opencode-youtrack-success";
      const store = new TaskStore(root);
      const setupCore = new WorkitCore(store, {
        root,
        caller: { host: "opencode", actor },
        capabilities: [],
        constraints: [],
        now: "2026-01-01T00:00:00Z",
      });
      const started = setupCore.task(taskStartRequest());
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const task = store.readTask((started.data as { id: string }).id);
      const workspace = store.readWorkspace();
      if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
      const request = {
        operation: "youtrack.update" as const,
        payload: {
          issueId: "ABC-1",
          markdown: "Approved update",
          ...(minutes === undefined ? {} : { minutes }),
        },
      };
      const resolved = resolveExternalActionRequest(root, request);
      if (!resolved.ok) throw new Error(resolved.error);
      const descriptor = externalActionDescriptor(
        resolved.data.request.operation,
        resolved.data.descriptorPayload,
      );
      const receipts = new NativeReceiptStore();
      receipts.record(
        {
          sessionID: actor,
          callID: "youtrack-success-question",
          args: {
            questions: [
              {
                header: "Workit decision: action",
                question: `Approve ${descriptor}`,
                options: [
                  { label: "approved", description: descriptor },
                  { label: "rejected", description: "Reject this decision" },
                ],
              },
            ],
          },
        },
        { metadata: { answers: [["approved"]] } },
      );
      const tools = createWorkitTools({
        receipts,
        client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
      }) as any;
      const decision = await tools.workit_decision.execute(
        {
          schemaVersion: 1,
          action: "record",
          taskId: task.data.id,
          expectedRevision: task.data.revision,
          purpose: "action",
          binding: {
            taskId: task.data.id,
            workspaceId: workspace.data.id,
            scope: task.data.intent.data.scope,
            presented: `Approve ${descriptor}`,
            approvedContent: descriptor,
            contentRefs: [],
          },
          response: "approved",
          requirementIds: [],
        },
        { directory: root, sessionID: actor },
      );
      expect(JSON.parse(typeof decision === "string" ? decision : decision.output)).toMatchObject({
        ok: true,
      });

      const first = await tools.workit_external_action.execute(request, {
        directory: root,
        sessionID: actor,
      });
      expect(JSON.parse(typeof first === "string" ? first : first.output)).toMatchObject({
        ok: true,
      });
      expect({ commentPosts, timePosts }).toEqual({
        commentPosts: 1,
        timePosts: minutes === undefined ? 0 : 1,
      });
      const repeat = await tools.workit_external_action.execute(request, {
        directory: root,
        sessionID: actor,
      });
      expect(JSON.parse(typeof repeat === "string" ? repeat : repeat.output)).toMatchObject({
        ok: false,
        code: "permission_denied",
      });
      expect({ commentPosts, timePosts }).toEqual({
        commentPosts: 1,
        timePosts: minutes === undefined ? 0 : 1,
      });
    } finally {
      globalThis.fetch = previousFetch;
      clock.restore();
      if (previousConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
      else process.env.WORKFLOW_YOUTRACK_CONFIG = previousConfig;
      if (previousWrite === undefined) delete process.env.WORKFLOW_YT_WRITE;
      else process.env.WORKFLOW_YT_WRITE = previousWrite;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("OpenCode rejects unavailable YouTrack writes before reservation", async () => {
  const fixture = createChangelogActionFixture("opencode-youtrack-unavailable");
  const configPath = join(fixture.root, "youtrack.json");
  const tokenPath = join(fixture.root, "youtrack.token");
  const previousConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
  const previousWrite = process.env.WORKFLOW_YT_WRITE;
  try {
    writeFileSync(tokenPath, "test-token\n");
    chmodSync(tokenPath, 0o600);
    writeFileSync(
      configPath,
      JSON.stringify({ baseUrl: "https://yt.example", tokenFile: tokenPath, timezone: "UTC" }),
    );
    process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
    delete process.env.WORKFLOW_YT_WRITE;
    const request = {
      operation: "youtrack.update" as const,
      payload: { issueId: "ABC-1", markdown: "Unavailable update" },
    };
    const noFlag = await fixture.tools.workit_external_action.execute(request, {
      directory: fixture.root,
      sessionID: fixture.actor,
    });
    expect(JSON.parse(typeof noFlag === "string" ? noFlag : noFlag.output)).toMatchObject({
      ok: false,
      code: "capability_unavailable",
    });

    process.env.WORKFLOW_YT_WRITE = "1";
    rmSync(tokenPath);
    const noToken = await fixture.tools.workit_external_action.execute(request, {
      directory: fixture.root,
      sessionID: fixture.actor,
    });
    expect(JSON.parse(typeof noToken === "string" ? noToken : noToken.output)).toMatchObject({
      ok: false,
      code: "capability_unavailable",
    });
  } finally {
    if (previousConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previousConfig;
    if (previousWrite === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previousWrite;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode YouTrack time response loss reconciles the exact applied item without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-youtrack-unknown-"));
  const configPath = join(root, "youtrack.json");
  const tokenPath = join(root, "youtrack.token");
  const previousConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
  const previousWrite = process.env.WORKFLOW_YT_WRITE;
  const previousFetch = globalThis.fetch;
  const clock = fakeClock("2026-01-01T23:59:00Z");
  try {
    writeFileSync(tokenPath, "test-token\n");
    chmodSync(tokenPath, 0o600);
    writeFileSync(
      configPath,
      JSON.stringify({ baseUrl: "https://yt.example", tokenFile: tokenPath, timezone: "UTC" }),
    );
    process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
    process.env.WORKFLOW_YT_WRITE = "1";
    let commentPosts = 0;
    let timePosts = 0;
    let appliedComment = "";
    let appliedWork: { id: string; text: string; date: number; minutes: number } | null = null;
    let loseTimeResponse = true;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const url = String(_input);
      if (init?.method === "POST" && url.includes("/comments")) {
        commentPosts += 1;
        const body = JSON.parse(String(init.body));
        appliedComment = String(body.text);
        clock.set("2026-01-02T00:01:00Z");
        return { ok: true, text: async () => "{}" };
      }
      if (init?.method === "POST" && url.includes("/workItems")) {
        timePosts += 1;
        const body = JSON.parse(String(init.body));
        appliedWork = {
          id: "work-1",
          text: String(body.text),
          date: Number(body.date),
          minutes: Number(body.duration.minutes),
        };
        if (loseTimeResponse)
          throw new Error("connection lost after YouTrack applied the work item");
        return { ok: true, text: async () => JSON.stringify({ id: "work-1" }) };
      }
      if (init?.method === "GET" && url.includes("/comments"))
        return {
          ok: true,
          text: async () =>
            JSON.stringify([{ id: "comment-1", text: appliedComment, deleted: false }]),
        };
      if (init?.method === "GET" && url.includes("/workItems"))
        return {
          ok: true,
          text: async () =>
            JSON.stringify(
              appliedWork
                ? [
                    {
                      id: appliedWork.id,
                      text: appliedWork.text,
                      date: appliedWork.date,
                      duration: { minutes: appliedWork.minutes },
                    },
                  ]
                : [],
            ),
        };
      throw new Error(`unexpected YouTrack request: ${url}`);
    }) as unknown as typeof fetch;

    const actor = "opencode-youtrack-unknown";
    const store = new TaskStore(root);
    const setupCore = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = setupCore.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    const request = {
      operation: "youtrack.update" as const,
      payload: { issueId: "ABC-1", markdown: "Applied update", minutes: 45 },
    };
    const resolved = resolveExternalActionRequest(root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    const descriptor = externalActionDescriptor(
      resolved.data.request.operation,
      resolved.data.descriptorPayload,
    );
    const receipts = new NativeReceiptStore();
    receipts.record(
      {
        sessionID: actor,
        callID: "youtrack-unknown-question",
        args: {
          questions: [
            {
              header: "Workit decision: action",
              question: `Approve ${descriptor}`,
              options: [
                { label: "approved", description: descriptor },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    }) as any;
    const decision = await tools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        purpose: "action",
        binding: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: `Approve ${descriptor}`,
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: actor },
    );
    expect(JSON.parse(typeof decision === "string" ? decision : decision.output)).toMatchObject({
      ok: true,
    });

    const first = await tools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(JSON.parse(typeof first === "string" ? first : first.output)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    expect({ commentPosts, timePosts }).toEqual({ commentPosts: 1, timePosts: 1 });
    loseTimeResponse = false;
    const freshTools = createWorkitTools({
      client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
    }) as any;
    const reconciled = await freshTools.workit_external_action.execute(request, {
      directory: root,
      sessionID: actor,
    });
    expect(
      JSON.parse(typeof reconciled === "string" ? reconciled : reconciled.output),
    ).toMatchObject({ ok: true });
    expect({ commentPosts, timePosts }).toEqual({ commentPosts: 1, timePosts: 1 });
  } finally {
    globalThis.fetch = previousFetch;
    clock.restore();
    if (previousConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previousConfig;
    if (previousWrite === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previousWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

const schemaDepth = (value: unknown, depth = 0): number => {
  if (Array.isArray(value))
    return Math.max(depth, ...value.map((item) => schemaDepth(item, depth)));
  if (typeof value !== "object" || value === null) return depth;
  return Math.max(depth, ...Object.values(value).map((item) => schemaDepth(item, depth + 1)));
};

test("advertised native operation schemas stay within OpenCode provider depth limits", async () => {
  const hooks = await plugin(context as never);
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    if (name === "workit_external_action") continue;
    const schema = tool.schema.toJSONSchema(tool.schema.object(definition.args), {
      target: "draft-2020-12",
    });
    expect(schemaDepth(schema), name).toBeLessThanOrEqual(10);
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties.schemaVersion, name).toBeDefined();
    expect(properties.action, name).toBeDefined();
  }
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

test("valid nested operation arguments reach the shared core outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-nested-"));
  const directRoot = mkdtempSync(join(tmpdir(), "workit-opencode-nested-direct-"));
  try {
    const request = taskStartRequest({
      intent: {
        objective: "nested objective",
        scope: { description: "source", paths: ["src"], exclusions: ["dist"] },
        authorityRefs: [{ kind: "external", url: "https://example.test/reference" }],
      },
    });
    const direct = new WorkitCore(new TaskStore(directRoot), {
      root: directRoot,
      caller: { host: "opencode", actor: "lead" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
    }).task(request);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "lead", directory: root } }) } },
    } as never);
    const raw = await hooks.tool?.workit_task.execute(request, {
      directory: root,
      sessionID: "lead",
    } as never);
    const native = JSON.parse(raw as string);
    expect(native.ok).toBe(direct.ok);
    expect(native.data).toMatchObject({ objective: "nested objective", status: "active" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(directRoot, { recursive: true, force: true });
  }
});

test("malformed nested operation arguments remain invalid_input", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-malformed-"));
  try {
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "lead", directory: root } }) } },
    } as never);
    const raw = await hooks.tool?.workit_task.execute(
      {
        ...taskStartRequest(),
        intent: {
          ...taskStartRequest().intent,
          scope: { ...taskStartRequest().intent.scope, paths: [42] },
        },
      },
      { directory: root, sessionID: "lead" } as never,
    );
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
