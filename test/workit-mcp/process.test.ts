import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-process-"));
const entry = path.join(tempRoot, "server.js");

beforeAll(() => {
  const result = spawnSync(
    "bun",
    [
      "build",
      path.join(REPO_ROOT, "packages/workit-mcp/src/index.ts"),
      "--outfile",
      entry,
      "--target",
      "node",
      "--format",
      "esm",
      "--banner",
      "#!/usr/bin/env node",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const start = () => {
  const child = spawn(process.execPath, [entry, "--host", "cursor"], {
    cwd: REPO_ROOT,
    env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: tempRoot, WORKFLOW_SESSION_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const pending = new Map<number, (message: any) => void>();
  child.stdout.on("data", () => {
    let lineEnd: number;
    while ((lineEnd = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, lineEnd).trim();
      stdout = stdout.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    return new Promise<any>((resolve, reject) => {
      pending.set(requestId, resolve);
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr}`));
      }, 15000);
      const original = pending.get(requestId)!;
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        original(message);
      });
    });
  };
  return { child, request, getStderr: () => stderr };
};

test("Node executable completes MCP initialize and tools/list with protocol-only stdout", async () => {
  const { child, request } = start();
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "process-test", version: "1.0.0" },
    });
    expect(initialized.result.serverInfo.name).toBe("workit");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "workit_task",
      "workit_policy",
      "workit_evidence",
      "workit_finding",
      "workit_decision",
      "workit_worker",
      "workit_writer",
      "workit_state",
    ]);
    const called = await request("tools/call", {
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    expect(called.result.isError).not.toBe(true);
    expect(called.result.structuredContent).toMatchObject({ ok: true, schemaVersion: 1 });
    const authority = await request("tools/call", {
      name: "workit_writer",
      arguments: {
        schemaVersion: 1,
        action: "acquire",
        taskId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: "00000000-0000-4000-8000-000000000001",
        expectedWorkspaceRevision: "00000000-0000-4000-8000-000000000001",
        workerId: null,
      },
    });
    expect(authority.result.structuredContent).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { capability: "native_caller_identity" },
    });
  } finally {
    child.kill();
  }
});

test("Node executable requires a supported host before writing protocol frames", async () => {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolve) =>
    child.once("close", (code) => resolve(code ?? 1)),
  );
  expect(exitCode).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/host/i);
});
