import { expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OPERATION_FAMILIES } from "../../packages/workit-core/src/core";
import { createMcpServer } from "../../packages/workit-mcp/src/index";
import {
  cursorCapabilities,
  cursorContextProvider,
} from "../../packages/workit-cursor/mcp/run-server";

test("Cursor uses the shared MCP transport with truthful native capabilities", async () => {
  expect(cursorCapabilities().find((item) => item.name === "interactive_decision")).toMatchObject({
    assurance: "agent_guided",
  });
  expect(cursorCapabilities().find((item) => item.name === "arbitrary_shell_write")).toMatchObject({
    assurance: "unavailable",
  });

  const server = createMcpServer("cursor", cursorContextProvider());
  const client = new Client({ name: "task12-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      OPERATION_FAMILIES.map((family) => `workit_${family}`),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("Cursor adapter has no legacy token or embedded schema surface", async () => {
  const source = await Bun.file("packages/workit-cursor/mcp/server.ts").text();
  expect(source).not.toMatch(
    /modelcontextprotocol\/sdk|from ["']zod["']|delegation_token|mintDelegateToken/,
  );
});
