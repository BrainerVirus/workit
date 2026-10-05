import { expect, test } from "bun:test";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "@/packages/workit-mcp/src/index";
import { cursorCapabilities, cursorContextProvider } from "@/packages/workit-cursor/mcp/run-server";

test("Cursor uses the shared MCP transport with truthful native capabilities", async () => {
  expect(cursorCapabilities().some((item) => item.name === "interactive_decision")).toBe(false);
  expect(cursorCapabilities().find((item) => item.name === "arbitrary_shell_write")).toMatchObject({
    assurance: "unavailable",
  });

  const server = createMcpServer("cursor", cursorContextProvider());
  const client = new Client({ name: "task12-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "workit_task",
      "workit_policy",
      "workit_state",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Cursor MCP refuses authority without a native caller identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-mcp-"));
  const provider = cursorContextProvider(root);
  expect((await provider.current()).caller.actor).toBe("");
  const server = createMcpServer("cursor", provider);
  const client = new Client({ name: "task12-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const authority = await client.callTool({
      name: "workit_task",
      arguments: taskStartRequest(),
    });
    expect(authority.structuredContent).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { capability: "native_caller_identity" },
    });
    const readOnly = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    expect(readOnly.structuredContent).not.toMatchObject({ code: "capability_unavailable" });
  } finally {
    await client.close();
    await server.close();
  }
});

test("Cursor adapter has no legacy token or embedded schema surface", async () => {
  const source = await Bun.file("packages/workit-cursor/mcp/run-server.ts").text();
  expect(source).not.toMatch(
    /modelcontextprotocol\/sdk|from ["']zod["']|delegation_token|mintDelegateToken/,
  );
});
