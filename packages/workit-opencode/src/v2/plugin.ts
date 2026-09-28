// Deep subpath on purpose: the package root re-exports the whole schema/effect
// runtime, and only the identity `define` (plus its types) is used here. The
// packed-artifact test proves the bundle stays free of @opencode/* imports.
import { define, type Context } from "@opencode/plugin/promise/plugin";
import {
  TaskStore,
  WorkitCore,
  failure,
  parseOperation,
  type OperationFamily,
} from "@brainervirus/workit-core/src/core";
import {
  changedSourcesSinceLoad,
  markSourcesLoaded,
} from "@brainervirus/workit-core/src/core/boundary";
import { executeInitApply, initApplyRuntime } from "../shared/init-apply";
import { sameWorkspace } from "../shared/session";
import { WORKIT_TOOL_CATALOG, workitFamilyOf } from "../shared/tools";
import {
  NativeReceiptStore,
  createWorkitTools,
  nativeAuthority,
  nativeWorkerFor,
  workerCoordinatorFor,
  type DirectChildren,
} from "../tools/workit";
import { createV2Lifecycle } from "./lifecycle";
import { injectAgentContext, injectCompactionContext, injectHistoryOffer } from "./injection";
import { evaluateShellPermission } from "./permissions";
import { normalizeQuestionAnswers } from "./receipts";
import { registerCommands, registerSkills } from "./registry";
import { pluginSourceFiles } from "../stale-sources";

/** V2-native session facts a Workit call is bound to. A present `parentID`
 * means a child session: worker lineage is validated by the lifecycle port
 * before children may run family tools. */
type V2Session = {
  id: string;
  parentID?: string;
  directory: string;
  outcome?: "succeeded" | "failed" | "interrupted";
};

const sessionFacts = async (ctx: Context, sessionID: string): Promise<V2Session | null> => {
  try {
    const session = await ctx.session.get({ sessionID });
    const id = session?.id;
    const directory = session?.location?.directory;
    if (typeof id !== "string" || id !== sessionID || typeof directory !== "string") return null;
    const parentID = typeof session.parentID === "string" ? session.parentID : undefined;
    const outcome =
      session.outcome === "succeeded" ||
      session.outcome === "failed" ||
      session.outcome === "interrupted"
        ? session.outcome
        : undefined;
    return { id, parentID, directory, outcome };
  } catch {
    return null;
  }
};

const resultContent = (value: unknown): { content: string } => ({
  content: JSON.stringify(value, null, 2),
});

/** V2 host capabilities are declared as each native surface is ported. */
const v2Capabilities = () => [
  {
    name: "interactive_decision",
    surface: "question",
    assurance: "enforced" as const,
    reason: "native question answers are observed by tool.execute.after and consumed once",
    refs: [{ kind: "host" as const, host: "opencode" as const, handle: "question" }],
  },
  {
    name: "external_action",
    surface: "workit_external_action",
    assurance: "enforced" as const,
    reason: "native question receipts bind each resolved action descriptor before execution",
    refs: [
      { kind: "host" as const, host: "opencode" as const, handle: "question" },
      { kind: "host" as const, host: "opencode" as const, handle: "workit_external_action" },
    ],
  },
  {
    name: "known_product_writes",
    surface: "edit/shell",
    assurance: "unavailable" as const,
    reason:
      "file writes are host-policy; OpenCode native permissions govern them, workit no longer gates write tools",
    refs: [{ kind: "host" as const, host: "opencode" as const, handle: "permission.evaluate" }],
  },
  {
    name: "direct_child_workers",
    surface: "subagent",
    assurance: "enforced" as const,
    reason:
      "nested subagent launches are denied and observed child sessions are parent-bound before they may own a worker",
    refs: [{ kind: "host" as const, host: "opencode" as const, handle: "subagent" }],
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

/** A child session may run family tools only as a validated running worker of
 * its coordinator; anything else stays denied. */
const workerIdFor = (
  store: TaskStore,
  actor: string,
  parentID: string | undefined,
  directChildren: DirectChildren,
): string | null => {
  if (parentID === undefined) return null;
  const tasks = store.listTasks();
  if (!tasks.ok) return null;
  const matches = tasks.data.flatMap((task) => {
    if (task.status !== "active") return [];
    if (directChildren.get(actor) !== parentID) return [];
    return task.workers.filter(
      (worker) =>
        worker.data.state === "running" &&
        worker.data.session?.kind === "host" &&
        worker.data.session.host === "opencode" &&
        worker.data.session.handle === actor &&
        workerCoordinatorFor(task, worker) === parentID,
    );
  });
  return matches.length === 1 ? matches[0].id : null;
};

const setup = async (ctx: Context): Promise<() => void> => {
  const root = ctx.location.directory;
  const sourceMarker = markSourcesLoaded(pluginSourceFiles);
  let staleSourcesWarned = false;
  const historyOfferSessions = new Set<string>();
  const receipts = new NativeReceiptStore();
  const lifecycle = createV2Lifecycle({
    root,
    getSession: async (sessionID) => {
      const session = await sessionFacts(ctx, sessionID);
      return session
        ? {
            id: session.id,
            parentID: session.parentID,
            directory: session.directory,
            outcome: session.outcome,
          }
        : null;
    },
  });
  // Reuse V1's proposal/receipt runner with V2's observed session lookup; both
  // paths use the same native receipts, lineage map, and shared Workit core.
  const nativeTools = createWorkitTools({
    receipts,
    directChildren: lifecycle.directChildren,
    client: {
      session: {
        get: async ({ path: { id } }: { path: { id: string } }) => {
          const session = await sessionFacts(ctx, id);
          if (!session) return {};
          return {
            data: {
              id: session.id,
              directory: session.directory,
              ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
            },
          };
        },
      },
    },
  });
  const nativeToolMap = nativeTools as unknown as Record<
    "workit_decision" | "workit_external_action",
    {
      execute: (
        args: unknown,
        context: { directory: string; sessionID: string },
      ) => Promise<unknown>;
    }
  >;
  const executeNativeTool = async (
    name: "workit_decision" | "workit_external_action",
    input: unknown,
    sessionID: string,
  ): Promise<{ content: string }> => {
    const hostTool = nativeToolMap[name];
    const result = await hostTool.execute(input, { directory: root, sessionID });
    return { content: typeof result === "string" ? result : JSON.stringify(result) };
  };
  const runFamily = (
    family: OperationFamily,
    input: unknown,
    session: V2Session,
    store: TaskStore,
    workerId: string | null,
  ): unknown => {
    const parsed = parseOperation(family, input);
    if (!parsed.ok) return parsed;
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: session.id },
      capabilities: v2Capabilities(),
      constraints: [],
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      workerId,
      nativeAuthority: nativeAuthority(receipts, session.id),
      nativeWorker: nativeWorkerFor(lifecycle.directChildren, session.id),
    });
    const run = core[family] as unknown as (request: unknown) => unknown;
    return run.call(core, parsed.data);
  };
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
          const store = new TaskStore(root);
          const workerId = workerIdFor(
            store,
            session.id,
            session.parentID,
            lifecycle.directChildren,
          );
          if (session.parentID !== undefined && workerId === null)
            return resultContent(
              failure("permission_denied", "OpenCode child session has no validated Workit worker"),
            );
          const family = workitFamilyOf(spec.name);
          if (family === "decision") return executeNativeTool("workit_decision", input, session.id);
          if (family !== null)
            return resultContent(runFamily(family, input, session, store, workerId));
          if (spec.name === "workit_external_action") {
            return executeNativeTool("workit_external_action", input, session.id);
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
  await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return;
    await lifecycle.executeBefore({
      tool: event.tool,
      sessionID: String(event.sessionID),
      id: String(event.id),
      input: event.input,
    });
  });
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool === "question") {
      if (event.status !== "completed") return;
      const metadata = (event.result as { metadata?: unknown }).metadata;
      const answers = (metadata as { answers?: unknown } | undefined)?.answers;
      receipts.record(
        { sessionID: String(event.sessionID), callID: String(event.id), args: event.input },
        {
          metadata:
            metadata === undefined ? undefined : { answers: normalizeQuestionAnswers(answers) },
        },
      );
      return;
    }
    if (event.tool !== "subagent") return;
    await lifecycle.executeAfter({
      tool: event.tool,
      sessionID: String(event.sessionID),
      id: String(event.id),
      input: event.input,
      ...(event.status === "completed"
        ? { status: "completed" as const, result: event.result as never }
        : { status: "error" as const, error: event.error }),
    });
  });
  await ctx.permission.hook("evaluate", (event) => {
    evaluateShellPermission(root, event);
  });
  await ctx.session.hook("context", async (event) => {
    const session = await sessionFacts(ctx, String(event.sessionID));
    injectAgentContext(root, session, lifecycle.directChildren, event.system as never);
    injectHistoryOffer(root, session, historyOfferSessions, event.system as never);
    if (!staleSourcesWarned) {
      const changed = changedSourcesSinceLoad(sourceMarker);
      if (changed.length > 0) {
        staleSourcesWarned = true;
        (event.system as Array<{ type: "text"; text: string }>).push({
          type: "text",
          text: `<workit-warning>Workit sources changed after plugin load (${changed.map((file) => file.split(/[\\/]/).at(-1)).join(", ")}); restart the session for latest behavior.</workit-warning>`,
        });
      }
    }
  });
  await ctx.session.hook("compaction", (event) => {
    injectCompactionContext(root, String(event.sessionID), event.system as never);
  });
  await registerSkills(ctx as never);
  await registerCommands(ctx as never);
  const subscription = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
        await lifecycle.handleEvent(event as never);
      }
    } catch {
      // Subscription end and abort are normal teardown; event delivery must
      // never break hook delivery.
    }
  })();
  return () => {
    subscription.abort();
  };
};

const definition = define({ id: "workit", setup });

export default definition;
