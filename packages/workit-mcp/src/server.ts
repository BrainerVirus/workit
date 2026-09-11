import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import {
  OPERATION_FAMILIES,
  WorkitCore,
  TaskStore,
  boundedOperationJsonSchema,
  parseOperation,
  type OperationContext,
  type OperationFamily,
} from "@brainervirus/workit-core/src/core";
import {
  changedSourcesSinceLoad,
  markSourcesLoaded,
} from "@brainervirus/workit-core/src/core/boundary";
import type { Host, Result } from "@brainervirus/workit-core/src/core/task-contract";
import { redactSecrets } from "@brainervirus/workit-core/src/core/logger";
import { readExternalContext } from "@brainervirus/workit-core/src/core/external-action-effects";

export type McpHost = Extract<Host, "cursor" | "codex_cli" | "codex_desktop">;
export type NativeContextProvider = { current(): Promise<OperationContext> };

export class McpCapabilityUnavailableError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`${capability} unavailable`);
    this.name = "McpCapabilityUnavailableError";
    this.capability = capability;
  }
}

class McpResourceInputError extends Error {}

const MCP_HOSTS = new Set<McpHost>(["cursor", "codex_cli", "codex_desktop"]);
const CONTEXT_KINDS = ["git", "pr", "youtrack", "github_issue", "gitlab_issue", "changelog", "release", "affected"] as const;
type ContextKind = (typeof CONTEXT_KINDS)[number];
const CONTEXT_SELECTORS = ["range", "issueId"] as const;
const safeCapability = (value: string, allowed: readonly string[]): string =>
  allowed.includes(value) ? value : "context";
const TOOL_CAPABILITIES = [
  ...CONTEXT_KINDS,
  "workspace",
  "native_caller_identity",
  "external_action",
];
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

const rootVariants = (workspaceRoot?: string): string[] => {
  if (!workspaceRoot) return [];
  const roots = new Set<string>();
  for (const candidate of [workspaceRoot, path.resolve(workspaceRoot)]) {
    if (path.isAbsolute(candidate) && candidate !== path.parse(candidate).root)
      roots.add(candidate);
  }
  try {
    const canonical = realpathSync(workspaceRoot);
    if (canonical !== path.parse(canonical).root) roots.add(canonical);
  } catch {
    // The core will return a structured failure for an unavailable root.
  }
  return [...roots].sort((left, right) => right.length - left.length);
};

export const sanitizeTransportText = (value: unknown, workspaceRoot?: string): string => {
  const message = value instanceof Error ? value.message : String(value);
  const withoutStack = message.split(/\r?\n/, 1)[0].replace(/\s+(?:at|stack:)\s.*$/i, "");
  const withoutRoot = rootVariants(workspaceRoot).reduce(
    (current, root) => current.split(root).join("[WORKSPACE_ROOT]"),
    withoutStack,
  );
  return redactSecrets(withoutRoot).slice(0, 500);
};

const reportError = (tool: string, error: unknown, workspaceRoot?: string): void => {
  try {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "MCP tool failed", tool, error: sanitizeTransportText(error, workspaceRoot) })}\n`,
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

const READ_ONLY_ACTIONS = new Set(["list", "inspect", "preview", "explain", "export"]);
const requiresCallerIdentity = (input: unknown): boolean =>
  typeof input !== "object" ||
  input === null ||
  !READ_ONLY_ACTIONS.has(String((input as { action?: unknown }).action));

const toolInputSchema = (family: OperationFamily) => {
  const schema = boundedOperationJsonSchema(family);
  // MCP requires an object at the root. The operation union remains entirely
  // core-derived; this envelope preserves it while satisfying that protocol rule.
  return { type: "object" as const, ...schema };
};

const sanitizeFailure = (result: Result<unknown>, workspaceRoot?: string): Result<unknown> => {
  if (result.ok) return result;
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") return sanitizeTransportText(value, workspaceRoot);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    }
    return value;
  };
  return sanitize(result) as Result<unknown>;
};

const resultForClient = (result: Result<unknown>, workspaceRoot?: string): CallToolResult => {
  const safe = sanitizeFailure(result, workspaceRoot);
  return {
    content: [{ type: "text", text: JSON.stringify(safe) }],
    structuredContent: safe,
    ...(safe.ok ? {} : { isError: true }),
  };
};

const thrownResult = (tool: string, error: unknown, workspaceRoot?: string): CallToolResult => {
  reportError(tool, error, workspaceRoot);
  if (error instanceof McpCapabilityUnavailableError) {
    const capability = safeCapability(error.capability, TOOL_CAPABILITIES);
    return resultForClient(
      {
        ok: false,
        schemaVersion: 1,
        code: "capability_unavailable",
        error: `${capability} unavailable`,
        details: { capability },
      },
      workspaceRoot,
    );
  }
  const result = {
    ok: false as const,
    schemaVersion: 1 as const,
    code: "storage_error" as const,
    error: "MCP operation failed",
    details: {},
  };
  return resultForClient(result, workspaceRoot);
};

export function createMcpServer(host: McpHost, contextProvider: NativeContextProvider): Server {
  assertMcpHost(host);
  // Long-lived MCP servers load core once; warn once (never block) when the
  // checkout sources move underneath, mirroring the OpenCode plugin guard.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceMarker = markSourcesLoaded(
    [
      path.join(here, "server.ts"),
      path.join(here, "..", "..", "workit-core", "src", "core", "task-contract.ts"),
      path.join(here, "..", "..", "workit-core", "src", "core", "task-engine.ts"),
    ].filter((file) => existsSync(file)),
  );
  let staleWarned = false;
  const server = new Server(
    { name: "workit", version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: OPERATION_FAMILIES.map((family) => ({
      name: `workit_${family}`,
      description: operationDescription(family),
      inputSchema: toolInputSchema(family),
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: CONTEXT_KINDS.map((kind) => ({
      uri: `workit://context/${kind}`,
      name: `Workit ${kind} context`,
      description: "Read-only context derived from the host-owned workspace.",
      mimeType: "application/json",
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "workit://context/{kind}{?range,issueId}",
        name: "Workit context",
        description: "Read-only context; workspace and caller come from the host session.",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    let workspaceRoot: string | undefined;
    try {
      const context = await contextProvider.current();
      workspaceRoot = context.root;
      if (context.caller.host !== host)
        throw new Error("native context host does not match MCP host");
      const parsed = new URL(request.params.uri);
      if (parsed.protocol !== "workit:" || parsed.hostname !== "context")
        throw new McpResourceInputError("unsupported Workit context URI");
      const kind = parsed.pathname.replace(/^\//, "") as ContextKind;
      if (!CONTEXT_KINDS.includes(kind))
        throw new McpResourceInputError("unsupported Workit context kind");
      for (const key of parsed.searchParams.keys())
        if (!CONTEXT_SELECTORS.includes(key as (typeof CONTEXT_SELECTORS)[number]))
          throw new McpResourceInputError("unsupported Workit context selector");
      const result = await readExternalContext(context.root, {
        kind,
        ...(parsed.searchParams.get("range") ? { range: parsed.searchParams.get("range")! } : {}),
        ...(parsed.searchParams.get("issueId")
          ? { issueId: parsed.searchParams.get("issueId")! }
          : {}),
      });
      if (!result.ok) throw new McpCapabilityUnavailableError(result.details.capability ?? kind);
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(result.data),
          },
        ],
      };
    } catch (error) {
      reportError("context.read", error, workspaceRoot);
      const capability =
        error instanceof McpCapabilityUnavailableError
          ? safeCapability(error.capability, CONTEXT_KINDS)
          : "context";
      const safe =
        error instanceof McpCapabilityUnavailableError
          ? {
              ok: false,
              schemaVersion: 1,
              code: "capability_unavailable",
              error: `${capability} unavailable`,
              details: { capability },
            }
          : error instanceof McpResourceInputError
            ? {
                ok: false,
                schemaVersion: 1,
                code: "invalid_input",
                error: "invalid context resource request",
                details: {},
              }
            : {
                ok: false,
                schemaVersion: 1,
                code: "storage_error",
                error: "MCP operation failed",
                details: {},
              };
      return {
        contents: [
          { uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(safe) },
        ],
      };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!staleWarned && changedSourcesSinceLoad(sourceMarker).length > 0) {
      staleWarned = true;
      try {
        process.stderr.write(
          `${JSON.stringify({ level: "warn", message: "workit sources changed after MCP load; restart the server for latest behavior" })}\n`,
        );
      } catch {
        // Diagnostics must never break the protocol response.
      }
    }
    const toolName = request.params.name;
    let workspaceRoot: string | undefined;
    try {
      const family = OPERATION_FAMILIES.find((candidate) => toolName === `workit_${candidate}`);
      if (!family) {
        return resultForClient({
          ok: false,
          schemaVersion: 1,
          code: "invalid_input",
          error: sanitizeTransportText(`Unknown Workit tool: ${toolName}`),
          details: { fields: [{ path: "name", reason: "unknown operation family" }] },
        });
      }

      const context = await contextProvider.current();
      workspaceRoot = context.root;
      if (context.caller.host !== host) {
        return resultForClient(
          {
            ok: false,
            schemaVersion: 1,
            code: "invalid_input",
            error: "native context host does not match MCP host",
            details: { operation: family },
          },
          workspaceRoot,
        );
      }
      const parsed = parseOperation(family, request.params.arguments);
      if (!parsed.ok) return resultForClient(parsed, workspaceRoot);
      if (context.callerAttested === false && requiresCallerIdentity(parsed.data))
        return resultForClient(
          {
            ok: false,
            schemaVersion: 1,
            code: "capability_unavailable",
            error:
              "native caller identity is unavailable; run the workit CLI for mutations: node_modules/.bin/workit <family> <action> --json --confirm (bind a writer with --actor <session-id>)",
            details: { capability: "native_caller_identity", operation: family },
          },
          workspaceRoot,
        );

      const core = new WorkitCore(new TaskStore(context.root), context);
      const run = core[family] as unknown as (input: unknown) => Result<unknown>;
      return resultForClient(run.call(core, parsed.data), workspaceRoot);
    } catch (error) {
      return thrownResult(toolName, error, workspaceRoot);
    }
  });

  return server;
}

const defaultContextProvider = (host: McpHost): NativeContextProvider => {
  const root = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd();
  const actor = process.env.WORKFLOW_SESSION_ID ?? "";
  return {
    current: async () => ({
      root,
      caller: { host, actor },
      callerAttested: actor !== "",
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
