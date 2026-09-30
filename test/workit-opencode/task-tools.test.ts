import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { server as plugin } from "@/packages/workit-opencode/src/index";
import {
  NativeReceiptStore,
  createWorkitTools,
  observeQuestionEvent,
} from "@/packages/workit-opencode/src/tools/workit";
import { tool } from "@opencode-ai/plugin";

const context = { directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") };
const workitQuestion = (question: string, approvedContent: string) => ({
  header: "Workit decision: design",
  question,
  options: [
    { label: "approved", description: approvedContent },
    { label: "rejected", description: "Reject this decision" },
  ],
});
const schemaDepth = (value: unknown, depth = 0): number => {
  if (Array.isArray(value))
    return Math.max(depth, ...value.map((item) => schemaDepth(item, depth)));
  if (typeof value !== "object" || value === null) return depth;
  return Math.max(depth, ...Object.values(value).map((item) => schemaDepth(item, depth + 1)));
};

const decisionFixture = (actor: string) => {
  const root = mkdtempSync(join(tmpdir(), `workit-opencode-decision-${actor}-`));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("decision fixture failed");
  const writer = core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workerId: null,
  });
  if (!writer.ok) throw new Error(writer.error);
  const currentTask = store.readTask(task.data.id);
  const currentWorkspace = store.readWorkspace();
  if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("writer refresh failed");
  const receipts = new NativeReceiptStore();
  const tools = createWorkitTools({
    receipts,
    client: { session: { get: async () => ({ data: { id: actor, directory: root } }) } },
  }) as any;
  return {
    root,
    actor,
    task: currentTask.data,
    workspace: currentWorkspace.data,
    receipts,
    tools,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("out-of-band question replies mint consumable decision receipts", () => {
  const receipts = new NativeReceiptStore();
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-1",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
      tool: { messageID: "m", callID: "call-1" },
    },
  });
  expect(receipts.recordReply("req-1", "lead", [["approved"]])).toBe(true);
  const consumed = receipts.consume("lead", "decision", {
    question: "Ship it?",
    selectedLabel: "approved",
    selectedDescription: "ship-it-content",
  });
  expect(consumed.ok).toBe(true);
});

test("question event receipts reject mismatched or missing questions", () => {
  const receipts = new NativeReceiptStore();
  // Reply with no asked question mints nothing.
  expect(receipts.recordReply("req-missing", "lead", [["approved"]])).toBe(false);
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-2",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
    },
  });
  // Wrong session, multiple answers, and unknown labels all fail closed.
  expect(receipts.recordReply("req-2", "other", [["approved"]])).toBe(false);
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-3",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
    },
  });
  expect(receipts.recordReply("req-3", "lead", [["approved"], ["rejected"]])).toBe(false);
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-4",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
    },
  });
  expect(receipts.recordReply("req-4", "lead", [["maybe"]])).toBe(false);
  // Non-Workit questions never mint.
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-5",
      sessionID: "lead",
      questions: [
        { header: "Other", question: "Huh?", options: [{ label: "a", description: "b" }] },
      ],
    },
  });
  expect(receipts.recordReply("req-5", "lead", [["a"]])).toBe(false);
  // Rejected questions leave nothing to consume.
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-6",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
    },
  });
  observeQuestionEvent(receipts, { type: "question.rejected", properties: { requestID: "req-6" } });
  expect(receipts.recordReply("req-6", "lead", [["approved"]])).toBe(false);
  expect(receipts.consume("lead", "decision").ok).toBe(false);
});

test("receipt failures name the receipt-shaped question contract", () => {
  const receipts = new NativeReceiptStore();
  const missing = receipts.consume("lead", "decision");
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("expected failure");
  expect(missing.error).toContain("Workit decision: <purpose>");
  expect(missing.error).toContain("approved/rejected");
  observeQuestionEvent(receipts, {
    type: "question.asked",
    properties: {
      id: "req-shape",
      sessionID: "lead",
      questions: [workitQuestion("Ship it?", "ship-it-content")],
    },
  });
  expect(receipts.recordReply("req-shape", "lead", [["approved"]])).toBe(true);
  const mismatched = receipts.consume("lead", "decision", { question: "Something else?" });
  expect(mismatched.ok).toBe(false);
  if (mismatched.ok) throw new Error("expected failure");
  expect(mismatched.error).toContain("Workit decision: <purpose>");
  expect(mismatched.error).toContain("approved/rejected");
});

test("plugin question events never break event delivery", async () => {
  const hooks = await plugin(context as never);
  await hooks.event?.({ event: { type: "question.replied", properties: {} } } as never);
  await hooks.event?.({
    event: { type: "question.asked", properties: { id: 42, sessionID: "lead" } },
  } as never);
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
    const result = await (tools as any).workit_context.execute(
      { kind: "git" },
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
    const result = await tools.workit_context.execute(
      { kind: "release", range: "HEAD~1...HEAD" },
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
    const result = await tools.workit_context.execute(
      { kind: "changelog", range: `--output=${injected}` },
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
    const result = await tools.workit_context.execute(
      { kind: "git" },
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

test("context rejects mutation-shaped arguments without Git or Workit effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-context-mutation-"));
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
    const tools = createWorkitTools() as any;
    const result = await tools.workit_context.execute(
      { kind: "git", operation: "git.commit", payload: { message: "must-not-run" } },
      { directory: root, sessionID: "context-mutation" },
    );
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    ).toBe(before);
    expect(existsSync(join(root, ".workit"))).toBe(false);
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
    const result = await tools.workit_context.execute(
      { kind: "youtrack", mode: "meetings" },
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
      const result = await tools.workit_context.execute(
        { kind: "youtrack", specPath },
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

test("advertised native operation schemas stay within OpenCode provider depth limits", async () => {
  const hooks = await plugin(context as never);
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    if (name === "workit_context") continue;
    const schema = tool.schema.toJSONSchema(tool.schema.object(definition.args), {
      target: "draft-2020-12",
    });
    expect(schemaDepth(schema), name).toBeLessThanOrEqual(10);
    // Host-owned init tool: same depth budget, different envelope from the
    // eight schemaVersion/action operation families.
    if (name === "workit_init_apply") continue;
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
  ).toBe(false);
});

test("consumed native call IDs stay deduplicated for the receipt store lifetime", () => {
  const receipts = new NativeReceiptStore();
  const input = {
    sessionID: "long-lived-session",
    args: {
      questions: [
        {
          header: "Workit decision: action",
          question: "Workit decision: action — commit?",
          options: [
            { label: "approved", description: "Commit the change." },
            { label: "rejected", description: "Reject this decision" },
          ],
        },
      ],
    },
  };
  for (let index = 0; index < 1025; index += 1) {
    const callID = `native-call-${index}`;
    receipts.record({ ...input, callID }, { metadata: { answers: [["approved"]] } });
    if (!receipts.consume(input.sessionID, "decision", { callID }).ok)
      throw new Error(`receipt ${callID} did not consume`);
  }
  receipts.record({ ...input, callID: "native-call-0" }, { metadata: { answers: [["approved"]] } });
  expect(receipts.consume(input.sessionID, "decision", { callID: "native-call-0" }).ok).toBe(false);
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

test("OpenCode refuses oversized decision questions before displaying them", async () => {
  const hooks = (await plugin(context as never)) as any;
  const question = {
    header: "Workit decision: design",
    question: "x".repeat(400),
    options: [
      { label: "approved", description: "short" },
      { label: "rejected", description: "Reject this decision" },
    ],
  };
  expect(() =>
    hooks["tool.execute.before"](
      { tool: "question", sessionID: "decision-session", callID: "decision-call" },
      { args: { questions: [question] } },
    ),
  ).toThrow(/present the item/);
});

test("oversized decision bindings fail closed at record time", async () => {
  const fixture = decisionFixture("oversize");
  try {
    const long = `Approve ${"x".repeat(400)}`;
    fixture.receipts.record(
      {
        sessionID: fixture.actor,
        callID: "oversize-question",
        args: {
          questions: [
            {
              header: "Workit decision: design",
              question: long,
              options: [
                { label: "approved", description: long },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
    const result = await fixture.tools.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: fixture.task.id,
        expectedRevision: fixture.task.revision,
        purpose: "design",
        binding: {
          taskId: fixture.task.id,
          workspaceId: fixture.workspace.id,
          scope: fixture.task.intent.data.scope,
          presented: long,
          approvedContent: long,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: fixture.root, sessionID: fixture.actor },
    );
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  } finally {
    fixture.cleanup();
  }
});

test("receipt near misses identify the mismatched binding", () => {
  const receipts = new NativeReceiptStore();
  receipts.recordRequest("req-near", "sess-near", "call-near", [
    {
      header: "Workit decision: design",
      question: "Workit decision: design — Approve the plan shown above?",
      options: [
        { label: "approved", description: "Plan A" },
        { label: "rejected", description: "Reject this decision" },
      ],
    },
  ]);
  expect(receipts.recordReply("req-near", "sess-near", [["approved"]])).toBe(true);
  const consumed = receipts.consume("sess-near", "decision", {
    selectedLabel: "approved",
    decisionPurpose: "design",
    selectedDescription: "Plan B",
  });
  expect(consumed.ok).toBe(false);
  if (!consumed.ok) expect(consumed.error).toContain("description");
});

test("stated design choices need no receipt and never authorize an action", async () => {
  const fixture = decisionFixture("stated-choice");
  try {
    const record = (purpose: "design" | "action", callRef: string) =>
      fixture.tools.workit_decision.execute(
        {
          schemaVersion: 1,
          action: "record",
          taskId: fixture.task.id,
          expectedRevision: fixture.task.revision,
          purpose,
          binding: {
            taskId: fixture.task.id,
            workspaceId: fixture.workspace.id,
            scope: fixture.task.intent.data.scope,
            presented: "Take the second approach?",
            approvedContent: "Take the second approach.",
            contentRefs: [],
            statedChoice: { ref: callRef, text: "take the second one" },
          },
          response: "stated",
          requirementIds: [],
        },
        { directory: fixture.root, sessionID: fixture.actor },
      );
    const stated = await record("design", "design-choice");
    expect(JSON.parse(typeof stated === "string" ? stated : stated.output)).toMatchObject({
      ok: true,
    });
    const action = await record("action", "action-choice");
    expect(JSON.parse(typeof action === "string" ? action : action.output).ok).toBe(false);
  } finally {
    fixture.cleanup();
  }
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
