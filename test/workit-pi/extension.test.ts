import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, type OperationContext } from "../../packages/workit-core/src/core";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import extension from "../../packages/workit-pi/extensions/workit";
import { piCapabilities } from "../../packages/workit-pi/src/context";
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

const nodeExecutable = "node";

const assertCurrentNode = () => {
  const result = spawnSync(nodeExecutable, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(result.stdout.trim()).toBe(`v${SUPPORT_MATRIX.node.current}`);
};

test("clean Pi package declares stock discovery and exactly eight core tools", async () => {
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../packages/workit-pi/package.json"), "utf8"),
  );
  expect(manifest.pi).toEqual({ extensions: ["./dist/workit.js"], skills: ["./skills"] });
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@brainervirus/workit-core");
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.85.1");
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
  expect(
    piCapabilities({ hasUI: false }).find((entry) => entry.name === "interactive_decision")
      ?.assurance,
  ).toBe("unavailable");
  expect(
    piCapabilities({ hasUI: true }).find((entry) => entry.name === "interactive_decision")
      ?.assurance,
  ).toBe("enforced");
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
    ).toHaveLength(7);
    expect(stderr).toBe("");
  } finally {
    child.kill();
    rmSync(stage, { recursive: true, force: true });
  }
});
