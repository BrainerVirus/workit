import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  const compacting = new Set<string>();
  registerWorkitTools(pi);
  pi.on("session_start", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
    compacting.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    if (sessions.has(id) && !compacting.has(id)) return;
    sessions.add(id);
    compacting.delete(id);
    return { message: contextMessage(ctx) };
  });
  pi.on("session_before_compact", (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    compacting.add(id);
    return {
      compaction: {
        summary: workitContext(ctx),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  pi.on("session_compact", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("tool_call", (event, ctx) => enforceNativeWriter(event, ctx));
  pi.on("tool_result", (event, ctx) => {
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
    compacting.delete(ctx.sessionManager.getSessionId());
  });
}
