import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

type ServerProcess = {
  child: ChildProcess;
  request: (method: string, params: unknown) => Promise<any>;
};

function startServer(env: Record<string, string> = {}): ServerProcess {
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WORKFLOW_TOOLKIT_STATE: mkdtempSync(path.join(os.tmpdir(), "wf-err-state-")),
      ...env,
    },
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
  return { child, request };
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

test("a throwing MCP tool handler returns isError:true structured content", async () => {
  const blocked = path.join(
    mkdtempSync(path.join(os.tmpdir(), "wf-err-block-")),
    "token=sk-live-4",
  );
  writeFileSync(blocked, "blocks config dir creation");
  const server = startServer({ WORKFLOW_TOOLKIT_CONFIG: blocked });
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workflow_toolkit_init_apply",
      arguments: { action: "config", confirmed: false },
    });
    const result = (response as any).result;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error?: string; tool?: string };
    expect(parsed.error).toBeTruthy();
    expect(result.structuredContent?.error).toBeTruthy();
    // sanitized response: the canary must not reach the client
    expect(JSON.stringify(result)).not.toContain("sk-live-4");

    // host stays usable afterward
    const git = await server.request("tools/call", {
      name: "workflow_git_context",
      arguments: { workspace_root: process.cwd() },
    });
    expect((git as any).result.isError).not.toBe(true);
    expect((git as any).result.content?.[0]?.text).toBeDefined();
  } finally {
    server.child.kill();
  }
});

test("a domain error return is marked isError:true, not a successful-looking result", async () => {
  const server = startServer();
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workflow_changelog_apply",
      arguments: {},
    });
    const result = (response as any).result;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("entries required");

    // a healthy tool still succeeds
    const status = await server.request("tools/call", {
      name: "workflow_toolkit_init_status",
      arguments: {},
    });
    expect((status as any).result.isError).not.toBe(true);
  } finally {
    server.child.kill();
  }
});

test("a domain error string containing a secret is redacted before reaching the MCP client (D5)", async () => {
  const server = startServer();
  try {
    await initialize(server);
    // workflow_toolkit_init_apply echoes the invalid locale into the domain
    // error; hide a value-pattern secret inside it so redact() must strip it.
    const response = await server.request("tools/call", {
      name: "workflow_toolkit_init_apply",
      arguments: {
        action: "config",
        confirmed: false,
        locale: "es Authorization: canary-secret-99",
      },
    });
    const result = (response as any).result;
    expect(result.isError).toBe(true);
    const raw = JSON.stringify(result);
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("canary-secret-99");
  } finally {
    server.child.kill();
  }
});
