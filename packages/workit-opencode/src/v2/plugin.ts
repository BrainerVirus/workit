// Deep subpath on purpose: the package root re-exports the whole schema/effect
// runtime, and only the identity `define` (plus its types) is used here. The
// packed-artifact test proves the bundle stays free of @opencode/* imports.
import { define, type Context } from "@opencode/plugin/promise/plugin";
import {
  TaskStore,
  WorkitCore,
  externalActionRequest,
  failure,
  parseOperation,
} from "@brainervirus/workit-core/src/core";
import {
  executeResolvedExternalAction,
  resolveExternalActionRequest,
} from "@brainervirus/workit-core/src/core/external-action-effects";
import { executeInitApply, initApplyRuntime } from "../shared/init-apply";
import { sameWorkspace } from "../shared/session";
import { WORKIT_TOOL_CATALOG, workitFamilyOf } from "../shared/tools";

/** V2-native session facts a Workit call is bound to. A present `parentID`
 * means a child session: worker lineage is validated by the lifecycle port
 * before children may run family tools. */
export type V2Session = {
  id: string;
  parentID?: string;
  directory: string;
};

const sessionFacts = async (ctx: Context, sessionID: string): Promise<V2Session | null> => {
  try {
    const session = await ctx.session.get({ sessionID });
    const id = session?.id;
    const directory = session?.location?.directory;
    if (typeof id !== "string" || id !== sessionID || typeof directory !== "string") return null;
    const parentID = typeof session.parentID === "string" ? session.parentID : undefined;
    return { id, parentID, directory };
  } catch {
    return null;
  }
};

const resultContent = (value: unknown): { content: string } => ({
  content: JSON.stringify(value, null, 2),
});

/** V2 host capabilities are declared as each surface is ported: session-scoped
 * task work is honest now; receipts, lineage, and route denial land with their
 * ports and must not be claimed early. */
const v2Capabilities = () => [
  {
    name: "known_product_writes",
    surface: "edit/shell",
    assurance: "unavailable" as const,
    reason:
      "file writes are host-policy; OpenCode native permissions govern them, workit no longer gates write tools",
    refs: [{ kind: "host" as const, host: "opencode" as const, handle: "permission.evaluate" }],
  },
  {
    name: "fresh-context-review",
    surface: "subagent",
    assurance: "agent_guided" as const,
    reason:
      "independent review runs as a native child session; evidence evaluation enforces creator and duplicate-reviewer exclusion",
    refs: [{ kind: "host" as const, host: "opencode" as const, handle: "subagent" }],
  },
];

export const setup = async (ctx: Context): Promise<() => void> => {
  const root = ctx.location.directory;
  await ctx.tool.transform((editor) => {
    for (const spec of WORKIT_TOOL_CATALOG) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: spec.input as never,
        // The spike proved direct tool calls require codemode off; without it
        // the tool stays code-mode-only and is never offered to the model.
        options: { codemode: false },
        execute: async (input: unknown, tool) => {
          const session = await sessionFacts(ctx, tool.sessionID);
          if (session === null || !sameWorkspace(root, session.directory))
            return resultContent(
              failure(
                "permission_denied",
                "OpenCode session location does not match the plugin checkout",
              ),
            );
          if (session.parentID !== undefined)
            return resultContent(
              failure("permission_denied", "child sessions cannot run Workit tools directly"),
            );
          const family = workitFamilyOf(spec.name);
          if (family !== null) {
            const parsed = parseOperation(family, input);
            if (!parsed.ok) return resultContent(parsed);
            const store = new TaskStore(root);
            const core = new WorkitCore(store, {
              root,
              caller: { host: "opencode", actor: session.id },
              capabilities: v2Capabilities(),
              constraints: [],
              now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
              workerId: null,
            });
            const run = core[family] as unknown as (request: unknown) => unknown;
            return resultContent(run.call(core, parsed.data));
          }
          if (spec.name === "workit_external_action") {
            const parsed = externalActionRequest(input);
            if (!parsed.ok) return resultContent(parsed);
            if (parsed.data.operation !== "context.read")
              return resultContent(
                failure(
                  "capability_unavailable",
                  "OpenCode V2 external action approvals are not available yet; only context.read is",
                  { capability: "external_action", outcome: "not_started" },
                ),
              );
            const resolved = resolveExternalActionRequest(root, parsed.data);
            if (!resolved.ok) return resultContent(resolved);
            return resultContent(await executeResolvedExternalAction(resolved.data, root));
          }
          if (spec.name === "workit_init_apply") {
            // The shared executor already returns the contract JSON; prose
            // checking stays core-side.
            return { content: executeInitApply(input as never, root, initApplyRuntime) };
          }
          return resultContent(failure("not_found", `unknown Workit tool ${spec.name}`));
        },
      });
    }
  });
  return () => {};
};

const definition = define({ id: "workit", setup });

export default definition;
