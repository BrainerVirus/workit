import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { piContext, workitContext } from "../src/context";
import { enforceNativeWriter, registerWorkitTools } from "../src/tools";

const contextMessage = (ctx: ExtensionContext) => ({
  customType: "workit-context",
  content: workitContext(ctx),
  display: false,
  details: { session: piContext(ctx).caller.actor },
});

export default function extension(pi: ExtensionAPI): void {
  const sessions = new Set<string>();
  registerWorkitTools(pi);
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
