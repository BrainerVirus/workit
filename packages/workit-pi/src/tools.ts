import {
  failure,
  boundedOperationJsonSchema,
  contextReadJsonSchema,
  parseContextRead,
  readExternalContext,
  OPERATION_SCHEMA_DEPTH,
  OPERATION_FAMILIES,
  parseOperation,
  success,
  TaskStore,
  WorkitCore,
  type OperationFamily,
  type ContractResult as Result,
} from "@brainervirus/workit-core/src/core";
import { shellPolicy } from "@brainervirus/workit-core/hooks";
import type {
  ExtensionContext,
  AgentToolResult,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { piContext } from "./context";

const readOnlyActions = new Set(["list", "inspect", "preview", "explain", "export"]);

const output = (result: Result<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
});
type PiToolResult = AgentToolResult<Result<unknown>>;

const schemaFor = (family: OperationFamily) =>
  ({ type: "object", ...boundedOperationJsonSchema(family, OPERATION_SCHEMA_DEPTH, true) }) as any;

const decodeStrings = (value: unknown): unknown => {
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === "string" ? value : decoded;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(decodeStrings);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeStrings(entry)]),
    );
  return value;
};

const trustedForMutation = (ctx: ExtensionContext, action: unknown): Result<null> => {
  if (ctx.isProjectTrusted() || readOnlyActions.has(String(action)))
    return success(null, null, null);
  return failure("permission_denied", "Pi project is not trusted for Workit mutations");
};

const executeFamily = async (
  family: OperationFamily,
  input: unknown,
  ctx: ExtensionContext,
): Promise<PiToolResult> => {
  // Pi may deliver structured params as JSON strings (host transport quirk).
  // Strict input wins; a decoded retry only rescues stringified payloads, and
  // the original failure stands when decoding changes nothing.
  const parsedStrict = parseOperation(family, input);
  const parsed = parsedStrict.ok ? parsedStrict : parseOperation(family, decodeStrings(input));
  if (!parsed.ok) return output(parsedStrict);
  const trust = trustedForMutation(ctx, (parsed.data as { action?: unknown }).action);
  if (!trust.ok) return output(trust);
  const core = new WorkitCore(new TaskStore(ctx.cwd), piContext(ctx));
  const run = core[family] as unknown as (request: unknown) => Result<unknown>;
  return output(run.call(core, parsed.data));
};

export const registerWorkitTools = (
  pi: { registerTool(tool: ToolDefinition): void },
  options: { allowContext?: boolean } = {},
): void => {
  for (const family of OPERATION_FAMILIES)
    pi.registerTool({
      name: `workit_${family}`,
      label: `workit_${family}`,
      description: `Workit ${family} operations backed by the shared task contract.`,
      parameters: schemaFor(family),
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return executeFamily(family, input, ctx);
      },
    });
  if (options.allowContext === false) return;
  // Delivery (push, PR, merge) is the workit CLI's git/pr/stack verbs under the
  // workspace autonomy grants; Pi keeps only the read-only context reader.
  pi.registerTool({
    name: "workit_context",
    label: "workit_context",
    description:
      "Read Git, pull request, YouTrack, issue, changelog, release, or affected-file context.",
    parameters: contextReadJsonSchema(),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const parsed = parseContextRead(decodeStrings(input));
      if (!parsed.ok) return output(parsed);
      return output(await readExternalContext(ctx.cwd, parsed.data));
    },
  });
};

export const enforceToolPolicy = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
): { block: true; reason: string } | undefined => {
  if (event.toolName === "bash") {
    const command = (event.input as { command?: unknown } | undefined)?.command;
    const decision = typeof command === "string" ? shellPolicy(ctx.cwd, command) : null;
    return decision?.kind === "deny" ? { block: true, reason: decision.reason } : undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  // Pi project trust is host policy and stays enforced; Workit does not gate
  // file writes (D2: authority is the host's permissions plus autonomy grants).
  if (!ctx.isProjectTrusted()) return { block: true, reason: "Pi project is not trusted" };
  return undefined;
};
