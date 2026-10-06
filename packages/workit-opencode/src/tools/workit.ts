import {
  OPERATION_FAMILIES,
  WorkitCore,
  TaskStore,
  failure,
  parseAdvertisedOperation,
  success,
  type OperationFamily,
  type OperationContext,
  type ContractResult as Result,
  type Entry,
  type TaskRecord,
  type Worker,
} from "@brainervirus/workit-core/src/core";
import type { NativeWorkerVerifier } from "@brainervirus/workit-core/src/core/workers";
import { createContextTool } from "./context";

type SessionLookup = {
  session: {
    get: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo }>;
  };
};

type SessionInfo = { id?: string; parentID?: string; directory?: string };

const sessionParent = (session: unknown): string | undefined | null => {
  if (typeof session !== "object" || session === null) return null;
  if (!Object.prototype.hasOwnProperty.call(session, "parentID")) return undefined;
  const parentID = (session as SessionInfo).parentID;
  return typeof parentID === "string" && parentID.length > 0 ? parentID : null;
};

export type DirectChildren = Map<string, string>;
const output = (value: unknown): string => JSON.stringify(value, null, 2);

const sessionData = async (client: SessionLookup | undefined, sessionID: string) => {
  if (!client) return null;
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    const data = result.data;
    if (!data || data.id !== sessionID || typeof data.directory !== "string" || !data.directory)
      return null;
    return data;
  } catch {
    return null;
  }
};

import { sameWorkspace } from "../shared/session";

const hostRef = (handle: string) => ({ kind: "host" as const, host: "opencode" as const, handle });

export const opencodeCapabilities = () => [
  {
    name: "direct_child_workers",
    surface: "task",
    assurance: "enforced" as const,
    reason: "nested native task launches are denied and observed child sessions are parent-bound",
    refs: [hostRef("task")],
  },
  {
    name: "fresh-context-review",
    surface: "task",
    assurance: "agent_guided" as const,
    reason:
      "independent review runs as a native direct-child session; evidence evaluation enforces creator and duplicate-reviewer exclusion",
    refs: [hostRef("task")],
  },
  {
    name: "known_product_writes",
    surface: "write/edit/bash",
    assurance: "unavailable" as const,
    reason:
      "file writes are host-policy; OpenCode native permissions govern them, workit no longer gates write tools",
    refs: [hostRef("tool.execute.before")],
  },
  {
    name: "arbitrary_shell_write",
    surface: "unobservable_shell",
    assurance: "agent_guided" as const,
    reason: "OpenCode does not expose a reliable interception boundary for every shell mutation",
    refs: [hostRef("tool.execute.before")],
  },
];

export const nativeWorkerFor = (
  directChildren: DirectChildren,
  actor: string,
): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller }) => {
    if (caller.host !== "opencode" || caller.actor !== actor || !expected.session)
      return failure("permission_denied", "native worker observation is unavailable");
    if (expected.session.kind !== "host" || directChildren.get(expected.session.handle) !== actor)
      return failure("permission_denied", "worker lineage is not an exact direct child");
    return success(null, null, {
      kind: "host_observed",
      host: "opencode",
      session: hostRef(expected.session.handle),
      workerId: expected.workerId,
    });
  },
});

/** The dispatch coordinator is persisted for restart safety. Records created
 * before that field existed fall back to their original task creator. */
export const workerCoordinatorFor = (task: TaskRecord, worker: Entry<Worker>): string | null => {
  const coordinator = worker.data.coordinator ?? task.intent.provenance.session;
  return coordinator?.kind === "host" && coordinator.host === "opencode"
    ? coordinator.handle
    : null;
};

const workerIdFor = (
  store: TaskStore,
  actor: string,
  current: SessionInfo,
  directChildren: DirectChildren,
): string | null => {
  const parentID = sessionParent(current);
  if (!parentID) return null;
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

/** A host-native tool body. OpenCode V2 advertises the input schema from
 * `shared/tools.ts`; this object only carries the execution. */
export type NativeTool = {
  description: string;
  execute: (args: any, context: { directory: string; sessionID: string }) => Promise<string>;
};

export type WorkitToolOptions = {
  client?: SessionLookup;
  directChildren?: DirectChildren;
};

export const createWorkitTools = ({
  client,
  directChildren = new Map<string, string>(),
}: WorkitToolOptions = {}): Record<string, NativeTool> => {
  const make = (family: OperationFamily): NativeTool => ({
    description: `Workit ${family} operations backed by the shared task contract.`,
    execute: async (args, context) => {
      const parsed = parseAdvertisedOperation(family, args, "opencode");
      if (!parsed.ok) return output(parsed);
      if (!client)
        return output(
          failure("permission_denied", "OpenCode native session observation unavailable"),
        );
      const data = await sessionData(client, context.sessionID);
      if (data === null || !sameWorkspace(context.directory, data.directory ?? ""))
        return output(failure("permission_denied", "OpenCode session observation unavailable"));
      const parentID = sessionParent(data);
      if (parentID === null)
        return output(failure("permission_denied", "OpenCode session parentage is malformed"));
      const store = new TaskStore(context.directory);
      const workerId = workerIdFor(store, context.sessionID, data, directChildren);
      if (parentID !== undefined && workerId === null)
        return output(
          failure("permission_denied", "OpenCode child session has no validated Workit worker"),
        );
      const operationContext: OperationContext = {
        root: context.directory,
        caller: { host: "opencode", actor: context.sessionID },
        capabilities: opencodeCapabilities(),
        constraints: [],
        now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        workerId,
        nativeWorker: nativeWorkerFor(directChildren, context.sessionID),
      };
      const core = new WorkitCore(store, operationContext);
      const run = core[family] as unknown as (request: unknown) => Result<unknown>;
      const result = run.call(core, parsed.data);
      return output(result);
    },
  });
  const tools = Object.fromEntries(
    OPERATION_FAMILIES.map((family) => [`workit_${family}`, make(family)]),
  );
  return {
    ...tools,
    workit_context: createContextTool(),
  };
};
