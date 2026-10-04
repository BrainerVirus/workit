import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { NativeReceiptStore, createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";

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
      JSON.stringify({ baseUrl: "https://youtrack.example.test", greetings: { morning: "hello" } }),
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
  receipts.recordRequest("call-near", "sess-near", "call-near");
  receipts.record(
    {
      sessionID: "sess-near",
      callID: "call-near",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Workit decision: design — Approve the plan shown above?",
            options: [
              { label: "approved", description: "Plan A" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
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
