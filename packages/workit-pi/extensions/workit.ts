import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  TaskStore,
  WorkitCore,
  failure,
  success,
  type OperationContext,
  type ContractResult as Result,
  type Entry,
  type TaskRecord,
  type WorkspaceRecord,
  type Worker,
} from "@brainervirus/workit-core/src/core";
import {
  changedTurnContext,
  PI_DESCRIPTOR,
  seedTurnContext,
  stopDecision,
} from "@brainervirus/workit-core/hooks";
import {
  piContext,
  turnContext,
  turnInput,
  unfinishedTaskOffer,
  workitContext,
} from "../src/context";
import { WORKIT_SKILL_ALIASES } from "@brainervirus/workit-core/src/core/skill-manifests";
import {
  enforceToolPolicy,
  observeToolResult,
  registerWorkitTools,
  skillPromptNudge,
} from "../src/tools";
import { abandonedLaunches, cancelHint, clearLaunch, recordLaunch } from "../src/launches";
import {
  cancelWorker,
  cancelWorkerAssignment,
  advanceWorkerBinding,
  launchSupervisedWorker,
  nativeLostWorker,
  nativeWorkerForEvidence,
  observeWorkerExit,
  reconcileWorker,
  reportWorker,
  workerCanLaunchNested,
  type ObservedExit,
  type WorkerHandle,
  type WorkerLifecycleBinding,
} from "../src/worker";

type ControlRequest = {
  action: "launch" | "cancel" | "reconcile";
  taskId: string;
  workerId: string;
  prompt?: string;
};
type ValidAssignment = {
  store: TaskStore;
  task: TaskRecord;
  workspace: WorkspaceRecord;
  worker: Entry<Worker>;
};

const output = (result: Result<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
});
const controlParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["launch", "cancel", "reconcile"] },
    taskId: { type: "string" },
    workerId: { type: "string" },
    prompt: { type: "string" },
  },
  required: ["action", "taskId", "workerId"],
} as const;

const readAssignment = (
  ctx: ExtensionContext,
  request: ControlRequest,
): Result<ValidAssignment> => {
  const store = new TaskStore(ctx.cwd);
  const task = store.readTask(request.taskId);
  if (!task.ok) return task;
  const workspace = store.readWorkspace();
  if (!workspace.ok) return workspace;
  if (!workspace.data || task.data.workspaceId !== workspace.data.id)
    return failure("permission_denied", "worker assignment is not bound to this workspace");
  if (task.data.status !== "active")
    return failure("invalid_transition", "paused or closed tasks cannot supervise workers");
  const worker = task.data.workers.find((candidate) => candidate.id === request.workerId);
  if (!worker) return failure("not_found", "worker assignment not found");
  return success(null, workspace.data.revision, {
    store,
    task: task.data,
    workspace: workspace.data,
    worker,
  });
};

const runtimeFor = (ctx: ExtensionContext) => ({
  node: process.execPath,
  cli: process.argv[1] ?? "",
  workitExtension: fileURLToPath(import.meta.url),
  root: ctx.cwd,
});

const contextMessage = (ctx: ExtensionContext, content: string) => ({
  customType: "workit-context",
  content,
  display: false,
  details: { session: piContext(ctx).caller.actor },
});

/**
 * Persist an unobservable cancel as worker-state unknown, attested by the
 * live handle's own process evidence. Mirrors the launch path's
 * persistUncertain contract: true means the uncertainty itself is recorded,
 * false means even the record failed and the caller must say so distinctly.
 */
export const persistUncertainCancel = (
  store: TaskStore,
  ctx: ExtensionContext,
  taskId: string,
  workerId: string,
  handle: WorkerHandle,
  exit: ObservedExit,
): boolean => {
  const freshTask = store.readTask(taskId);
  const freshWorkspace = store.readWorkspace();
  if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data) return false;
  const lostBinding: WorkerLifecycleBinding = {
    core: new WorkitCore(store, {
      ...piContext(ctx),
      nativeWorker: nativeWorkerForEvidence(() => handle),
    }),
    taskId,
    workerId,
    expectedRevision: freshTask.data.revision,
    expectedWorkspaceRevision: freshWorkspace.data.revision,
    sessionId: handle.sessionId,
  };
  return observeWorkerExit(lostBinding, handle, exit).ok;
};

/**
 * The text of the last assistant message of a run (agent_end `messages`), or
 * null. A run the user aborted (Esc) or that ended in an error reads as null:
 * its stop is never overridden.
 */
export const lastAssistantText = (messages: readonly unknown[] | undefined): string | null => {
  for (const message of (messages ?? []).toReversed()) {
    if (typeof message !== "object" || message === null) continue;
    const { role, content, stopReason } = message as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
    };
    if (role !== "assistant") continue;
    if (stopReason === "aborted" || stopReason === "error") return null;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    return text || null;
  }
  return null;
};

export default function extension(pi: ExtensionAPI): void {
  const sessions = new Set<string>();
  const historyOfferSessions = new Set<string>();
  /** Sessions whose current run was started by a stop continuation. */
  const continuedRuns = new Set<string>();
  const workers = new Map<string, WorkerHandle>();
  const bindings = new Map<string, WorkerLifecycleBinding>();
  const childWorker = process.env.WORKIT_PI_WORKER_ID;
  registerWorkitTools(pi, { allowContext: !childWorker });

  const reconcileLostWorkers = (ctx: ExtensionContext): void => {
    if (!ctx.isProjectTrusted() || process.env.WORKIT_PI_WORKER_ID) return;
    const store = new TaskStore(ctx.cwd);
    const tasks = store.listTasks();
    if (!tasks.ok) return;
    for (const task of tasks.data) {
      if (task.status !== "active") continue;
      for (const entry of task.workers) {
        if (
          (entry.data.state !== "running" && entry.data.state !== "cancelling") ||
          entry.data.session?.kind !== "host" ||
          entry.data.session.host !== "pi" ||
          [...workers.values()].some((handle) => handle.workerId === entry.id)
        )
          continue;
        const freshTask = store.readTask(task.id);
        const workspace = store.readWorkspace();
        if (!freshTask.ok || !workspace.ok || !workspace.data) continue;
        const freshEntry = freshTask.data.workers.find((candidate) => candidate.id === entry.id);
        if (
          !freshEntry ||
          freshEntry.data.state === "stopped" ||
          freshEntry.data.state === "unknown"
        )
          continue;
        const session = freshEntry.data.session;
        if (!session || session.kind !== "host" || session.host !== "pi") continue;
        const core = new WorkitCore(store, { ...piContext(ctx), nativeWorker: nativeLostWorker() });
        core.observeWorkerLifecycle({
          taskId: task.id,
          workerId: entry.id,
          expectedRevision: freshTask.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
          state: "unknown",
          session,
          observation: { lost: true, sessionId: session.handle },
        });
      }
    }
    // A launch whose launcher died before observing the child: the worker may
    // or may not be running, so it turns `unknown` and is never relaunched
    // until the lead cancels it.
    for (const attempt of abandonedLaunches(ctx.cwd)) {
      const freshTask = store.readTask(attempt.taskId);
      const workspace = store.readWorkspace();
      if (!freshTask.ok || !workspace.ok || !workspace.data) continue;
      const entry = freshTask.data.workers.find((candidate) => candidate.id === attempt.workerId);
      if (entry?.data.state !== "assigned") {
        clearLaunch(ctx.cwd, attempt.workerId);
        continue;
      }
      const session = { kind: "host" as const, host: "pi" as const, handle: attempt.session };
      const core = new WorkitCore(store, { ...piContext(ctx), nativeWorker: nativeLostWorker() });
      const marked = core.observeWorkerLifecycle({
        taskId: attempt.taskId,
        workerId: attempt.workerId,
        expectedRevision: freshTask.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        state: "unknown",
        session,
        observation: { lost: true, sessionId: attempt.session },
      });
      if (marked.ok) clearLaunch(ctx.cwd, attempt.workerId);
    }
  };

  const persistUncertain = (
    store: TaskStore,
    binding: WorkerLifecycleBinding,
    handle: WorkerHandle,
    exit: ObservedExit,
  ): boolean => {
    if (handle.exit?.observed) return true;
    const freshTask = store.readTask(binding.taskId);
    const freshWorkspace = store.readWorkspace();
    if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data) return false;
    binding.expectedRevision = freshTask.data.revision;
    binding.expectedWorkspaceRevision = freshWorkspace.data.revision;
    const observed = observeWorkerExit(binding, handle, exit);
    advanceWorkerBinding(binding, observed);
    return observed.ok;
  };

  const control = async (
    request: ControlRequest,
    ctx: ExtensionContext,
  ): Promise<Result<unknown>> => {
    if (!ctx.isProjectTrusted()) return failure("permission_denied", "Pi project is not trusted");
    const validated = readAssignment(ctx, request);
    if (!validated.ok) return validated;
    const { store, task, workspace, worker } = validated.data;
    const current = [...workers.values()].find((handle) => handle.workerId === request.workerId);
    if (request.action === "cancel") {
      if (!current)
        return failure("recovery_required", "worker process is not live in this session");
      const parent = new WorkitCore(store, piContext(ctx));
      const binding = bindings.get(worker.id);
      const latestTask = store.readTask(task.id);
      const latestWorkspace = store.readWorkspace();
      if (!latestTask.ok || !latestWorkspace.ok || !latestWorkspace.data)
        return failure("recovery_required", "worker state could not be refreshed");
      if (binding) {
        binding.expectedRevision = latestTask.data.revision;
        binding.expectedWorkspaceRevision = latestWorkspace.data.revision;
      }
      const cancelled = cancelWorkerAssignment(
        parent,
        task.id,
        worker.id,
        latestTask.data.revision,
        latestWorkspace.data.revision,
      );
      if (!cancelled.ok) return cancelled;
      if (binding) {
        binding.expectedRevision = cancelled.revision ?? binding.expectedRevision;
        binding.expectedWorkspaceRevision =
          cancelled.workspaceRevision ?? binding.expectedWorkspaceRevision;
      }
      const result = await cancelWorker(current, binding ? { binding } : {});
      if (!result.observed) {
        // Same two-tier signal as the launch path: the exit is uncertain, and
        // persisting that uncertainty can fail independently.
        if (!persistUncertainCancel(store, ctx, task.id, worker.id, current, result))
          return failure("recovery_required", "worker uncertainty could not be persisted");
        return failure("recovery_required", "worker termination is uncertain");
      }
      return success(cancelled.revision, cancelled.workspaceRevision, {
        workerId: worker.id,
        exit: result,
      });
    }
    // Reconcile runs against the live handle when this session still tracks
    // it; a process from another session stays recovery_required because its
    // exit was never observed here.
    if (request.action === "reconcile") {
      if (!current)
        return failure("recovery_required", "worker process is not live in this session");
      return reconcileWorker(current);
    }
    if (worker.data.state === "unknown")
      return failure(
        "recovery_required",
        `worker ${worker.id} has an unobserved launch; ${cancelHint(worker.id)}`,
      );
    if (worker.data.state !== "assigned")
      return failure("invalid_transition", "only an assigned worker can be launched");
    if (!request.prompt) return failure("invalid_input", "launch requires a prompt");

    let child: WorkerHandle | null = null;
    let launchClaimed = false;
    const binding: WorkerLifecycleBinding = {
      core: new WorkitCore(store, {
        ...piContext(ctx),
        nativeWorker: nativeWorkerForEvidence(() => child),
      }),
      taskId: task.id,
      workerId: worker.id,
      expectedRevision: task.revision,
      expectedWorkspaceRevision: workspace.revision,
      // Unique per launch: a second launcher's observation can never pass as
      // the first one's session.
      sessionId: `pi-worker-${worker.id}-${randomUUID().slice(0, 8)}`,
    };
    const childContext: OperationContext = {
      ...piContext(ctx),
      caller: { host: "pi", actor: binding.sessionId },
      callerAttested: true,
      workerId: worker.id,
      nativeWorker: nativeWorkerForEvidence(() => child),
    };
    const childCore = new WorkitCore(store, childContext);
    let resolveReady: ((ready: boolean) => void) | undefined;
    const readyPromise = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const handle = launchSupervisedWorker(worker.data.assignment, {
      runtime: runtimeFor(ctx),
      binding,
      prompt: request.prompt,
      onPrepare: (pending) => {
        child = pending;
        launchClaimed = recordLaunch(ctx.cwd, {
          taskId: task.id,
          workerId: worker.id,
          session: binding.sessionId,
        });
        return launchClaimed;
      },
      onSpawn: (spawned) => {
        child = spawned;
        return true;
      },
      onReady: (ready) => {
        resolveReady?.(ready.ready);
      },
      onError: () => resolveReady?.(false),
      onReport: (_reported, report) => {
        const freshTask = store.readTask(task.id);
        const freshWorkspace = store.readWorkspace();
        if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data) return false;
        const existing = freshTask.data.workers.find((entry) => entry.id === worker.id)?.data
          .report;
        if (existing) return true;
        const persisted = reportWorker(
          childCore,
          task.id,
          worker.id,
          report,
          freshTask.data.revision,
          freshWorkspace.data.revision,
        );
        if (!persisted.ok && persisted.code === "revision_conflict") {
          const racedTask = store.readTask(task.id);
          const racedWorker = racedTask.ok
            ? racedTask.data.workers.find((entry) => entry.id === worker.id)
            : undefined;
          if (racedWorker?.data.report) return true;
        }
        return advanceWorkerBinding(binding, persisted);
      },
      beforeExit: () => {
        const freshTask = store.readTask(task.id);
        const freshWorkspace = store.readWorkspace();
        if (freshTask.ok && freshWorkspace.ok && freshWorkspace.data) {
          binding.expectedRevision = freshTask.data.revision;
          binding.expectedWorkspaceRevision = freshWorkspace.data.revision;
        }
      },
      onExit: (exited) => {
        resolveReady?.(exited.ready);
        workers.delete(exited.id);
        bindings.delete(worker.id);
      },
    });
    child = handle;
    if (!launchClaimed)
      return failure(
        "recovery_required",
        `another launch of worker ${worker.id} is in progress or was lost; if no Pi session is launching it, ${cancelHint(worker.id)}`,
      );
    if (handle.state !== "running") {
      // No spawn attempt means no child can exist: the claim is released.
      if (!handle.spawned) clearLaunch(ctx.cwd, worker.id);
      return failure("recovery_required", "worker launch was not observed");
    }
    clearLaunch(ctx.cwd, worker.id);
    const ready = await Promise.race([
      readyPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!ready) {
      if (handle.state === "running") {
        const terminated = await cancelWorker(handle, { graceMs: 50, killWaitMs: 50, binding });
        if (!terminated.observed && !persistUncertain(store, binding, handle, terminated))
          return failure("recovery_required", "worker uncertainty could not be persisted");
      }
      return failure("recovery_required", "worker readiness was not observed");
    }
    workers.set(handle.id, handle);
    bindings.set(worker.id, binding);
    return success(binding.expectedRevision, binding.expectedWorkspaceRevision, {
      workerId: worker.id,
      sessionId: binding.sessionId,
      pid: handle.pid,
      state: handle.state,
    });
  };

  if (workerCanLaunchNested()) {
    pi.registerTool({
      name: "workit_worker_control",
      label: "workit_worker_control",
      description:
        "Supervise an already-assigned native Pi worker; host orchestration, not a core family tool.",
      promptSnippet: "Supervise a pre-assigned Workit Pi worker.",
      parameters: controlParameters as never,
      async execute(_id, input, _signal, _update, ctx) {
        return output(await control(input as ControlRequest, ctx));
      },
    } as ToolDefinition);
    if (typeof pi.registerCommand === "function")
      pi.registerCommand("workit-worker", {
        description: "Supervise an already-assigned native Pi worker.",
        handler: async (args, ctx) => {
          try {
            const result = await control(JSON.parse(args) as ControlRequest, ctx);
            pi.appendEntry("workit-worker", result);
          } catch {
            pi.appendEntry("workit-worker", { error: "invalid worker control request" });
          }
        },
      });
  }

  // Bare slash aliases: route through the bundled skill commands so the
  // model applies the method skill. An alias never calls another alias.
  if (
    typeof pi.registerCommand === "function" &&
    typeof (pi as { sendUserMessage?: unknown }).sendUserMessage === "function"
  )
    for (const [alias, skill] of Object.entries(WORKIT_SKILL_ALIASES))
      pi.registerCommand(alias, {
        description: `Apply the ${skill} method skill to the current task.`,
        handler: async (args) => {
          const extra = String(args ?? "").trim();
          (
            pi as unknown as { sendUserMessage: (content: string, options: unknown) => void }
          ).sendUserMessage(`/skill:${skill}${extra ? ` ${extra}` : ""}`, {
            expandPromptTemplates: true,
          });
        },
      });

  pi.on("session_start", (_event, ctx) => {
    if (childWorker)
      process.stdout.write(
        JSON.stringify({
          type: "workit_worker_ready",
          workerId: childWorker,
          sessionId: ctx.sessionManager.getSessionId(),
        }) + "\n",
      );
    sessions.delete(ctx.sessionManager.getSessionId());
    reconcileLostWorkers(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    const nudge = skillPromptNudge(event.prompt, ctx);
    const id = ctx.sessionManager.getSessionId();
    const trusted = ctx.isProjectTrusted();
    const task = turnContext(ctx);
    let content: string | null;
    if (sessions.has(id)) {
      // The session keeps each injected message: resend only on change.
      content = trusted ? changedTurnContext(turnInput(ctx), task) : null;
    } else {
      sessions.add(id);
      const offer = historyOfferSessions.has(id) ? null : unfinishedTaskOffer(ctx);
      historyOfferSessions.add(id);
      // The contract carries the task context: seed the digest so the next
      // turn does not resend it.
      if (trusted) seedTurnContext(turnInput(ctx), PI_DESCRIPTOR, task);
      content = `${workitContext(ctx, task)}${offer ? `\n\n${offer}` : ""}`;
    }
    if (content)
      return { message: contextMessage(ctx, nudge ? `${content}\n\n${nudge}` : content) };
    return nudge
      ? { message: { customType: "workit-skill", content: nudge, display: false } }
      : undefined;
  });
  // Stop control: a run that ends with a provable unmet obligation gets one
  // more turn naming it. Pi has no loop guard, so the run that continuation
  // starts always ends freely. Never in a worker or an untrusted project.
  pi.on("agent_end", (event, ctx) => {
    try {
      const id = ctx.sessionManager.getSessionId();
      if (continuedRuns.delete(id) || childWorker || !ctx.isProjectTrusted()) return;
      const send = (pi as { sendMessage?: unknown }).sendMessage;
      if (typeof send !== "function") return;
      const decision = stopDecision(
        {
          ...turnInput(ctx),
          event: {
            kind: "stop",
            lastMessage: lastAssistantText(event.messages),
            stopHookActive: false,
          },
        },
        PI_DESCRIPTOR,
      );
      if (decision.kind !== "continue") return;
      continuedRuns.add(id);
      send.call(
        pi,
        { customType: "workit-stop", content: decision.reason, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Fail open: the run stops.
    }
  });
  pi.on("session_before_compact", () => undefined);
  pi.on("session_compact", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("session_compact_failed", () => undefined);
  pi.on("tool_call", (event: ToolCallEvent, ctx) => enforceToolPolicy(event, ctx));
  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    if (childWorker && event.toolName === "workit_worker") {
      const details = event.details;
      const report =
        typeof details === "object" &&
        details !== null &&
        "data" in details &&
        typeof (details as { data?: unknown }).data === "object" &&
        (details as { data: { data?: { report?: unknown } } }).data.data?.report;
      if (report)
        process.stdout.write(
          JSON.stringify({
            type: "workit_worker_result",
            workerId: childWorker,
            sessionId: ctx.sessionManager.getSessionId(),
            report,
          }) + "\n",
        );
    }
    if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash")
      return;
    pi.appendEntry("workit-native-observation", {
      session: ctx.sessionManager.getSessionId(),
      tool: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
    });
    return observeToolResult(event, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
}
