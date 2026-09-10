import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  OPERATION_FAMILIES,
  OPERATION_SCHEMA_MAX_DEPTH,
  boundedOperationJsonSchema,
  type OperationContext,
} from "../../packages/workit-core/src/core";
import type { Host } from "../../packages/workit-core/src/core/task-contract";
import {
  createMcpServer,
  McpCapabilityUnavailableError,
  sanitizeTransportText,
  type NativeContextProvider,
} from "../../packages/workit-mcp/src/index";
import { operationCorpus, taskStartRequest } from "../workit-core/task-fixtures";

const id = "00000000-0000-4000-8000-000000000001";
const root = process.cwd();

const context = (host: Host, workspaceRoot = root): OperationContext => ({
  root: workspaceRoot,
  caller: { host, actor: "mcp-test" },
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const connect = async (
  host: "cursor" | "codex_cli" | "codex_desktop",
  provider: NativeContextProvider,
) => {
  const server = createMcpServer(host, provider);
  const client = new Client({ name: "workit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
};

test("MCP exposes exactly the eight family tools with core-derived 2020-12 schemas", async () => {
  const { client, server } = await connect("cursor", { current: async () => context("cursor") });
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      OPERATION_FAMILIES.map((family) => `workit_${family}`),
    );
    for (const family of OPERATION_FAMILIES) {
      const tool = listed.tools.find((candidate) => candidate.name === `workit_${family}`)!;
      expect(tool.inputSchema).toMatchObject(boundedOperationJsonSchema(family));
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(jsonDepth(tool.inputSchema), `workit_${family}`).toBeLessThanOrEqual(
        OPERATION_SCHEMA_MAX_DEPTH,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

const jsonDepth = (node: unknown, current = 0): number => {
  if (Array.isArray(node))
    return node.reduce((max, item) => Math.max(max, jsonDepth(item, current)), current);
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (!keys.length) return current;
    return keys.reduce(
      (max, key) => Math.max(max, jsonDepth((node as Record<string, unknown>)[key], current + 1)),
      current,
    );
  }
  return current;
};

test("MCP exposes a read-only context resource without adding a ninth tool", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-context-"));
  spawnSync("git", ["init", "-q"], { cwd: workspaceRoot });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspaceRoot });
  spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: workspaceRoot });
  writeFileSync(path.join(workspaceRoot, "fixture.txt"), "fixture\n");
  spawnSync("git", ["add", "fixture.txt"], { cwd: workspaceRoot });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: workspaceRoot });
  const { client, server } = await connect("cursor", {
    current: async () => context("cursor", workspaceRoot),
  });
  try {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(8);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("workit://context/git");
    const read = await client.readResource({ uri: "workit://context/git" });
    expect(read.contents[0]).toMatchObject({ mimeType: "application/json" });
    expect(String((read.contents[0] as { text?: string }).text)).toContain('"kind":"git"');
    expect(String((read.contents[0] as { text?: string }).text)).toContain(workspaceRoot);
  } finally {
    await client.close();
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP resource failures use a sanitized structured envelope", async () => {
  const { client, server } = await connect("cursor", {
    current: async () => {
      throw new Error("Bearer super-secret /home/private/workspace-secret/context.ts:1:2");
    },
  });
  try {
    const read = await client.readResource({ uri: "workit://context/git" });
    const text = String((read.contents[0] as { text?: string }).text);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      schemaVersion: 1,
      code: "storage_error",
      error: "MCP operation failed",
      details: {},
    });
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("/home/private");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP resource capability failures use an allowlisted capability name", async () => {
  const { client, server } = await connect("cursor", {
    current: async () => {
      throw new McpCapabilityUnavailableError("Bearer TOPSECRET /tmp/secret");
    },
  });
  try {
    const read = await client.readResource({ uri: "workit://context/git" });
    const value = JSON.parse(String((read.contents[0] as { text?: string }).text));
    expect(value).toEqual({
      ok: false,
      schemaVersion: 1,
      code: "capability_unavailable",
      error: "context unavailable",
      details: { capability: "context" },
    });
    expect(JSON.stringify(value)).not.toContain("TOPSECRET");
    expect(JSON.stringify(value)).not.toContain("/tmp/secret");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP context resources advertise and validate their query selectors", async () => {
  const { client, server } = await connect("cursor", { current: async () => context("cursor") });
  try {
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates[0]?.uriTemplate).toBe(
      "workit://context/{kind}{?range,issueId}",
    );
    const read = await client.readResource({ uri: "workit://context/git?unsupported=value" });
    expect(JSON.parse(String((read.contents[0] as { text?: string }).text))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP rejects caller-supplied provenance and workspace roots through strict schemas", async () => {
  const { client, server } = await connect("cursor", { current: async () => context("cursor") });
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: {
        ...taskStartRequest(),
        provenance: { host: "codex_cli", session: { handle: "forged" } },
        workspace_root: "/tmp/forged-root",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP maps exact core results and marks domain failures as errors", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-server-"));
  const { client, server } = await connect("cursor", {
    current: async () => context("cursor", workspaceRoot),
  });
  try {
    const start = await client.callTool({
      name: "workit_task",
      arguments: taskStartRequest(),
    });
    expect(start.isError).not.toBe(true);
    expect(start.structuredContent).toMatchObject({ ok: true, schemaVersion: 1 });

    const missing = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "inspect", taskId: id, view: "summary" },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ ok: false, code: "not_found" });

    const unknown = await client.callTool({ name: "workit_nope", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    await client.close();
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP redacts secrets and the trusted workspace root only in failure envelopes", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-failure-"));
  const workspaceRoot = path.join(tempRoot, "workspace-secret-SUPERSECRET");
  writeFileSync(workspaceRoot, "not a directory");
  const { client, server } = await connect("cursor", {
    current: async () => context("cursor", workspaceRoot),
  });
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "inspect", taskId: id, view: "summary" },
    });
    const text = JSON.stringify(result.structuredContent);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "recovery_required" });
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain(workspaceRoot);
    expect(text).toContain("[WORKSPACE_ROOT]");
  } finally {
    await client.close();
    await server.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startup transport diagnostics use bounded secret and workspace-root sanitization", () => {
  const workspaceRoot = "/tmp/workit-startup-secret-root";
  const message = sanitizeTransportText(
    new Error(`Bearer super-secret ${workspaceRoot}/server.ts:1:2`),
    workspaceRoot,
  );
  expect(message).not.toContain("super-secret");
  expect(message).not.toContain(workspaceRoot);
  expect(message).toContain("[WORKSPACE_ROOT]");
  expect(message.length).toBeLessThanOrEqual(500);
});

test("MCP resolves the trusted provider root and leaves read-only task listing bytes unchanged", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-readonly-"));
  const beforeBytes = readdirSync(workspaceRoot);
  const current = async () => context("cursor", workspaceRoot);
  const { client, server } = await connect("cursor", { current });
  try {
    const before = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    const after = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    expect(before.structuredContent).toEqual(after.structuredContent);
    expect(readdirSync(workspaceRoot)).toEqual(beforeBytes);
  } finally {
    await client.close();
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP publishes every core action in every family without a second action table", async () => {
  const families = new Map<string, Set<string>>();
  for (const fixture of operationCorpus()) {
    const actions = families.get(fixture.family) ?? new Set<string>();
    actions.add(String((fixture.input as { action: string }).action));
    families.set(fixture.family, actions);
  }
  const { client, server } = await connect("cursor", { current: async () => context("cursor") });
  try {
    const listed = await client.listTools();
    for (const family of OPERATION_FAMILIES) {
      const schema = listed.tools.find((tool) => tool.name === `workit_${family}`)!.inputSchema as {
        oneOf?: Array<{ properties?: { action?: { const?: string } } }>;
      };
      const actions = new Set(
        (schema.oneOf ?? []).map((branch) => branch.properties?.action?.const).filter(Boolean),
      );
      expect(actions).toEqual(families.get(family) ?? new Set<string>());
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP contains thrown context errors without secrets or stacks", async () => {
  const { client, server } = await connect("cursor", {
    current: async () => {
      throw new Error("Bearer super-secret stack: /home/private/file.ts:1:2");
    },
  });
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    const text = JSON.stringify(result.structuredContent);
    expect(result.isError).toBe(true);
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("stack:");
    expect(text).not.toContain("/home/private");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP reports unavailable context as a structured capability result", async () => {
  const { client, server } = await connect("codex_cli", {
    current: async () => {
      throw new McpCapabilityUnavailableError("workspace");
    },
  });
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      schemaVersion: 1,
      code: "capability_unavailable",
      error: "workspace unavailable",
      details: { capability: "workspace" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("/home");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP contains thrown core errors without exposing the original message", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-core-error-"));
  const { client, server } = await connect("cursor", {
    current: async () => ({
      ...context("cursor", workspaceRoot),
      now: () => {
        throw new Error("password=secret-value at /home/private/source.ts:9:4");
      },
    }),
  });
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: taskStartRequest(),
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.structuredContent);
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("source.ts");
  } finally {
    await client.close();
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP validates the executable host allowlist", () => {
  expect(() =>
    createMcpServer("workit_cli" as never, { current: async () => context("cursor") }),
  ).toThrow(/host/i);
});
