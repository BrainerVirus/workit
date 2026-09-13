import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

const requestServer = async (entry: string, args: string[] = []) => {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: ROOT,
    env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: ROOT },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let buffer = "";
  const pending = new Map<number, (value: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      output += line;
      try {
        const value = JSON.parse(line);
        const id = Number(value.id);
        pending.get(id)?.(value);
        pending.delete(id);
      } catch {
        // MCP may emit no non-JSON stdout; protocol failures reject below.
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  const call = (method: string, params: unknown, id: number) =>
    new Promise<any>((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => reject(new Error(`MCP request timed out: ${method}\n${output}`)), 5000);
    });
  const initialized = new Promise<any>((resolve) => pending.set(1, resolve));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
  );
  const initializedValue = await initialized;
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  const listed = await call("tools/list", {}, 2);
  child.stdin.end();
  return { initialized: initializedValue, listed, output };
};

test("run-server <workspace> from an unrelated cwd defaults omitted roots to the launcher workspace", async () => {
  const result = await requestServer("packages/workit-cursor/mcp/run-server.ts", [ROOT]);
  expect(result.initialized.result.serverInfo.name).toBe("workit");
  expect(result.listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ]);
});

test("WORKFLOW_WORKSPACE_ROOT env beats the process cwd for omitted tool roots", async () => {
  const result = await requestServer("packages/workit-cursor/mcp/run-server.ts");
  expect(result.initialized.result.serverInfo.name).toBe("workit");
  expect(result.output).not.toContain("[WORKSPACE_ROOT]");
});
