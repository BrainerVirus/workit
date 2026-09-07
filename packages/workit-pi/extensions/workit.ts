import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { assignmentSchema } from "@brainervirus/workit-core/src/core/task-contract";
import { piContext, workitContext } from "../src/context";
import { enforceNativeWriter, registerWorkitTools } from "../src/tools";
import {
  cancelWorker,
  launchWorker,
  workerCanLaunchNested,
  type WorkerHandle,
  type WorkerAssignment,
} from "../src/worker";

const contextMessage = (ctx: ExtensionContext) => ({
  customType: "workit-context",
  content: workitContext(ctx),
  display: false,
  details: { session: piContext(ctx).caller.actor },
});

export default function extension(pi: ExtensionAPI): void {
  const sessions = new Set<string>();
  const workers = new Map<string, WorkerHandle>();
  registerWorkitTools(pi);
  if (workerCanLaunchNested() && typeof pi.registerCommand === "function") {
    pi.registerCommand("workit-worker", {
      description: "Launch or cancel a pre-assigned read-only stock-Pi worker.",
      handler: async (args, ctx) => {
        let request: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(args);
          if (typeof parsed !== "object" || parsed === null) return;
          request = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (request.action === "cancel" && typeof request.id === "string") {
          const worker = workers.get(request.id);
          if (!worker) return;
          await cancelWorker(worker);
          pi.appendEntry("workit-worker", {
            id: worker.id,
            state: worker.state,
            exit: worker.exit,
          });
          return;
        }
        if (
          request.action !== "launch" ||
          typeof request.taskId !== "string" ||
          typeof request.workerId !== "string" ||
          typeof request.prompt !== "string"
        )
          return;
        const parsedAssignment = assignmentSchema.safeParse(request.assignment);
        if (!parsedAssignment.success || parsedAssignment.data.role === "implementer") return;
        const runtime = {
          node: process.execPath,
          cli: process.argv[1] ?? "",
          workitExtension: fileURLToPath(import.meta.url),
          root: ctx.cwd,
        };
        const worker = launchWorker(parsedAssignment.data as WorkerAssignment, {
          runtime,
          taskId: request.taskId,
          workerId: request.workerId,
          writerReady: true,
          pendingPrompt: request.prompt,
        });
        workers.set(worker.id, worker);
        pi.appendEntry("workit-worker", {
          id: worker.id,
          taskId: worker.taskId,
          workerId: worker.workerId,
          pid: worker.pid,
          state: worker.state,
        });
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
      if (
        typeof details === "object" &&
        details !== null &&
        "data" in details &&
        typeof details.data === "object" &&
        details.data !== null &&
        "data" in details.data &&
        typeof details.data.data === "object" &&
        details.data.data !== null &&
        "report" in details.data.data &&
        details.data.data.report
      )
        process.stdout.write(
          JSON.stringify({ type: "workit_worker_result", report: details.data.data.report }) + "\n",
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
