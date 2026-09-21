import { TaskStore, WorkitCore, type WorkerDispatch } from "@brainervirus/workit-core/src/core";
import {
  nativeDispatchFor,
  nativeWorkerFor,
  type DirectChildren,
  type DispatchGeneration,
} from "../tools/workit";
import { sameWorkspace } from "../shared/session";

/** V2 session facts the lifecycle binds to. `directory` is
 * `Session.Info.location.directory`; `outcome` is the terminal marker the host
 * records at `time.idle`. */
export type V2SessionInfo = {
  id: string;
  parentID?: string;
  directory?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
};

export type V2LifecycleDeps = {
  root: string;
  getSession: (sessionID: string) => Promise<V2SessionInfo | null>;
};

type V2ToolEvent = {
  tool: string;
  sessionID: string;
  id: string;
  input: unknown;
};

type V2ToolAfterEvent = V2ToolEvent &
  (
    | { status: "completed"; result: { output?: unknown; content?: unknown; metadata?: unknown } }
    | { status: "error"; error: unknown }
  );

type V2Event = {
  id?: string;
  type?: string;
  data?: unknown;
  location?: { directory?: unknown };
};

type PreparedDispatch = {
  generation: DispatchGeneration;
  dispatch: WorkerDispatch;
  core: WorkitCore;
  taskId: string;
  workerId: string;
  callID: string;
  childID: string | null;
};

export type V2Lifecycle = {
  directChildren: DirectChildren;
  executeBefore: (event: V2ToolEvent) => Promise<void>;
  executeAfter: (event: V2ToolAfterEvent) => Promise<void>;
  handleEvent: (event: V2Event) => Promise<void>;
  pendingLaunch: (coordinator: string) => boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Session handles are opaque: only non-empty strings are accepted, and every
 * binding is proven by session observation and persisted worker state. */
const sessionIDOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const parentOf = (session: V2SessionInfo | null): string | undefined =>
  typeof session?.parentID === "string" && session.parentID ? session.parentID : undefined;

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      record(part).type === "text" ? String((part as { text?: unknown }).text ?? "") : "",
    )
    .join("\n");
};

/**
 * V2 subagent lifecycle: direct-child lineage, one fresh launch per
 * coordinator, and durable dispatch claims settled only from host evidence.
 * The in-memory reservation correlates one `subagent` call with its observed
 * child; the durable `dispatching` claim lives in TaskStore and is settled by
 * `commitWorkerDispatch` from an observed session or a terminal read.
 */
export const createV2Lifecycle = (deps: V2LifecycleDeps): V2Lifecycle => {
  const { root } = deps;
  const directChildren: DirectChildren = new Map();
  const dispatches = new Map<string, PreparedDispatch>();
  // Synchronous single-fresh-launch slot: claimed before any awaited
  // validation so two concurrent managed calls cannot both reserve.
  const inflight = new Map<string, string>();
  const lifecycleBindings = new Map<
    string,
    { parentID: string; taskId: string; workerId: string }
  >();
  const unresolvedTaskLaunches = new Set<string>();
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const readSession = async (sessionID: string): Promise<V2SessionInfo | null> => {
    try {
      const info = await deps.getSession(sessionID);
      if (!info || typeof info !== "object" || info.id !== sessionID) return null;
      return info;
    } catch {
      return null;
    }
  };

  const trustedLead = async (coordinator: string): Promise<V2SessionInfo | null> => {
    const session = await readSession(coordinator);
    if (!session || parentOf(session) !== undefined) return null;
    if (!sameWorkspace(root, session.directory)) return null;
    return session;
  };

  const ownsActiveTask = (coordinator: string): boolean => {
    try {
      const store = new TaskStore(root);
      const workspace = store.readWorkspace();
      const listed = store.listTasks();
      if (!workspace.ok || !workspace.data || !listed.ok) return false;
      return listed.data.some(
        (task) =>
          task.status === "active" &&
          task.workspaceId === workspace.data?.id &&
          task.intent.provenance.session?.kind === "host" &&
          task.intent.provenance.session.host === "opencode" &&
          task.intent.provenance.session.handle === coordinator,
      );
    } catch {
      return false;
    }
  };

  const revisions = (taskId: string) => {
    const store = new TaskStore(root);
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    return task.ok && workspace.ok && workspace.data
      ? {
          expectedRevision: task.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
        }
      : null;
  };

  const oldestOfSingleTask = <
    T extends { id: string },
    E extends { id: string; recordedAt: string },
  >(
    items: { task: T; entry: E }[],
  ): { task: T; entry: E } | null => {
    const tasks = new Set(items.map((item) => item.task.id));
    if (tasks.size !== 1 || items.length === 0) return null;
    return [...items].sort((a, b) =>
      a.entry.recordedAt < b.entry.recordedAt
        ? -1
        : a.entry.recordedAt > b.entry.recordedAt
          ? 1
          : a.entry.id < b.entry.id
            ? -1
            : 1,
    )[0]!;
  };

  const prepareDispatch = (
    coordinator: string,
    callID: string,
  ): "prepared" | "unsettled" | "unbound" | "unmanaged" => {
    if (dispatches.has(coordinator)) return "unsettled";
    const store = new TaskStore(root);
    const workspace = store.readWorkspace();
    const listed = store.listTasks();
    if (!workspace.ok || !workspace.data || !listed.ok) return "unmanaged";
    const owned = listed.data.filter(
      (task) =>
        task.status === "active" &&
        task.workspaceId === workspace.data?.id &&
        task.intent.provenance.session?.kind === "host" &&
        task.intent.provenance.session.host === "opencode" &&
        task.intent.provenance.session.handle === coordinator,
    );
    if (owned.length === 0) return "unmanaged";
    const eligible = owned.flatMap((task) =>
      task.workers
        .filter(
          (entry) =>
            entry.data.state === "assigned" &&
            entry.data.session === null &&
            entry.provenance.session?.kind === "host" &&
            entry.provenance.session.host === "opencode" &&
            entry.provenance.session.handle === coordinator,
        )
        .map((entry) => ({ task, entry })),
    );
    const next = oldestOfSingleTask(eligible);
    if (!next) return "unbound";
    const generation: DispatchGeneration = {
      coordinator,
      callID,
      childCreated: false,
      noChild: false,
    };
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: coordinator },
      capabilities: [],
      constraints: [],
      now,
      nativeWorker: nativeDispatchFor(directChildren, coordinator, generation),
    });
    const prepared = core.prepareWorkerDispatch({
      taskId: next.task.id,
      workerId: next.entry.id,
      expectedRevision: next.task.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      observation: { stage: "prepare", sessionID: coordinator, callID },
    });
    if (!prepared.ok) return "unbound";
    dispatches.set(coordinator, {
      generation,
      dispatch: prepared.data,
      core,
      taskId: next.task.id,
      workerId: next.entry.id,
      callID,
      childID: null,
    });
    return "prepared";
  };

  const commitDispatchStart = (coordinator: string, childID: string): boolean => {
    const pending = dispatches.get(coordinator);
    if (!pending) return false;
    pending.generation.childCreated = true;
    pending.childID = childID;
    const current = revisions(pending.taskId);
    if (!current) return false;
    const committed = pending.core.commitWorkerDispatch({
      ...current,
      dispatch: pending.dispatch,
      taskId: pending.taskId,
      workerId: pending.workerId,
      outcome: "started",
      session: { kind: "host", host: "opencode", handle: childID },
      observation: { event: "running", sessionID: childID },
    });
    if (!committed.ok) return false;
    dispatches.delete(coordinator);
    if (inflight.get(coordinator) === pending.callID) inflight.delete(coordinator);
    lifecycleBindings.set(childID, {
      parentID: coordinator,
      taskId: pending.taskId,
      workerId: pending.workerId,
    });
    return true;
  };

  const observeLifecycle = async (
    sessionID: string,
    parentID: string,
    state: "running" | "stopped" | "unknown",
    binding?: { taskId: string; workerId: string },
    initial = false,
    deleted = false,
  ): Promise<void> => {
    const store = new TaskStore(root);
    const listed = store.listTasks();
    const workspace = store.readWorkspace();
    if (!listed.ok || !workspace.ok || !workspace.data) return;
    const persisted = listed.data.flatMap((task) =>
      task.status === "active"
        ? task.workers
            .filter(
              (entry) =>
                entry.id === binding?.workerId ||
                (entry.data.session?.kind === "host" && entry.data.session.handle === sessionID),
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    const matches = persisted.filter(({ entry }) => entry.data.session?.kind === "host");
    if (binding && !initial && matches.length !== 1) return;
    const selected = binding
      ? persisted.find(
          ({ task, entry }) => task.id === binding.taskId && entry.id === binding.workerId,
        )
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!selected) return;
    if (!initial && selected.entry.data.session?.kind !== "host") return;
    if (selected.entry.provenance.session?.kind !== "host") return;
    if (!binding) {
      const coordinator = selected.task.intent.provenance.session;
      if (coordinator?.kind !== "host" || coordinator.host !== "opencode") return;
      parentID = coordinator.handle;
    }
    if (!initial && !deleted) {
      const observed = await readSession(sessionID);
      if (!observed || !sameWorkspace(root, observed.directory) || parentOf(observed) !== parentID)
        return;
    }
    directChildren.set(sessionID, parentID);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: parentID },
      capabilities: [],
      constraints: [],
      now,
      nativeWorker: nativeWorkerFor(directChildren, parentID),
    });
    const result = core.observeWorkerLifecycle({
      taskId: selected.task.id,
      workerId: selected.entry.id,
      expectedRevision: selected.task.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      state,
      session: { kind: "host", host: "opencode", handle: sessionID },
      observation: { event: state, sessionID },
    });
    if (!result.ok) return;
    lifecycleBindings.set(sessionID, {
      parentID,
      taskId: selected.task.id,
      workerId: selected.entry.id,
    });
  };

  /** One bounded read of a pending launch's observed child; a terminal outcome
   * settles the durable claim so a missed `execute.after` cannot deadlock. */
  const reconcilePending = async (coordinator: string): Promise<void> => {
    const pending = dispatches.get(coordinator);
    if (!pending?.childID) return;
    const info = await readSession(pending.childID);
    if (!info || info.id !== pending.childID || !info.outcome) return;
    await observeLifecycle(pending.childID, coordinator, "stopped", {
      taskId: pending.taskId,
      workerId: pending.workerId,
    });
    dispatches.delete(coordinator);
    if (inflight.get(coordinator) === pending.callID) inflight.delete(coordinator);
  };

  const coordinatorVeto = (coordinator: string): string | null => {
    const listed = new TaskStore(root).listTasks();
    if (
      listed.ok &&
      listed.data.some((task) =>
        task.workers.some(
          (worker) =>
            (worker.data.state === "cancelling" || worker.data.state === "unknown") &&
            worker.provenance.session?.kind === "host" &&
            worker.provenance.session.handle === coordinator,
        ),
      )
    )
      return "recovery_required: a cancelled worker remains uncertain; repeat worker.cancel on the ended worker to confirm its stop, then retry";
    if (unresolvedTaskLaunches.delete(coordinator))
      return "recovery_required: a cancelled worker remains uncertain";
    return null;
  };

  const executeBefore = async (event: V2ToolEvent): Promise<void> => {
    if (event.tool !== "subagent") return;
    const coordinator = event.sessionID;
    const continuation = record(event.input).sessionID;
    if (continuation !== undefined) {
      // Continuation of an existing child: no worker assignment is prepared
      // or consumed, and the child must already be an exact direct child.
      const lead = await trustedLead(coordinator);
      if (!lead)
        throw new Error(
          "delegation_lineage_denied: native subagent workers must be direct children of the coordinator",
        );
      const childID = sessionIDOf(continuation);
      const child = childID ? await readSession(childID) : null;
      if (!child || parentOf(child) !== coordinator)
        throw new Error(
          "delegation_lineage_denied: a continuation sessionID must name an existing direct child of the coordinator",
        );
      return;
    }
    // Native subagent use outside Workit stays unmanaged: no slot, no veto,
    // only the direct-child lineage rule.
    if (!ownsActiveTask(coordinator)) {
      const lead = await trustedLead(coordinator);
      if (!lead)
        throw new Error(
          "delegation_lineage_denied: native subagent workers must be direct children of the coordinator",
        );
      return;
    }
    if (inflight.has(coordinator)) {
      await reconcilePending(coordinator);
      if (inflight.has(coordinator))
        throw new Error(
          "recovery_required: a previous fresh subagent launch is unsettled; wait for it to settle or reconcile its worker before launching again",
        );
    }
    inflight.set(coordinator, event.id);
    try {
      const veto = coordinatorVeto(coordinator);
      if (veto) throw new Error(veto);
      const lead = await trustedLead(coordinator);
      if (!lead)
        throw new Error(
          "delegation_lineage_denied: native subagent workers must be direct children of the coordinator",
        );
      const prepared = prepareDispatch(coordinator, event.id);
      if (prepared === "unmanaged") {
        inflight.delete(coordinator);
        return;
      }
      if (prepared === "unsettled") {
        throw new Error(
          "recovery_required: a previous native task launch is unsettled; wait for it to settle or reconcile its worker before launching again",
        );
      }
      if (prepared === "unbound") {
        throw new Error(
          "recovery_required: no assigned Workit worker is attributable to this coordinator; assign one with workit_worker before launching a native task",
        );
      }
    } catch (error) {
      if (inflight.get(coordinator) === event.id) inflight.delete(coordinator);
      throw error;
    }
  };

  const executeAfter = async (event: V2ToolAfterEvent): Promise<void> => {
    if (event.tool !== "subagent") return;
    const coordinator = event.sessionID;
    const pending = dispatches.get(coordinator);
    const generation = pending?.callID === event.id ? pending : undefined;
    if (event.status === "completed") {
      const metadata = record(event.result.metadata);
      const child = sessionIDOf(metadata.sessionID ?? metadata.sessionId);
      if (child) {
        const childSession = await readSession(child);
        if (parentOf(childSession) === coordinator) {
          directChildren.set(child, coordinator);
          if (generation) commitDispatchStart(coordinator, child);
        }
      }
      const output = contentText(event.result.content);
      const completedChild =
        child && /<subagent\b[^>]*\bstate="completed"/.test(output) && lifecycleBindings.has(child)
          ? child
          : null;
      if (completedChild) {
        const binding = lifecycleBindings.get(completedChild);
        if (binding) await observeLifecycle(completedChild, coordinator, "stopped", binding);
      }
    } else {
      const message = String(
        (event.error as { message?: unknown } | undefined)?.message ?? event.error ?? "",
      ).toLowerCase();
      // Only the host's own terminal proof settles a launch as not started;
      // V2 exposes none, so cancellation text stays conservatively unresolved.
      if (generation && /(?:cancel|interrupt|unknown|uncertain)/.test(message))
        unresolvedTaskLaunches.add(coordinator);
    }
    // The reservation lives for exactly one subagent call: the completed
    // result or its failure releases the coordinator's fresh-launch slot.
    if (generation) {
      dispatches.delete(coordinator);
      if (inflight.get(coordinator) === event.id) inflight.delete(coordinator);
    } else if (inflight.get(coordinator) === event.id) {
      inflight.delete(coordinator);
    }
  };

  const bindCreatedSession = async (data: {
    sessionID: string;
    parentID: string;
    directory: string;
  }): Promise<void> => {
    if (!sameWorkspace(root, data.directory)) return;
    const live = dispatches.get(data.parentID);
    if (live) {
      live.generation.childCreated = true;
      // Any validated child of this coordinator is a reconciliation target
      // even when it does not bind to the reserved worker.
      live.childID = data.sessionID;
    }
    const store = new TaskStore(root);
    const workspace = store.readWorkspace();
    const listed = store.listTasks();
    if (!workspace.ok || !workspace.data || !listed.ok) return;
    const candidates = listed.data.flatMap((task) =>
      task.status === "active" && task.workspaceId === workspace.data?.id
        ? task.workers
            .filter(
              (entry) =>
                (entry.data.state === "assigned" || entry.data.state === "dispatching") &&
                entry.data.session === null &&
                entry.provenance.session?.kind === "host" &&
                entry.provenance.session.host === "opencode" &&
                entry.provenance.session.handle === data.parentID,
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    const next = oldestOfSingleTask(candidates);
    if (!next) return;
    directChildren.set(data.sessionID, data.parentID);
    if (
      live &&
      live.taskId === next.task.id &&
      live.workerId === next.entry.id &&
      commitDispatchStart(data.parentID, data.sessionID)
    )
      return;
    await observeLifecycle(
      data.sessionID,
      data.parentID,
      "running",
      { taskId: next.task.id, workerId: next.entry.id },
      true,
    );
  };

  const handleEvent = async (event: V2Event): Promise<void> => {
    const type = event.type;
    if (typeof type !== "string") return;
    if (type === "session.created") {
      const data = record(event.data);
      const sessionID = sessionIDOf(data.sessionID);
      const parentID = sessionIDOf(data.parentID);
      const directory = record(data.location).directory;
      if (!sessionID || !parentID || typeof directory !== "string") return;
      await bindCreatedSession({ sessionID, parentID, directory });
      return;
    }
    const terminal =
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted";
    if (type !== "session.execution.started" && !terminal && type !== "session.deleted") return;
    const sessionID = sessionIDOf(record(event.data).sessionID);
    if (!sessionID) return;
    const binding = lifecycleBindings.get(sessionID);
    if (type === "session.deleted") {
      const directory = event.location?.directory;
      if (typeof directory === "string" && !sameWorkspace(root, directory)) return;
      // Sparse deletion carries no session facts; the persisted child binding
      // is the identity proof, and only deletion may skip a live read.
      await observeLifecycle(sessionID, binding?.parentID ?? "", "stopped", binding, false, true);
      return;
    }
    const state = type === "session.execution.started" ? "running" : "stopped";
    await observeLifecycle(sessionID, binding?.parentID ?? "", state, binding);
  };

  return {
    directChildren,
    executeBefore,
    executeAfter,
    handleEvent,
    pendingLaunch: (coordinator: string) => inflight.has(coordinator),
  };
};
