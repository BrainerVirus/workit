import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, type OperationContext } from "../../packages/workit-core/src/core";
import extension from "../../packages/workit-pi/extensions/workit";
import { taskStartRequest } from "../workit-core/task-fixtures";

const makePi = () => {
  const tools: any[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    tools,
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

const startedTask = (root: string) => {
  const store = new TaskStore(root);
  const operationContext: OperationContext = {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const result = new WorkitCore(store, operationContext).task(taskStartRequest());
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

test("clean Pi package declares stock discovery and exactly eight core tools", async () => {
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../packages/workit-pi/package.json"), "utf8"),
  );
  expect(manifest.pi).toEqual({ extensions: ["./dist/workit.js"], skills: ["./skills"] });
  const pi = makePi();
  await extension(pi as any);
  expect(pi.tools.map((tool) => tool.name)).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ]);
  expect(pi.tools.every((tool) => tool.parameters.type === "object")).toBe(true);
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

test("stock Pi activates the extracted package without a companion extension", async () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const packageRoot = path.join(repoRoot, "packages/workit-pi");
  const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-pack-"));
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
  const piBin = path.join(
    repoRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  const child = spawn(
    process.execPath,
    [
      piBin,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-context-files",
      "--no-extensions",
      "--extension",
      path.join(extracted, "package/dist/workit.js"),
      "--skill",
      path.join(extracted, "package/skills"),
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
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
      const timer = setTimeout(() => reject(new Error(`Pi activation timeout: ${stderr}`)), 10000);
      const poll = () => {
        if (responses.has("get_commands")) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(poll, 10);
      };
      poll();
    });
    const commands = responses.get("get_commands").data.commands as Array<{ name: string }>;
    expect(
      commands
        .filter((command) => command.name.startsWith("skill:workit-"))
        .map((command) => command.name)
        .sort(),
    ).toEqual([
      "skill:workit-behavioral-tdd",
      "skill:workit-challenge",
      "skill:workit-debug",
      "skill:workit-handoff",
      "skill:workit-implement",
      "skill:workit-plan",
      "skill:workit-review",
    ]);
    expect(stderr).toBe("");
  } finally {
    child.kill();
    rmSync(stage, { recursive: true, force: true });
  }
});
