import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
  handleHook,
  type HookEventKind,
  type HookInput,
  type HostAdapter,
  type HostDescriptor,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, startTask, tempRoot, withProtectedMain } from "./hook-fixtures";

// Design §1.3: which native hook carries each protocol event, per host.
// null means workit registers no native hook for the event (the host may
// have one: docs/agents/hosts.md, Host parity, records it).
const PARITY: Record<
  "claude_code" | "codex" | "cursor" | "opencode" | "pi",
  Partial<Record<HookEventKind, string | null>>
> = {
  claude_code: {
    "session.start": "SessionStart",
    "context.turn": "UserPromptSubmit",
    "shell.pre": "PreToolUse",
    "write.pre": "PreToolUse",
    "shell.post": "PostToolUse",
    "subagent.start": "SubagentStart",
    "subagent.stop": null,
    "compact.pre": null,
    stop: "Stop",
  },
  codex: {
    "session.start": "SessionStart",
    "context.turn": "UserPromptSubmit",
    "shell.pre": "PreToolUse",
    // PreToolUse covers apply_patch edits: the write gate enforces.
    "write.pre": "PreToolUse",
    // PostToolUse records raw `git commit`s for the session.
    "shell.post": "PostToolUse",
    "subagent.start": "SubagentStart",
    "subagent.stop": "SubagentStop",
    "compact.pre": null,
    stop: "Stop",
  },
  cursor: {
    "session.start": "sessionStart",
    "context.turn": null,
    "shell.pre": "beforeShellExecution",
    "write.pre": "preToolUse",
    "shell.post": null,
    "subagent.start": "subagentStart",
    "subagent.stop": "subagentStop",
    "compact.pre": "preCompact",
    stop: null,
  },
  opencode: {
    "session.start": null,
    "context.turn": 'session.hook("context")',
    "shell.pre": 'permission.hook("evaluate")',
    "write.pre": 'permission.hook("evaluate")',
    "shell.post": 'tool.hook("execute.after")',
    "subagent.start": 'tool.hook("execute.before") subagent',
    "subagent.stop": 'tool.hook("execute.after") subagent',
    "compact.pre": 'session.hook("compaction")',
    stop: 'event("session.idle")',
  },
  pi: {
    "session.start": "session_start",
    "context.turn": "before_agent_start",
    "shell.pre": "tool_call",
    "write.pre": "tool_call",
    "shell.post": "tool_result",
    "subagent.start": null,
    "subagent.stop": null,
    "compact.pre": "session_before_compact",
    stop: "agent_end",
  },
};

const DESCRIPTORS: Record<keyof typeof PARITY, HostDescriptor> = {
  claude_code: CLAUDE_CODE_DESCRIPTOR,
  codex: CODEX_DESCRIPTOR,
  cursor: CURSOR_DESCRIPTOR,
  opencode: OPENCODE_DESCRIPTOR,
  pi: PI_DESCRIPTOR,
};

// Native fixture → the protocol event its adapter must produce.
const FIXTURE_EVENTS: Array<
  [HostAdapter, "claude-code" | "codex" | "cursor", string, HookEventKind]
> = [
  [claudeCodeAdapter, "claude-code", "session-start-compact", "session.start"],
  [claudeCodeAdapter, "claude-code", "user-prompt-submit", "context.turn"],
  [claudeCodeAdapter, "claude-code", "pre-tool-use-bash", "shell.pre"],
  [claudeCodeAdapter, "claude-code", "pre-tool-use-write", "write.pre"],
  [claudeCodeAdapter, "claude-code", "post-tool-use-bash", "shell.post"],
  [claudeCodeAdapter, "claude-code", "subagent-start", "subagent.start"],
  [claudeCodeAdapter, "claude-code", "subagent-stop", "subagent.stop"],
  [claudeCodeAdapter, "claude-code", "pre-compact", "compact.pre"],
  [claudeCodeAdapter, "claude-code", "stop", "stop"],
  [codexAdapter, "codex", "session-start", "session.start"],
  [codexAdapter, "codex", "user-prompt-submit", "context.turn"],
  [codexAdapter, "codex", "pre-tool-use-bash", "shell.pre"],
  [codexAdapter, "codex", "pre-tool-use-apply-patch", "write.pre"],
  [codexAdapter, "codex", "post-tool-use-bash", "shell.post"],
  [codexAdapter, "codex", "subagent-start", "subagent.start"],
  [codexAdapter, "codex", "subagent-stop", "subagent.stop"],
  [codexAdapter, "codex", "stop", "stop"],
  [cursorAdapter, "cursor", "session-start", "session.start"],
  [cursorAdapter, "cursor", "before-shell-execution", "shell.pre"],
  [cursorAdapter, "cursor", "pre-tool-use", "write.pre"],
  [cursorAdapter, "cursor", "subagent-start", "subagent.start"],
  [cursorAdapter, "cursor", "subagent-stop", "subagent.stop"],
  [cursorAdapter, "cursor", "pre-compact", "compact.pre"],
  [cursorAdapter, "cursor", "stop", "stop"],
];

test("every host maps the same protocol events onto its documented native hooks", () => {
  for (const [host, row] of Object.entries(PARITY) as Array<
    [keyof typeof PARITY, (typeof PARITY)[keyof typeof PARITY]]
  >) {
    const descriptor = DESCRIPTORS[host];
    for (const [kind, native] of Object.entries(row) as Array<[HookEventKind, string | null]>) {
      expect(descriptor.events[kind].native, `${host} ${kind}`).toBe(native);
      // A native hook name implies support; no hook means none or undocumented.
      expect(
        ["native", "partial"].includes(descriptor.events[kind].support),
        `${host} ${kind} support`,
      ).toBe(native !== null);
    }
  }
  const root = tempRoot();
  try {
    for (const [adapter, dir, name, kind] of FIXTURE_EVENTS) {
      const parsed = adapter.parse(fixture(dir, name, root), {});
      expect(parsed.ok, `${dir}/${name}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.input.event.kind, `${dir}/${name}`).toBe(kind);
      // An event the adapter parses but workit does not register has no native hook.
      const { native, support } = adapter.descriptor.events[kind];
      expect(native, `${dir}/${name} native`).toBe(support === "none" ? null : parsed.native);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const input = (root: string, event: HookInput["event"], host: HookInput["host"] = "codex_cli") => ({
  host,
  cwd: root,
  session: { id: `session-${crypto.randomUUID()}`, agentId: null, agentType: null, parentId: null },
  permissionMode: null,
  transcriptPath: null,
  event,
});

test("shell.pre denies only noncompliant literal branch creation, with the correction", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      const deps = { descriptor: CODEX_DESCRIPTOR, addendum: null };
      const shell = (command: string) =>
        handleHook(input(root, { kind: "shell.pre", command, toolUseId: null }), deps);
      const denied = shell("git checkout -b main");
      expect(denied.kind).toBe("deny");
      expect(denied.kind === "deny" && denied.reason).toContain("protected_ref");
      expect(denied.kind === "deny" && denied.reason).toContain("choose a non-protected branch");
      for (const command of ["git switch -c feature/raw", "git status", 'git checkout -b "main"'])
        expect(shell(command), command).toEqual({ kind: "none" });
      // A host that cannot render a deny never claims one.
      expect(
        handleHook(
          input(root, { kind: "shell.pre", command: "git checkout -b main", toolUseId: null }),
          {
            descriptor: {
              ...CODEX_DESCRIPTOR,
              shellPolicy: { ...CODEX_DESCRIPTOR.shellPolicy, deny: "undocumented" },
            },
            addendum: null,
          },
        ),
      ).toEqual({ kind: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("events without S8 behavior stay no-ops on every host", () => {
  const root = tempRoot();
  try {
    for (const descriptor of Object.values(DESCRIPTORS))
      for (const event of [
        { kind: "tool.pre", tool: "Write", toolUseId: null },
        { kind: "shell.post", command: "ls", stdout: "", exitCode: 0, toolUseId: null },
        {
          kind: "subagent.stop",
          agentId: null,
          agentType: null,
          lastMessage: null,
          stopHookActive: false,
        },
        { kind: "prompt.submit", prompt: "go", source: null },
        { kind: "stop", lastMessage: null, stopHookActive: false },
      ] as const)
        expect(
          handleHook(input(root, event), { descriptor, addendum: null }),
          `${descriptor.host} ${event.kind}`,
        ).toEqual({
          kind: "none",
        });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the unfinished-task offer is shared: once per host session, startup only, never the shown task", () => {
  const root = tempRoot();
  try {
    startTask(root, { host: "claude_code", actor: "claude-mine" }, "bound to this session");
    const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };
    const start = (id: string, source: "startup" | "resume") =>
      handleHook(
        {
          ...input(root, { kind: "session.start", source }, "claude_code"),
          session: { id, agentId: null, agentType: null, parentId: null },
        },
        deps,
      );
    const text = (decision: ReturnType<typeof handleHook>) =>
      decision.kind === "context" ? decision.text : "";
    // The bound session sees its task as context, not as an offer.
    const own = text(start("claude-mine", "startup"));
    expect(own).toContain("<workit-task-context>");
    expect(own).not.toContain("<workit-history-offer>");
    expect(own).toContain("bound to this session");
    // Another session is offered it once, on startup only.
    expect(text(start("claude-other", "resume"))).not.toContain("<workit-history-offer>");
    const offered = text(start("claude-other", "startup"));
    expect(offered).toContain("<workit-history-offer>");
    expect(offered).toContain("bound to this session");
    expect(text(start("claude-other", "startup"))).not.toContain("<workit-history-offer>");
    // The same handle on another host is a different session.
    const codex = handleHook(
      {
        ...input(root, { kind: "session.start", source: "startup" }),
        session: { id: "claude-mine", agentId: null, agentType: null, parentId: null },
      },
      {
        descriptor: {
          ...CODEX_DESCRIPTOR,
          context: { ...CODEX_DESCRIPTOR.context, task: "session-bound" },
        },
        addendum: null,
      },
    );
    expect(text(codex)).toContain("<workit-history-offer>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail policy: pre-tool parse errors deny only on fail-closed hosts; start events keep a diagnostic", () => {
  const root = tempRoot();
  try {
    // Codex is not fail-closed: a broken PreToolUse passes through.
    const codex = dispatchHook(
      codexAdapter,
      fixture("codex", "pre-tool-use-bash", root, { tool_input: {} }),
      {},
    );
    expect(codex.error).toBe("tool_input.command is required for shell tools");
    expect(codex.json).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(codex.exitCode).toBe(0);
    // Cursor declares failClosed: the same failure denies with exit 2.
    const cursor = dispatchHook(
      cursorAdapter,
      fixture("cursor", "before-shell-execution", root, { workspace_roots: [] }),
      {},
    );
    expect(cursor.json).toMatchObject({ permission: "deny" });
    expect(cursor.exitCode).toBe(2);
    // Claude is not fail-closed and never emits allow.
    const claude = dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-bash", root, { tool_input: {} }),
      {},
    );
    expect(claude.json).toEqual({});
    // A start event keeps a visible diagnostic instead of failing silently.
    const start = dispatchHook(
      codexAdapter,
      fixture("codex", "session-start", root, { cwd: `${root}/missing` }),
      {},
    );
    expect(JSON.stringify(start.json)).toContain(
      "[workit diagnostic: cwd must be an existing absolute directory]",
    );
    // An unknown start source still restores context (D17) but never offers history.
    const unknownSource = dispatchHook(
      codexAdapter,
      fixture("codex", "session-start", root, { source: "teleport" }),
      {},
    );
    expect(unknownSource.error).toBeNull();
    expect(JSON.stringify(unknownSource.json)).toContain("<workit-contract>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
