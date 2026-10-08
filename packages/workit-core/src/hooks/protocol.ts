// The shared host-hook protocol: every host adapter parses its native payload
// into a HookInput and renders a HookDecision back. Types only, no I/O.
import type { HostDescriptor } from "./descriptor";

export type HostId = "claude_code" | "opencode" | "codex_cli" | "codex_desktop" | "cursor" | "pi";

export type Session = {
  id: string;
  agentId: string | null;
  agentType: string | null;
  parentId: string | null;
};

export type SessionSource = "startup" | "resume" | "clear" | "compact" | "fork";

export type HookEvent =
  | { kind: "session.start"; source: SessionSource }
  /** Per-turn injection (OpenCode session context, Pi before_agent_start, Claude UserPromptSubmit). */
  | {
      kind: "context.turn";
      /** The submitted prompt, on hosts whose per-turn event carries it. */
      prompt?: string | null;
    }
  | {
      kind: "shell.pre";
      command: string;
      toolUseId: string | null;
      /** The shell that runs `command`; posix when absent. */
      dialect?: "posix" | "powershell";
    }
  /** A pre-tool gate for a non-shell tool. Host permission policy owns these. */
  | {
      kind: "tool.pre";
      tool: string;
      toolUseId: string | null;
      /** The skill a skill-loading tool loads (Claude Code's Skill tool). */
      skill?: string | null;
    }
  /** A file-writing tool (Edit, Write, apply_patch…): the before-write gate (S17). */
  | { kind: "write.pre"; tool: string; paths: string[]; toolUseId: string | null }
  | {
      kind: "shell.post";
      command: string;
      stdout: string;
      exitCode: number | null;
      toolUseId: string | null;
      dialect?: "posix" | "powershell";
    }
  | { kind: "subagent.start"; agentId: string; agentType: string; task: string | null }
  | {
      kind: "subagent.stop";
      agentId: string | null;
      agentType: string | null;
      lastMessage: string | null;
      stopHookActive: boolean;
    }
  | { kind: "prompt.submit"; prompt: string; source: string | null }
  | { kind: "compact.pre"; trigger: "manual" | "auto" }
  | { kind: "stop"; lastMessage: string | null; stopHookActive: boolean };

export type HookEventKind = HookEvent["kind"];

export const HOOK_EVENT_KINDS = [
  "session.start",
  "context.turn",
  "shell.pre",
  "tool.pre",
  "write.pre",
  "shell.post",
  "subagent.start",
  "subagent.stop",
  "prompt.submit",
  "compact.pre",
  "stop",
] as const satisfies readonly HookEventKind[];

export type HookInput = {
  host: HostId;
  cwd: string;
  session: Session;
  permissionMode: string | null;
  transcriptPath: string | null;
  event: HookEvent;
};

export type HookDecision =
  | { kind: "none" }
  /** Model-visible additional context. */
  | { kind: "context"; text: string }
  /** The reason text always carries its own correction (principle 3). */
  | { kind: "deny"; reason: string; unblock: string | null }
  /** Stop/SubagentStop: keep working. */
  | { kind: "continue"; reason: string }
  | { kind: "notice"; userMessage: string };

/** A hook-process parse: the native event name is kept for rendering. */
export type ParsedHook =
  | { ok: true; input: HookInput; native: string }
  | { ok: false; error: string; native: string | null; event: HookEventKind | null };

export type RenderedHook = { json: Record<string, unknown>; exitCode: number };

export type HostAdapter = {
  descriptor: HostDescriptor;
  parse(raw: unknown, env: NodeJS.ProcessEnv): ParsedHook;
  render(decision: HookDecision, native: string | null): RenderedHook;
  /** Host-specific lines appended inside the session-start contract. */
  addendum?(input: HookInput): string | null;
};
