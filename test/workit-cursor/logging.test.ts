import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const tempDirs: string[] = [];
const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ServerProcess = {
  child: ChildProcess;
  request: (method: string, params: unknown) => Promise<any>;
  stderr: string[];
};

function startServer(env: Record<string, string> = {}): ServerProcess {
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WORKFLOW_TOOLKIT_STATE: scratchDir("wf-mcp-state-"),
      ...env,
    },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) stderr.push(line.trim());
  });
  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const nextId = { id: 0 };
  const request = (method: string, params: unknown) => {
    const id = ++nextId.id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
  };
  return { child, request, stderr };
}

async function initialize(server: ServerProcess) {
  await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  server.child.stdin!.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
}

const stderrEvents = (server: ServerProcess): any[] =>
  server.stderr.map((line) => JSON.parse(line));

test("MCP startup events land on stderr only; stdout stays protocol-only", async () => {
  const server = startServer();
  try {
    await initialize(server);
    await server.request("tools/list", {});

    const events = stderrEvents(server);
    const names = events.map((e) => e.message);
    expect(names).toContain("initialization");
    expect(names).toContain("mcp_connection");
    const init = events.find((e) => e.message === "initialization")!;
    expect(init.context.host).toBe("cursor-mcp");
    const connected = events.find((e) => e.message === "mcp_connection")!;
    expect(connected.level).toBe("info");

    // every stderr line is bounded JSON with no home prefix
    for (const event of events) {
      expect(event.time).toBeTruthy();
      expect(typeof event.message).toBe("string");
      expect(event.context).toBeTruthy();
    }
  } finally {
    server.child.kill();
  }
});

test("MCP tool failure emits a sanitized stderr event; no stdout contamination", async () => {
  const blocked = path.join(scratchDir("wf-mcp-token=sk-live-2-"), "config");
  writeFileSync(blocked, "an existing file blocks config dir creation");
  const server = startServer({ WORKFLOW_TOOLKIT_CONFIG: blocked });
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workflow_toolkit_init_apply",
      arguments: { action: "config", confirmed: false },
    });
    expect((response as any).result.isError).toBe(true);

    const events = stderrEvents(server);
    const failed = events.find((e) => e.message === "tools_failed");
    expect(failed).toBeDefined();
    expect(failed!.context.tool).toBe("workflow_toolkit_init_apply");
    const rawStderr = server.stderr.join("\n");
    expect(rawStderr).not.toContain("sk-live-2");
    expect(rawStderr.toLowerCase()).toContain("[redacted]");

    // stdout carried exactly the JSON-RPC response; every line is a protocol frame
    const stdoutLines = await collectStdoutLines(server);
    for (const line of stdoutLines) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      expect(frame.jsonrpc).toBe("2.0");
    }
  } finally {
    server.child.kill();
  }
});

function collectStdoutLines(server: ServerProcess): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    server.child.stdout!.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) lines.push(line.trim());
    };
    server.child.stdout!.on("data", onData);
    setTimeout(() => {
      server.child.stdout!.off("data", onData);
      resolve(lines);
    }, 300);
  });
}

test("session-start hook reports a contract failure on stderr; stdout stays `{}`", async () => {
  const root = scratchDir("wf-hook-token=sk-live-3-");
  mkdirSync(path.join(root, "templates", "superpowers-doc-contract.md"), { recursive: true });

  const child = spawn("bun", ["packages/workit-cursor/hooks/session-start.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      WORKFLOW_TOOLKIT_STATE: scratchDir("wf-hook-state-"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exit = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  expect(exit).toBe(0);
  expect(stdout).toBe("{}\n");
  const lines = stderr.split("\n").filter((l) => l.trim());
  const events = lines.map((line) => JSON.parse(line) as any);
  const names = events.map((e) => e.message);
  expect(names).toContain("initialization");
  expect(names).toContain("hooks");
  const hookEvent = events.find((e) => e.message === "hooks")!;
  expect(hookEvent.context!.boundary).toBe("session-start");
  expect(stderr).not.toContain("sk-live-3");
  expect(stderr.toLowerCase()).toContain("[redacted]");
});
