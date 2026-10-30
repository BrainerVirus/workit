// Direct module imports keep the core barrel out of the hook bundle.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cursorAdapter,
  cursorDeny as deny,
  dispatchHook,
  runAdapterHook,
} from "@brainervirus/workit-core/hooks";

import { PROCESS_START } from "@brainervirus/workit-core/src/hooks/deadline";

export { parseCursorHookInput, type CursorHookInput } from "@brainervirus/workit-core/hooks";
export { cursorCapabilities } from "./capabilities";

/**
 * subagentStart's handler (subagent-start.ts), loaded only for that event: in
 * the build it lives in the cursor-session-start bundle beside this one, in
 * the source tree it is session-start.ts. The path is computed so this bundle
 * never inlines the task engine it needs.
 */
const handleSubagentStartHook = (raw: unknown): Record<string, unknown> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const load = createRequire(import.meta.url);
  let entry: { handleSubagentStartHook: (raw: unknown) => Record<string, unknown> };
  // A required bundle can read as the main module: tell it not to run as one.
  (globalThis as { workitSubagentLoad?: boolean }).workitSubagentLoad = true;
  try {
    entry = load(path.join(here, "cursor-session-start.js"));
  } catch {
    entry = load(path.join(here, "session-start"));
  }
  return entry.handleSubagentStartHook(raw);
};

/** Every tool name the hook treats as a write. The committed preToolUse
 *  matcher must cover all of these (pinned by task-hooks tests) or matching
 *  tools bypass enforcement silently. */
export const CURSOR_WRITE_TOOL_NAMES = [
  "write",
  "edit",
  "delete",
  "remove",
  "apply_patch",
  "patch",
  "rename",
  "mkdir",
  "mv",
  "cp",
  "touch",
] as const;

const isSubagentStart = (raw: unknown) =>
  typeof raw === "object" &&
  raw !== null &&
  (raw as { hook_event_name?: unknown }).hook_event_name === "subagentStart";

const BLOCKING_EVENTS = new Set(["preToolUse", "beforeShellExecution", "subagentStart"]);
const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** A payload Workit cannot place, which says nothing about policy: no folder
 * is open (`workspace_roots` empty), or no conversation id. Without a workspace
 * or an actor there is no task store or session to check, so the hook steps
 * aside with a note instead of denying every action. Null when the payload is
 * complete enough to dispatch. */
const degradedCursorHook = (raw: unknown): { json: Record<string, unknown> } | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const event = typeof value.hook_event_name === "string" ? value.hook_event_name : "";
  const roots = value.workspace_roots;
  const gap =
    !Array.isArray(roots) || roots.length === 0
      ? "no workspace folder is open"
      : event !== "preCompact" &&
          !nonEmptyString(value.conversation_id) &&
          !nonEmptyString(value.session_id)
        ? "the hook payload carries no conversation id"
        : null;
  if (!gap || !event) return null;
  if (!BLOCKING_EVENTS.has(event)) return { json: {} };
  const note = `[workit: ${gap}; Workit checks are skipped for this action]`;
  return { json: { permission: "allow", user_message: note, agent_message: note } };
};

export const handleCursorHook = (raw: unknown): Record<string, unknown> =>
  degradedCursorHook(raw)?.json ??
  (isSubagentStart(raw) ? handleSubagentStartHook(raw) : dispatchHook(cursorAdapter, raw).json);

/** subagentStart's own handler as the deadline's dispatch step: a failure denies. */
const subagentStartStep = (_adapter: unknown, raw: unknown) => {
  let json: Record<string, unknown>;
  try {
    json = handleSubagentStartHook(raw);
  } catch (error) {
    json = deny(`hook failure: ${String(error)}`);
  }
  return { json, exitCode: json.permission === "deny" ? 2 : 0, error: null };
};

export const runCursorHook = async (): Promise<void> => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    raw = undefined;
  }
  const degraded = degradedCursorHook(raw);
  if (degraded) {
    process.stdout.write(`${JSON.stringify(degraded.json)}\n`);
    process.exitCode = 0;
    return;
  }
  process.exitCode = await runAdapterHook(
    cursorAdapter,
    [text],
    process.stdout,
    process.stderr,
    process.env,
    {
      startedAt: PROCESS_START,
      ...(isSubagentStart(raw) ? { dispatch: subagentStartStep } : {}),
    },
  );
};

if (import.meta.main) await runCursorHook();
