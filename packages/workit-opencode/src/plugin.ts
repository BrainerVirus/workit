import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { TaskStore, WorkitCore } from "@brainervirus/workit-core/src/core";
import { WORKIT_SKILL_ALIASES } from "@brainervirus/workit-core/src/core/skill-manifests";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import {
  EVENT,
  changedSourcesSinceLoad,
  errorDetail,
  markSourcesLoaded,
} from "@brainervirus/workit-core/src/core/boundary";
import { getWorkitBootstrap } from "./bootstrap";
import { createRepoTools } from "./tools/repo";
import {
  createWorkitTools,
  NativeReceiptStore,
  nativeDispatchFor,
  nativeWorkerFor,
  observeQuestion,
  observeQuestionEvent,
  sameWorkspace,
  sessionParent,
  type DirectChildren,
  type DispatchGeneration,
} from "./tools/workit";
import type { WorkerDispatch } from "@brainervirus/workit-core/src/core";
import { compactContextFor, loadProvenance, workerContextFor } from "./runtime";

const root = fileURLToPath(new URL("../assets/", import.meta.url));
const skillsPath = path.join(root, "skills");
const logger = createLogger({
  appLog: () => undefined,
});

// Long-lived sessions load workit sources once. Warn once (never block) when
// the checkout moves underneath the live process so stale behavior is visible
// instead of silently running old code after local fixes.
const sourceMarker = markSourcesLoaded(
  [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("./tools/workit.ts", import.meta.url)),
    ...[
      "task-contract.ts",
      "task-engine.ts",
      "task-evaluation.ts",
      "task-store.ts",
      "workers.ts",
      "authority.ts",
      "methods.ts",
    ].map((file) =>
      fileURLToPath(new URL(`../../../workit-core/src/core/${file}`, import.meta.url)),
    ),
  ].filter((file) => existsSync(file)),
);
let staleSourcesWarned = false;
const warnStaleSources = (): void => {
  if (staleSourcesWarned) return;
  const changed = changedSourcesSinceLoad(sourceMarker);
  if (changed.length === 0) return;
  staleSourcesWarned = true;
  try {
    logger.warn(EVENT.hooks, {
      boundary: "stale_sources",
      reason: "workit sources changed after plugin load; restart the session for latest behavior",
      files: changed.map((file) => path.basename(file)),
    });
  } catch {
    // Diagnostics must never break event delivery.
  }
};

type SessionClient = {
  session?: {
    get?: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo }>;
  };
};

type SessionInfo = { id?: string; parentID?: string; directory?: string };

const sessionData = async (client: SessionClient | undefined, sessionID: string) => {
  if (!client) return null;
  try {
    return (await client.session?.get?.({ path: { id: sessionID } }))?.data ?? {};
  } catch {
    return null;
  }
};

const trustedSession = (
  directory: string,
  sessionID: string,
  session: unknown,
): session is SessionInfo =>
  typeof session === "object" &&
  session !== null &&
  (session as SessionInfo).id === sessionID &&
  typeof (session as SessionInfo).directory === "string" &&
  sameWorkspace(directory, (session as SessionInfo).directory) &&
  sessionParent(session) !== null;

/** Dropped end-events strand workers, so every silent return here is logged. */
const droppedLifecycle = (sessionID: string, reason: string): void => {
  try {
    logger.warn(EVENT.hooks, { boundary: "worker_lifecycle", sessionID, reason });
  } catch {
    // Diagnostics must never break event delivery.
  }
};

/**
 * A session.deleted payload is the final host word on a session that is gone
 * by definition: the id must match, while directory and parentID are enforced
 * only when present. The persisted worker-session binding carries the rest.
 */
const deletedSessionEnd = (
  directory: string,
  sessionID: string,
  parentID: string,
  info: unknown,
): info is SessionInfo =>
  typeof info === "object" &&
  info !== null &&
  (info as SessionInfo).id === sessionID &&
  (typeof (info as SessionInfo).directory !== "string" ||
    sameWorkspace(directory, (info as SessionInfo).directory)) &&
    ((info as SessionInfo).parentID == null || (info as SessionInfo).parentID === parentID);

type PreparedDispatch = {
  generation: DispatchGeneration;
  dispatch: WorkerDispatch;
  core: WorkitCore;
  taskId: string;
  workerId: string;
};

/**
 * The only recognized proof that a native task call produced no child session.
 * A missing session id, a null session GET, or a cancellation string are all
 * silence, not evidence, and leave the worker unresolved.
 */
const provesNoChild = (metadata: unknown): boolean =>
  typeof metadata === "object" &&
  metadata !== null &&
  (metadata as { childCreated?: unknown }).childCreated === false &&
  (metadata as { sessionID?: unknown }).sessionID === undefined &&
  (metadata as { sessionId?: unknown }).sessionId === undefined;

const plugin: Plugin = async ({ client, directory }) => {
  const receipts = new NativeReceiptStore();
  const directChildren: DirectChildren = new Map();
  const lifecycleBindings = new Map<
    string,
    { parentID: string; taskId: string; workerId: string }
  >();
  // Fallback only for a task result that names no session. Once a trusted
  // session exists, lifecycle authority is persisted in core state.
  const unresolvedTaskLaunches = new Set<string>();
  const dispatches = new Map<string, PreparedDispatch>();
  const bootstrapped = new Set<string>();
  try {
    logger.info(EVENT.initialization, { host: "opencode", plugin_root: root });
    logger.info(
      EVENT.provenance,
      loadProvenance(logger, new URL("../package.json", import.meta.url)),
    );
  } catch (error) {
    logger.warn(EVENT.hooks, { boundary: "initialization", ...errorDetail(error) });
  }
  const tools = {
    ...createWorkitTools({ client, receipts, directChildren }),
    // Narrow registration: only the init surface the contract claims, not
    // the whole repo factory (commit/branch_setup stay unwired by design).
    workit_init_apply: createRepoTools().workit_init_apply,
  };
  const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const revisions = (taskId: string) => {
    const store = new TaskStore(directory);
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    return task.ok && workspace.ok && workspace.data
      ? {
          expectedRevision: task.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
        }
      : null;
  };
  /** Claim the launch slot of the one worker this coordinator can be launching. */
  // Queue rule (shared with bindCreatedSession): serial launches consume the
  // oldest unbound worker first, but only within a single task — cross-task
  // ambiguity stays unbound because no observed child can prove which task
  // the coordinator intends. Guessing across tasks would forge identity.
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
    )[0];
  };
  const prepareDispatch = (coordinator: string, callID: string) => {
    dispatches.delete(coordinator);
    const store = new TaskStore(directory);
    const workspace = store.readWorkspace();
    const listed = store.listTasks();
    if (!workspace.ok || !workspace.data || !listed.ok) return;
    const eligible = listed.data.flatMap((task) =>
      task.status === "active" && task.workspaceId === workspace.data?.id
        ? task.workers
            .filter(
              (entry) =>
                entry.data.state === "assigned" &&
                entry.data.session === null &&
                entry.provenance.session?.kind === "host" &&
                entry.provenance.session.host === "opencode" &&
                entry.provenance.session.handle === coordinator,
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    // Queue: the oldest unbound worker of a single task. Zero eligible, or
    // eligible workers spread across tasks, prepares nothing.
    const next = oldestOfSingleTask(eligible);
    if (!next) return;
    const generation: DispatchGeneration = {
      coordinator,
      callID,
      childCreated: false,
      noChild: false,
    };
    const core = new WorkitCore(store, {
      root: directory,
      caller: { host: "opencode", actor: coordinator },
      capabilities: [],
      constraints: [],
      now: timestamp,
      nativeWorker: nativeDispatchFor(directChildren, coordinator, generation),
    });
    const prepared = core.prepareWorkerDispatch({
      taskId: next.task.id,
      workerId: next.entry.id,
      expectedRevision: next.task.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      observation: { stage: "prepare", sessionID: coordinator, callID },
    });
    if (!prepared.ok) return;
    dispatches.set(coordinator, {
      generation,
      dispatch: prepared.data,
      core,
      taskId: next.task.id,
      workerId: next.entry.id,
    });
  };
  const commitDispatchStart = (coordinator: string, childID: string): boolean => {
    const pending = dispatches.get(coordinator);
    if (!pending) return false;
    pending.generation.childCreated = true;
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
    lifecycleBindings.set(childID, {
      parentID: coordinator,
      taskId: pending.taskId,
      workerId: pending.workerId,
    });
    return true;
  };
  const commitDispatchNotStarted = (coordinator: string, callID: string): boolean => {
    const pending = dispatches.get(coordinator);
    if (!pending || pending.generation.childCreated) return false;
    pending.generation.noChild = true;
    const current = revisions(pending.taskId);
    if (!current) return false;
    const committed = pending.core.commitWorkerDispatch({
      ...current,
      dispatch: pending.dispatch,
      taskId: pending.taskId,
      workerId: pending.workerId,
      outcome: "not_started",
      session: null,
      observation: { stage: "not_started", sessionID: coordinator, callID },
    });
    if (committed.ok) dispatches.delete(coordinator);
    return committed.ok;
  };
  const observeLifecycle = async (
    sessionID: string,
    parentID: string,
    state: "running" | "stopped" | "unknown",
    binding?: { taskId: string; workerId: string },
    initial = false,
    eventInfo?: SessionInfo,
  ) => {
    const store = new TaskStore(directory);
    const listed = store.listTasks();
    const workspace = store.readWorkspace();
    if (!listed.ok || !workspace.ok || !workspace.data) {
      droppedLifecycle(sessionID, "task store is unreadable during reconciliation");
      return;
    }
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
    // A bound child handle shared by several workers stays unresolved: moving
    // one of them would forge the other's lifecycle.
    if (binding && !initial && matches.length !== 1) {
      droppedLifecycle(sessionID, "bound child worker handle is ambiguous");
      return;
    }
    const selected = binding
      ? persisted.find(
          ({ task, entry }) => task.id === binding.taskId && entry.id === binding.workerId,
        )
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!selected) {
      droppedLifecycle(
        sessionID,
        binding ? "bound worker is missing from persisted state" : "worker session is ambiguous",
      );
      return;
    }
    if (!initial && selected.entry.data.session?.kind !== "host") {
      droppedLifecycle(sessionID, "selected worker has no bound host session");
      return;
    }
    if (selected.entry.provenance.session?.kind !== "host") {
      droppedLifecycle(sessionID, "selected worker provenance is not host-observed");
      return;
    }
    if (!binding) {
      // ponytail: running lifecycle overwrites worker provenance with the child
      // session; task intent is the persisted coordinator parent after restart.
      const coordinator = selected.task.intent.provenance.session;
      if (coordinator?.kind !== "host" || coordinator.host !== "opencode") {
        droppedLifecycle(sessionID, "coordinator session is not validated");
        return;
      }
      parentID = coordinator.handle;
    }
    if (!initial) {
      // OpenCode deletes the session before the follow-up GET can succeed;
      // only session.deleted may use its full, independently validated payload.
      // With a live launch binding, a sparse deleted payload (id only) still
      // ends the bound worker; without one, the full payload stays required.
      const observed = eventInfo ?? (await sessionData(client, sessionID));
      if (binding && eventInfo) {
        if (!deletedSessionEnd(directory, sessionID, parentID, observed)) {
          droppedLifecycle(sessionID, "deleted session payload contradicts the binding");
          return;
        }
      } else if (
        !trustedSession(directory, sessionID, observed) ||
        observed.parentID !== parentID
      ) {
        droppedLifecycle(sessionID, "live session observation is not trusted");
        return;
      }
    }
    directChildren.set(sessionID, parentID);
    const core = new WorkitCore(store, {
      root: directory,
      caller: { host: "opencode", actor: parentID },
      capabilities: [],
      constraints: [],
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
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
    if (!result.ok) {
      droppedLifecycle(sessionID, `worker observation was rejected: ${result.code}`);
      return;
    }
    lifecycleBindings.set(sessionID, {
      parentID,
      taskId: selected.task.id,
      workerId: selected.entry.id,
    });
  };
  const bindCreatedSession = async (info: SessionInfo) => {
    if (
      typeof info.id !== "string" ||
      typeof info.parentID !== "string" ||
      !sameWorkspace(directory, info.directory)
    )
      return;
    // Any validated child of this coordinator ends the current generation's claim
    // that no child exists, even when the session binds to no assigned worker.
    const live = dispatches.get(info.parentID);
    if (live) live.generation.childCreated = true;
    const store = new TaskStore(directory);
    const workspace = store.readWorkspace();
    const listed = store.listTasks();
    if (!workspace.ok || !workspace.data || !listed.ok) return;
    const candidates = listed.data.flatMap((task) =>
      task.status === "active" && task.workspaceId === workspace.data?.id
        ? task.workers
            .filter(
              (entry) =>
                entry.data.state === "assigned" &&
                entry.data.session === null &&
                entry.provenance.session?.kind === "host" &&
                entry.provenance.session.host === "opencode" &&
                entry.provenance.session.handle === info.parentID,
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    // Same queue rule as prepareDispatch: oldest unbound worker of a single
    // task; cross-task ambiguity binds nothing.
    const next = oldestOfSingleTask(candidates);
    if (!next) return;
    directChildren.set(info.id, info.parentID);
    if (
      live &&
      live.taskId === next.task.id &&
      live.workerId === next.entry.id &&
      commitDispatchStart(info.parentID, info.id)
    )
      return;
    await observeLifecycle(
      info.id,
      info.parentID,
      "running",
      {
        taskId: next.task.id,
        workerId: next.entry.id,
      },
      true,
    );
  };
  return {
    tool: tools,
    event: async ({ event }) => {
      // Question events ride the runtime bus but predate the plugin SDK's
      // Event union, so match on a widened type. Unrecognized shapes are
      // ignored inside observeQuestionEvent; delivery never breaks.
      const busEvent = event as unknown as { type: string; properties?: unknown };
      if (
        busEvent.type === "question.asked" ||
        busEvent.type === "question.replied" ||
        busEvent.type === "question.rejected"
      ) {
        observeQuestionEvent(receipts, busEvent);
        return;
      }
      if (event.type === "session.created") {
        await bindCreatedSession(event.properties.info);
        return;
      }
      if (
        event.type !== "session.status" &&
        event.type !== "session.idle" &&
        event.type !== "session.error" &&
        event.type !== "session.deleted"
      )
        return;
      const properties = event.properties as {
        sessionID?: unknown;
        info?: { id?: unknown };
      };
      const sessionID =
        typeof properties.sessionID === "string"
          ? properties.sessionID
          : typeof properties.info?.id === "string"
            ? properties.info.id
            : undefined;
      if (typeof sessionID !== "string") return;
      const binding = lifecycleBindings.get(sessionID);
      const state =
        event.type === "session.status"
          ? event.properties.status.type === "busy"
            ? "running"
            : event.properties.status.type === "idle"
              ? "stopped"
              : "unknown"
          : event.type === "session.idle"
            ? "stopped"
            : event.type === "session.deleted"
              ? "stopped"
              : "unknown";
      await observeLifecycle(
        sessionID,
        binding?.parentID ?? "",
        state,
        binding,
        false,
        event.type === "session.deleted" ? (properties.info as SessionInfo | undefined) : undefined,
      );
    },
    "tool.execute.after": async (input, output) => {
      observeQuestion(receipts, input, output);
      if (input.tool === "task") {
        const metadata = output.metadata as
          | {
              sessionID?: unknown;
              sessionId?: unknown;
              parentSessionId?: unknown;
              status?: unknown;
              state?: unknown;
            }
          | undefined;
        const pending = dispatches.get(input.sessionID);
        const generation =
          pending?.generation.callID === input.callID ? pending.generation : undefined;
        const child = metadata?.sessionID ?? metadata?.sessionId;
        if (typeof child === "string") {
          const childSession = await sessionData(client, child);
          if (childSession?.parentID === input.sessionID) {
            directChildren.set(child, input.sessionID);
            if (generation) commitDispatchStart(input.sessionID, child);
          }
        }
        const resolved =
          generation !== undefined &&
          !generation.childCreated &&
          provesNoChild(metadata) &&
          commitDispatchNotStarted(input.sessionID, input.callID);
        // The reservation lives for exactly one task call; anything unsettled stays unresolved.
        if (generation) dispatches.delete(input.sessionID);
        // The host's own task result attests the run ended: a completed child
        // stops its bound worker now instead of waiting for an end event that
        // background sessions may never emit. Anything else keeps the
        // conservative path below.
        const outputText = typeof output.output === "string" ? output.output : "";
        const completedChild =
          typeof child === "string" &&
          metadata?.parentSessionId === input.sessionID &&
          /<task\b[^>]*\bstate="completed"/.test(outputText)
            ? child
            : null;
        const state = String(
          metadata?.status ?? metadata?.state ?? output.output ?? "",
        ).toLowerCase();
        if (completedChild) {
          const completionBinding = lifecycleBindings.get(completedChild);
          if (completionBinding)
            await observeLifecycle(
              completedChild,
              input.sessionID,
              "stopped",
              completionBinding,
              false,
              undefined,
            );
        } else if (!resolved && /(?:cancel|interrupt|unknown|uncertain)/.test(state))
          unresolvedTaskLaunches.add(input.sessionID);
      }
    },
    "tool.execute.before": async (input, _output) => {
      warnStaleSources();
      if (input.tool === "task") {
        const listed = new TaskStore(directory).listTasks();
        // Scoped veto: only workers attributable to the launching coordinator
        // block its launch. An uncertain worker elsewhere is that
        // coordinator's problem, not a global stop-the-world switch — the
        // slot claim below can only ever bind this coordinator's observed
        // child, so cross-coordinator forgery stays impossible.
        if (
          listed.ok &&
          listed.data.some((task) =>
            task.workers.some(
              (worker) =>
                (worker.data.state === "cancelling" || worker.data.state === "unknown") &&
                worker.provenance.session?.kind === "host" &&
                worker.provenance.session.handle === input.sessionID,
            ),
          )
        )
          throw new Error(
            "recovery_required: a cancelled worker remains uncertain; repeat worker.cancel on the ended worker to confirm its stop, then retry",
          );
        if (unresolvedTaskLaunches.delete(input.sessionID))
          throw new Error("recovery_required: a cancelled worker remains uncertain");
        const session = await sessionData(client, input.sessionID);
        if (!client || !trustedSession(directory, input.sessionID, session) || session.parentID)
          throw new Error(
            "delegation_lineage_denied: native task workers must be direct children of the coordinator",
          );
        prepareDispatch(input.sessionID, input.callID);
      }
    },
    config: async (config) => {
      const mutable = config as typeof config & {
        skills?: { paths?: string[] };
        permission?: unknown;
        agent?: Record<string, { permission?: unknown }>;
      };
      const paths = [...(mutable.skills?.paths ?? [])];
      if (existsSync(skillsPath) && !paths.includes(skillsPath)) paths.push(skillsPath);
      mutable.skills ??= {};
      mutable.skills.paths = paths;
      // Bare slash aliases: user-invoked entry points that load the method
      // skill through the skill tool and apply it. Never overwritten when
      // the user defined their own command of the same name.
      const commands: Record<string, unknown> = {
        ...(mutable as { command?: Record<string, unknown> }).command,
      };
      for (const [alias, skill] of Object.entries(WORKIT_SKILL_ALIASES))
        commands[alias] ??= {
          description: `Apply the ${skill} method skill to the current task.`,
          template: `Load the ${skill} skill with the skill tool and apply it to the current task. Arguments: $ARGUMENTS`,
        };
      (mutable as { command?: Record<string, unknown> }).command = commands;
      const permission = mutable.permission;
      const current: Record<string, any> =
        typeof permission === "string"
          ? { "*": permission }
          : typeof permission === "object" && permission !== null
            ? { ...(permission as Record<string, unknown>) }
            : {};
      const bash: Record<string, any> =
        typeof current.bash === "string"
          ? { "*": current.bash }
          : typeof current.bash === "object" && current.bash !== null
            ? { ...(current.bash as Record<string, unknown>) }
            : {};
      bash["*git *worktree*"] = "deny";
      current.bash = bash;
      mutable.permission = current;
      for (const agent of Object.values(mutable.agent ?? {})) {
        if (!agent) continue;
        const agentPermission = agent.permission;
        const agentConfig: Record<string, any> =
          typeof agentPermission === "string"
            ? { "*": agentPermission }
            : typeof agentPermission === "object" && agentPermission !== null
              ? { ...(agentPermission as Record<string, unknown>) }
              : {};
        const agentBash: Record<string, any> =
          typeof agentConfig.bash === "string"
            ? { "*": agentConfig.bash }
            : typeof agentConfig.bash === "object" && agentConfig.bash !== null
              ? { ...(agentConfig.bash as Record<string, unknown>) }
              : {};
        agentBash["*git *worktree*"] = "deny";
        agentConfig.bash = agentBash;
        agent.permission = agentConfig;
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = compactContextFor(directory, sessionID);
      if (context) {
        if (output.context.some((entry) => entry.includes("<workit-task-context>"))) return;
        output.context.push(`<workit-task-context>${context}</workit-task-context>`);
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const first = output.messages.find((message) => message.info.role === "user");
      if (!first || !first.parts.length) return;
      const sessionID = first.info.sessionID;
      if (bootstrapped.has(sessionID)) return;
      const anchor = first.parts[0];
      const session = await sessionData(client, sessionID);
      if (!trustedSession(directory, sessionID, session)) return;
      const workerContext = session?.parentID
        ? workerContextFor(directory, sessionID, session.parentID, directChildren)
        : null;
      const bootstrap = session && !session.parentID ? getWorkitBootstrap() : null;
      const context = compactContextFor(directory, sessionID);
      if (
        bootstrap &&
        !first.parts.some((part) => part.type === "text" && part.text.includes("<workit-contract>"))
      ) {
        first.parts.unshift({ ...anchor, type: "text", text: bootstrap } as never);
      }
      if (
        context &&
        !first.parts.some(
          (part) => part.type === "text" && part.text.includes("<workit-task-context>"),
        )
      ) {
        first.parts.unshift({
          ...anchor,
          type: "text",
          text: `<workit-task-context>${context}</workit-task-context>`,
        } as never);
      }
      if (
        workerContext &&
        !first.parts.some(
          (part) => part.type === "text" && part.text.includes("<workit-worker-context>"),
        )
      ) {
        first.parts.unshift({
          ...anchor,
          type: "text",
          text: `<workit-worker-context>${workerContext}</workit-worker-context>`,
        } as never);
      }
      bootstrapped.add(sessionID);
    },
  };
};

export default plugin;
