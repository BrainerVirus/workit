// Shared host-hook protocol. Hook bundles import this, not the core barrel.
export * from "./protocol";
export {
  capabilitiesFor,
  support,
  type Axis,
  type CapabilityRule,
  type HostDescriptor,
  type Support,
} from "./descriptor";
export {
  currentTaskEntry,
  sessionCompactContext,
  sessionContextText,
  turnContextText,
  unfinishedTaskOffer,
  type SessionHandle,
} from "./context";
export { shellPolicy } from "./policy";
export { shellWrites, writeGate } from "./write-gate";
export { callKey, noteRawCommit, rawGitPost, rawGitPre } from "./raw-git";
export { isWriteTool, writePaths } from "./hosts/fields";
export { dispatchHook, failureDecision, handleHook, type HookDeps } from "./handle";
export { HOOK_ADAPTERS, runHookProcess } from "./run";
export { CLAUDE_CODE_DESCRIPTOR, claudeCodeAdapter } from "./hosts/claude-code";
export {
  CODEX_DESCRIPTOR,
  codexAdapter,
  codexDescriptor,
  detectCodexSurface,
  parseCodexHookInput,
  type CodexHookEvent,
  type CodexHookInput,
  type CodexHost,
} from "./hosts/codex";
export {
  CURSOR_DESCRIPTOR,
  cursorAdapter,
  cursorDeny,
  cursorWorkspaceRoot,
  parseCursorHookInput,
  type CursorHookEvent,
  type CursorHookInput,
} from "./hosts/cursor";
export { OPENCODE_DESCRIPTOR } from "./hosts/opencode";
export { PI_DESCRIPTOR } from "./hosts/pi";
