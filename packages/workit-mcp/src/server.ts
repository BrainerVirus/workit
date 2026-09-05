import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OPERATION_FAMILIES,
  WorkitCore,
  TaskStore,
  operationJsonSchema,
  parseOperation,
  type OperationContext,
  type OperationFamily,
} from "@brainervirus/workit-core/src/core";
import type { Host, Result } from "@brainervirus/workit-core/src/core/task-contract";

export type McpHost = Extract<Host, "cursor" | "codex_cli" | "codex_desktop">;
export type NativeContextProvider = { current(): Promise<OperationContext> };

const MCP_HOSTS = new Set<McpHost>(["cursor", "codex_cli", "codex_desktop"]);
const VERSION = (() => {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(/\r?\n/, 1)[0]
    .replace(/\s+(?:at|stack:)\s.*$/i, "")
    .replace(/\b(?:Bearer|Basic|Digest|Token)\s+\S+/gi, "[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api[_-]?key|authorization|credential|bearer)[A-Za-z0-9_-]*)([:=]\s*).+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/[^?#\s]+)\?[^#\s]*/g, "$1?[REDACTED]")
    .slice(0, 500);
};

const reportError = (tool: string, error: unknown): void => {
  try {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "MCP tool failed", tool, error: safeErrorMessage(error) })}\n`,
    );
  } catch {
    // Diagnostics must never break the protocol response.
  }
};

export function assertMcpHost(host: unknown): asserts host is McpHost {
  if (typeof host !== "string" || !MCP_HOSTS.has(host as McpHost)) {
    throw new Error("MCP host must be cursor, codex_cli, or codex_desktop");
  }
}

const operationDescription = (family: OperationFamily): string =>
  `Workit ${family} operations. Inputs are validated by the shared Workit contract.`;

const toolInputSchema = (family: OperationFamily) => {
  const schema = operationJsonSchema(family);
  // MCP requires an object at the root. The operation union remains entirely
  // core-derived; this envelope preserves it while satisfying that protocol rule.
  return { type: "object" as const, ...schema };
};

const mcpResult = (result: Result<unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
  ...(result.ok ? {} : { isError: true }),
});

const thrownResult = (tool: string, error: unknown): CallToolResult => {
  reportError(tool, error);
  const result = {
    ok: false as const,
    schemaVersion: 1 as const,
    code: "storage_error" as const,
    error: "MCP operation failed",
    details: {},
  };
  return mcpResult(result);
};

export function createMcpServer(host: McpHost, contextProvider: NativeContextProvider): Server {
  assertMcpHost(host);
  const server = new Server({ name: "workit", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: OPERATION_FAMILIES.map((family) => ({
      name: `workit_${family}`,
      description: operationDescription(family),
      inputSchema: toolInputSchema(family),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    try {
      const family = OPERATION_FAMILIES.find((candidate) => toolName === `workit_${candidate}`);
      if (!family) {
        return mcpResult({
          ok: false,
          schemaVersion: 1,
          code: "invalid_input",
          error: safeErrorMessage(`Unknown Workit tool: ${toolName}`),
          details: { fields: [{ path: "name", reason: "unknown operation family" }] },
        });
      }

      const context = await contextProvider.current();
      if (context.caller.host !== host) {
        return mcpResult({
          ok: false,
          schemaVersion: 1,
          code: "invalid_input",
          error: "native context host does not match MCP host",
          details: { operation: family },
        });
      }
      const parsed = parseOperation(family, request.params.arguments);
      if (!parsed.ok) return mcpResult(parsed);

      const core = new WorkitCore(new TaskStore(context.root), context);
      const run = core[family] as unknown as (input: unknown) => Result<unknown>;
      return mcpResult(run.call(core, parsed.data));
    } catch (error) {
      return thrownResult(toolName, error);
    }
  });

  return server;
}

const defaultContextProvider = (host: McpHost): NativeContextProvider => {
  const root = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd();
  const actor = process.env.WORKFLOW_SESSION_ID ?? "mcp";
  return {
    current: async () => ({
      root,
      caller: { host, actor },
      capabilities: [],
      constraints: [],
      now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  };
};

export async function runStdioServer(
  host: McpHost,
  contextProvider: NativeContextProvider = defaultContextProvider(host),
): Promise<Server> {
  assertMcpHost(host);
  const server = createMcpServer(host, contextProvider);
  await server.connect(new StdioServerTransport());
  return server;
}
