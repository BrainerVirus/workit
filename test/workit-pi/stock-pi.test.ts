import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const node = "node";

test("stock Node runtime is the supported current line for Pi workers", () => {
  const result = spawnSync(node, ["--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("v" + SUPPORT_MATRIX.node.current);
});

test(
  "stock Pi discovers the packed Workit extension and skills without explicit resource flags",
  async () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-stock-"));
    const project = path.join(stage, "project");
    const agentDir = path.join(stage, "agent");
    mkdirSync(project);
    mkdirSync(agentDir);
    const piBin = path.join(
      repoRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    // Hermetic HOME: stock Pi auto-discovers user-level agent skills
    // (~/.agents/skills) — see extension.test.ts discovery test.
    const home = path.join(stage, "home");
    mkdirSync(home);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: home };
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--workspace",
        path.join(repoRoot, "packages/workit-pi"),
        "--pack-destination",
        stage,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0].filename;
    const extracted = path.join(stage, "extract");
    mkdirSync(extracted);
    const unpacked = spawnSync("tar", ["-xzf", path.join(stage, filename), "-C", extracted], {
      encoding: "utf8",
    });
    if (unpacked.status !== 0) throw new Error(unpacked.stderr || unpacked.stdout);
    const installed = spawnSync(
      node,
      [piBin, "install", path.join(extracted, "package"), "-l", "--approve"],
      { cwd: project, env, encoding: "utf8" },
    );
    if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout);
    const child = spawn(
      node,
      [piBin, "--mode", "rpc", "--no-session", "--approve", "--offline", "--no-context-files"],
      { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "";
    let stderr = "";
    const messages: Array<Record<string, unknown>> = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      child.stdin.write('{"id":"commands","type":"get_commands"}\n');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Pi discovery timeout: ${stderr}`)), 10000);
        const poll = () => {
          if (
            messages.some(
              (message) => message.type === "response" && message.command === "get_commands",
            )
          ) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(poll, 10);
        };
        poll();
      });
      const response = messages.find(
        (message) => message.type === "response" && message.command === "get_commands",
      ) as { data: { commands: Array<{ name: string; source: string }> } };
      const commands = response.data.commands;
      expect(commands.filter((command) => command.name.startsWith("skill:workit-"))).toHaveLength(
        14,
      );
      expect(commands.map((command) => command.name)).toEqual(
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
      expect(
        commands.some(
          (command) => command.name === "workit-worker" && command.source === "extension",
        ),
      ).toBe(true);
      expect(readFileSync(path.join(project, ".pi/settings.json"), "utf8")).toContain(
        "extract/package",
      );
      child.stdin.write(
        JSON.stringify({
          id: "reconcile",
          type: "prompt",
          message: '/workit-worker {"action":"reconcile","taskId":"missing","workerId":"missing"}',
        }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(stderr).toBe("");
    } finally {
      child.kill();
      rmSync(stage, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test(
  "packed stock Pi supervises an assigned reviewer through an offline provider",
  async () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-supervisor-smoke-"));
    const project = path.join(stage, "project");
    const agentDir = path.join(stage, "agent");
    mkdirSync(project);
    mkdirSync(agentDir);
    const piBin = path.join(
      repoRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--workspace",
        path.join(repoRoot, "packages/workit-pi"),
        "--pack-destination",
        stage,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0].filename;
    const extracted = path.join(stage, "extract");
    mkdirSync(extracted);
    const unpacked = spawnSync("tar", ["-xzf", path.join(stage, filename), "-C", extracted], {
      encoding: "utf8",
    });
    if (unpacked.status !== 0) throw new Error(unpacked.stderr || unpacked.stdout);

    const fakeProvider = path.join(stage, "offline-provider.mjs");
    const piAi = path.join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
    writeFileSync(
      fakeProvider,
      `import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(piAi)};
let turns = 0;
export default (pi) => pi.registerProvider("workit-test", {
  api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
  models: [{ id: "fake", name: "Workit offline fake", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 128 }],
  streamSimple(model, _context, _options) {
    const stream = createAssistantMessageEventStream();
    const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
    setTimeout(() => {
      if (turns++ > 0) {
        output.content.push({ type: "text", text: "review complete" }); output.stopReason = "stop";
        stream.push({ type: "start", partial: output }); stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "review complete", partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: "review complete", partial: output });
        stream.push({ type: "done", reason: "stop", message: output }); stream.end(); return;
      }
      const call = { type: "toolCall", id: "offline-report", name: "workit_worker", arguments: {} };
      const task = JSON.parse(readFileSync(process.cwd() + "/.workit/tasks/" + process.env.WORKIT_PI_TASK_ID + ".json", "utf8"));
      const workspace = JSON.parse(readFileSync(process.cwd() + "/.workit/workspace.json", "utf8"));
      call.arguments = { schemaVersion: 1, action: "report", taskId: process.env.WORKIT_PI_TASK_ID, workerId: process.env.WORKIT_PI_WORKER_ID,
        expectedRevision: task.revision, expectedWorkspaceRevision: workspace.revision,
        report: { outcome: "completed", summary: "offline reviewer", evidenceIds: [], findingIds: [] } };
      output.content.push(call); output.stopReason = "toolUse";
      stream.push({ type: "start", partial: output }); stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
      stream.push({ type: "done", reason: "toolUse", message: output }); stream.end();
    }, 300);
    return stream;
  }
});
`,
    );

    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    };
    const installed = spawnSync(
      node,
      [piBin, "install", path.join(extracted, "package"), "-l", "--approve"],
      { cwd: project, env, encoding: "utf8" },
    );
    if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout);
    const settingsPath = path.join(project, ".pi/settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    settings.extensions = [fakeProvider];
    settings.defaultProvider = "workit-test";
    settings.defaultModel = "fake";
    writeFileSync(settingsPath, JSON.stringify(settings));

    const store = new TaskStore(project);
    const context: OperationContext = {
      root: project,
      caller: { host: "pi", actor: "smoke-parent" },
      callerAttested: true,
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    };
    const core = new WorkitCore(store, context);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("smoke task state missing");
    const assigned = core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
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
    if (!assigned.ok) throw new Error(assigned.error);
    const assignedTask = store.readTask(taskId);
    const assignedWorkspace = store.readWorkspace();
    if (!assignedTask.ok || !assignedWorkspace.ok || !assignedWorkspace.data)
      throw new Error("smoke assignment state missing");
    const workerId = assigned.data.id;
    const smokeEnv = {
      ...env,
      WORKIT_PI_TEST_TASK_REVISION: assignedTask.data.revision,
      WORKIT_PI_TEST_WORKSPACE_REVISION: assignedWorkspace.data.revision,
    };
    const child = spawn(
      node,
      [piBin, "--mode", "rpc", "--no-session", "--approve", "--offline", "--no-context-files"],
      { cwd: project, env: smokeEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    const waitFor = async (predicate: () => boolean, timeout = 15000) => {
      const until = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > until)
          throw new Error(
            `smoke timeout: ${stderr} state=${JSON.stringify(store.readTask(taskId))} rpc=${buffer}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      send({
        id: "launch",
        type: "prompt",
        message: `/workit-worker ${JSON.stringify({ action: "launch", taskId, workerId, prompt: "offline reviewer" })}`,
      });
      await waitFor(() => {
        const current = store.readTask(taskId);
        return (
          current.ok &&
          current.data.workers.find((entry) => entry.id === workerId)?.data.session !== null
        );
      });
      await waitFor(() => {
        const current = store.readTask(taskId);
        return (
          current.ok &&
          current.data.workers.find((entry) => entry.id === workerId)?.data.report?.summary ===
            "offline reviewer"
        );
      });
      const reported = store.readTask(taskId);
      expect(
        reported.ok && reported.data.workers.find((entry) => entry.id === workerId)?.data.state,
      ).toBe("running");
      send({
        id: "cancel",
        type: "prompt",
        message: `/workit-worker ${JSON.stringify({ action: "cancel", taskId, workerId })}`,
      });
      await waitFor(() => {
        const current = store.readTask(taskId);
        return (
          current.ok &&
          current.data.workers.find((entry) => entry.id === workerId)?.data.state === "stopped"
        );
      });
      expect(stderr).toBe("");
    } finally {
      child.kill();
      rmSync(stage, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);
