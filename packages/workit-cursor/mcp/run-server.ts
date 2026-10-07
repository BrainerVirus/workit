import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runStdioServer } from "@brainervirus/workit-mcp/src/index";
import { resolveStateDir } from "@brainervirus/workit-core/src/core/logger";
import { cursorCapabilities } from "../hooks/workit-hook";
import type { OperationContext } from "@brainervirus/workit-core/src/core";

export { cursorCapabilities } from "../hooks/workit-hook";

/** Cursor MCP has no documented per-request session identity. Keep the actor
 * empty and mark it unattested; the shared transport blocks authority writes. */
export const cursorContextProvider = (
  workspaceRoot = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
): { current: () => Promise<OperationContext> } => ({
  current: async (): Promise<OperationContext> => ({
    root: workspaceRoot,
    caller: {
      host: "cursor",
      actor: "",
    },
    callerAttested: false,
    capabilities: cursorCapabilities(),
    constraints: [],
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }),
});

/** Stamp the start of a Cursor session. `workit doctor` compares it with the
 * hook launcher's heartbeat: sessions with no hook run since mean Cursor is
 * not running the plugin's hooks. Best-effort; never blocks the server. */
export const stampCursorSessionStart = (stateDir = resolveStateDir()): void => {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "cursor-session-last-start"),
      `${JSON.stringify({ at: new Date().toISOString() })}\n`,
    );
  } catch {
    /* diagnostic only */
  }
};

if (import.meta.main) {
  stampCursorSessionStart();
  const workspaceRoot = process.argv[2];
  if (workspaceRoot) process.env.WORKFLOW_WORKSPACE_ROOT = workspaceRoot;
  await runStdioServer("cursor", cursorContextProvider());
}
