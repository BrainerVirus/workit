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
import { piContext, workitContext } from "../src/context";
import { enforceNativeWriter, registerWorkitTools } from "../src/tools";
import {
  cancelWorker,
  cancelWorkerAssignment,
  advanceWorkerBinding,
  launchSupervisedWorker,
  nativeLostWorker,
  nativeWorkerForEvidence,
  observeWorkerExit,
  reportWorker,
  workerCanLaunchNested,
  type WorkerHandle,
  type WorkerAssignment,
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
  if (!task.ok) return task as Result<never>;
  const workspace = store.readWorkspace();
  if (!workspace.ok) return workspace as Result<never>;
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

const contextMessage = (ctx: ExtensionContext) => ({
  customType: "workit-context",
  content: workitContext(ctx),
  display: false,
  details: { session: piContext(ctx).caller.actor },
});

export default function extension(pi: ExtensionAPI): void {
  const sessions = new Set<string>();
  const workers = new Map<string, WorkerHandle>();
  const bindings = new Map<string, WorkerLifecycleBinding>();
  registerWorkitTools(pi);

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
      const cancelled = cancelWorkerAssignment(
        parent,
        task.id,
        worker.id,
        binding?.expectedRevision ?? task.revision,
        binding?.expectedWorkspaceRevision ?? workspace.revision,
      );
      if (!cancelled.ok) return cancelled;
      if (binding) {
        binding.expectedRevision = cancelled.revision ?? binding.expectedRevision;
        binding.expectedWorkspaceRevision =
          cancelled.workspaceRevision ?? binding.expectedWorkspaceRevision;
      }
      const result = await cancelWorker(current);
      if (!result.observed) {
        const freshTask = store.readTask(task.id);
        const freshWorkspace = store.readWorkspace();
        if (freshTask.ok && freshWorkspace.ok && freshWorkspace.data) {
          const lostBinding: WorkerLifecycleBinding = {
            core: new WorkitCore(store, {
              ...piContext(ctx),
              nativeWorker: nativeWorkerForEvidence(() => current),
            }),
            taskId: task.id,
            workerId: worker.id,
            expectedRevision: freshTask.data.revision,
            expectedWorkspaceRevision: freshWorkspace.data.revision,
            sessionId: current.sessionId,
          };
          observeWorkerExit(lostBinding, current, result);
        }
        return failure("recovery_required", "worker termination is uncertain");
      }
      return success(cancelled.revision, cancelled.workspaceRevision, {
        workerId: worker.id,
        exit: result,
      });
    }
    if (request.action === "reconcile")
      return failure("recovery_required", "worker process is not live in this session");
    if (worker.data.state !== "assigned")
      return failure("invalid_transition", "only an assigned worker can be launched");
    if (!request.prompt) return failure("invalid_input", "launch requires a prompt");

    let child: WorkerHandle | null = null;
    const binding: WorkerLifecycleBinding = {
      core: new WorkitCore(store, {
        ...piContext(ctx),
        nativeWorker: nativeWorkerForEvidence(() => child),
      }),
      taskId: task.id,
      workerId: worker.id,
      expectedRevision: task.revision,
      expectedWorkspaceRevision: workspace.revision,
      sessionId: `pi-worker-${worker.id}`,
    };
    const childContext: OperationContext = {
      ...piContext(ctx),
      caller: { host: "pi", actor: binding.sessionId },
      callerAttested: true,
      workerId: worker.id,
      nativeWorker: nativeWorkerForEvidence(() => child),
    };
    const childCore = new WorkitCore(store, childContext);
    const handle = launchSupervisedWorker(worker.data.assignment as WorkerAssignment, {
      runtime: runtimeFor(ctx),
      binding,
      writerCore: childCore,
      prompt: request.prompt,
      onSpawn: (spawned) => {
        child = spawned;
        return true;
      },
      beforeExit: (exited) => {
        if (exited.report) {
          const freshTask = store.readTask(task.id);
          const freshWorkspace = store.readWorkspace();
          if (freshTask.ok && freshWorkspace.ok && freshWorkspace.data)
            advanceWorkerBinding(
              binding,
              reportWorker(
                childCore,
                task.id,
                worker.id,
                exited.report,
                freshTask.data.revision,
                freshWorkspace.data.revision,
              ),
            );
        }
      },
      onExit: (exited) => {
        workers.delete(exited.id);
        bindings.delete(worker.id);
      },
    });
    child = handle;
    if (handle.state !== "running")
      return failure("recovery_required", "worker launch was not observed");
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

  const childWorker = process.env.WORKIT_PI_WORKER_ID;
  if (childWorker) {
    pi.on("session_start", () => {
      process.stdout.write(
        JSON.stringify({
          type: "workit_worker_ready",
          workerId: childWorker,
          sessionId: process.env.WORKIT_PI_WORKER_SESSION ?? "",
        }) + "\n",
      );
    });
  }
  pi.on("session_start", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
    reconcileLostWorkers(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    if (sessions.has(id)) return;
    sessions.add(id);
    return { message: contextMessage(ctx) };
  });
  pi.on("session_before_compact", () => undefined);
  pi.on("session_compact", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("session_compact_failed", () => undefined);
  pi.on("tool_call", (event: ToolCallEvent, ctx) => enforceNativeWriter(event, ctx));
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
            sessionId: process.env.WORKIT_PI_WORKER_SESSION ?? "",
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
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
}
