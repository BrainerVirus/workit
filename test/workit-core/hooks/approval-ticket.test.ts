// #864, ticket replay: only the host's own rewrite puts WORKIT_APPROVAL_TICKET
// (or WORKIT_APPROVAL_UNASKED) on a call. A command an agent writes that names
// either, however it spells or wraps it, is denied by every host's shell gate,
// and a file write carrying either name is refused, so a rejected prompt's
// rewritten command copied from the transcript cannot be replayed.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consumeInlineAsk, INLINE_ASK_TTL_MS } from "@/packages/workit-core/src/approvals/store";
import { youTrackAsk } from "@/packages/workit-core/src/approvals/youtrack-ask";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { checkWriteArgs } from "@/packages/workit-opencode/src/v2/permissions";
import { fixture } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-ticket-")));
const saved = { state: process.env.WORKIT_STATE_DIR, config: process.env.WORKIT_CONFIG };
let run = 0;
beforeAll(() => {
  mkdirSync(path.join(base, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(base, "config");
  writeFileSync(path.join(base, "note.md"), "Progress:\n- done");
});
beforeEach(() => {
  run += 1;
  process.env.WORKIT_STATE_DIR = path.join(base, `state-${run}`);
});
afterAll(() => {
  for (const [key, value] of [
    ["WORKIT_STATE_DIR", saved.state],
    ["WORKIT_CONFIG", saved.config],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(base, { recursive: true, force: true });
});

type Out = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: { command: string };
};
const claudeBash = (command: string): Out =>
  dispatchHook(
    claudeCodeAdapter,
    {
      session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
      transcript_path: path.join(base, "t.jsonl"),
      cwd: base,
      permission_mode: "auto",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "d" },
      tool_use_id: "toolu_01",
    },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  ).json.hookSpecificOutput ?? {};

const denied: Record<string, (command: string) => boolean> = {
  claude: (command) => claudeBash(command).permissionDecision === "deny",
  codex: (command) =>
    (
      dispatchHook(
        codexAdapter,
        fixture("codex", "pre-tool-use-bash", base, { tool_input: { command } }),
      ).json as { hookSpecificOutput?: { permissionDecision?: string } }
    ).hookSpecificOutput?.permissionDecision === "deny",
  cursor: (command) =>
    (
      dispatchHook(cursorAdapter, fixture("cursor", "before-shell-execution", base, { command }))
        .json as { permission?: string }
    ).permission === "deny",
  pi: (command) => {
    const out = enforceToolPolicy(
      { toolName: "bash", toolCallId: "c", input: { command } } as never,
      {
        cwd: base,
        mode: "print",
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "p" },
      } as never,
    );
    return (out as { block?: boolean } | undefined)?.block === true;
  },
  // OpenCode's permission.evaluate runs this same gate on each shell resource.
  opencode: (command) => ytrackGate(base, command, "posix", false)?.kind === "deny",
};

test("Given a prompt the user rejected, When the agent replays the rewritten command copied from the transcript, Then every host's shell gate denies it", () => {
  const asked = claudeBash("workit youtrack note X-1 --file note.md");
  expect(asked.permissionDecision).toBe("ask");
  const replay = asked.updatedInput?.command ?? "";
  expect(replay).toStartWith("WORKIT_APPROVAL_TICKET=");
  for (const [host, deny] of Object.entries(denied)) expect(deny(replay), host).toBe(true);
});

test("Given a ticket name anywhere in an agent's command (export, env, bash -c, a heredoc, quotes), When any host judges it, Then it is denied", () => {
  for (const command of [
    "export WORKIT_APPROVAL_TICKET=abc; workit youtrack note X-1 --file note.md",
    "env WORKIT_APPROVAL_TICKET=abc workit youtrack time X-1 --minutes 30",
    "bash -c 'WORKIT_APPROVAL_TICKET=abc workit youtrack note X-1 --markdown hi'",
    "cat > post.sh <<'EOF'\nWORKIT_APPROVAL_TICKET=abc workit youtrack note X-1 --markdown hi\nEOF",
    'WORKIT_APPROVAL_"TICKET"=abc ./post.sh',
    "WORKIT_APPROVAL_UNASKED=x workit youtrack note X-1 --markdown hi",
  ])
    for (const [host, deny] of Object.entries(denied))
      expect(deny(command), `${host}: ${command}`).toBe(true);
  // A plain command that does not name it is untouched.
  expect(denied.codex?.("ls -la")).toBe(false);
});

test("Given a script file carrying a ticket, When the agent writes it with Write or Edit, Then the write is refused", () => {
  const write = (tool: string, input: Record<string, unknown>) =>
    (
      dispatchHook(
        claudeCodeAdapter,
        {
          session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
          transcript_path: path.join(base, "t.jsonl"),
          cwd: base,
          permission_mode: "auto",
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: input,
          tool_use_id: "toolu_02",
        },
        { CLAUDE_CODE_ENTRYPOINT: "cli" },
      ).json.hookSpecificOutput as Out | undefined
    )?.permissionDecision;
  const file = path.join(base, "post.sh");
  expect(
    write("Write", {
      file_path: file,
      content: "WORKIT_APPROVAL_TICKET=abc workit youtrack note X-1 --markdown hi\n",
    }),
  ).toBe("deny");
  expect(
    write("Edit", {
      file_path: file,
      old_string: "x",
      new_string: "export WORKIT_APPROVAL_TICKET=abc",
    }),
  ).toBe("deny");
  expect(write("Write", { file_path: file, content: "echo hello\n" })).not.toBe("deny");
  const pi = enforceToolPolicy(
    {
      toolName: "write",
      toolCallId: "c",
      input: { path: file, content: "WORKIT_APPROVAL_TICKET=abc" },
    } as never,
    {
      cwd: base,
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "p" },
    } as never,
  );
  expect((pi as { block?: boolean } | undefined)?.block).toBe(true);
});

test("Given an inline ask, Then it lives two minutes", () => {
  expect(INLINE_ASK_TTL_MS).toBe(2 * 60_000);
});

// A rejected prompt stops the turn; the next thing is the user's own message.
// Every unused ask of the session is closed then (and a lead's at its Stop),
// so a ticket can only be used in the turn of its yes.
const event = (name: "UserPromptSubmit" | "Stop", extra: Record<string, unknown> = {}) =>
  dispatchHook(
    claudeCodeAdapter,
    {
      session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
      transcript_path: path.join(base, "t.jsonl"),
      cwd: base,
      permission_mode: "auto",
      hook_event_name: name,
      ...(name === "UserPromptSubmit"
        ? { prompt: "no, do not post that" }
        : { stop_hook_active: false }),
      ...extra,
    },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  );

const ticketOf = (agent?: string) => {
  const out = (dispatchHook(
    claudeCodeAdapter,
    {
      session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
      transcript_path: path.join(base, "t.jsonl"),
      cwd: base,
      permission_mode: "auto",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "workit youtrack note X-1 --file note.md", description: "d" },
      tool_use_id: "toolu_03",
      ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}),
    },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  ).json.hookSpecificOutput ?? {}) as Out;
  return /^WORKIT_APPROVAL_TICKET=(\S+) /u.exec(out.updatedInput?.command ?? "")?.[1] ?? "";
};
const posts = (ticket: string) => {
  const ask = youTrackAsk(["note", "X-1", "--file", "note.md"], base);
  return consumeInlineAsk({
    ticket,
    kind: "youtrack-write",
    argvHash: ask?.argvHash ?? "",
    contentHash: ask?.contentHash ?? "",
    verb: "youtrack note",
    session: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
  }).ok;
};

test("Given an ask the user rejected, When the user's next message arrives, Then the same ticket no longer posts", () => {
  const ticket = ticketOf();
  event("UserPromptSubmit");
  expect(posts(ticket)).toBe(false);
});

test("Given a lead's unused ask, When its turn stops, Then the ticket no longer posts; a subagent's ask survives the lead's Stop but not the user's next message", () => {
  const lead = ticketOf();
  event("Stop");
  expect(posts(lead)).toBe(false);
  const worker = ticketOf("a1b2c3");
  event("Stop");
  expect(posts(worker)).toBe(true);
  const next = ticketOf("a1b2c3");
  event("UserPromptSubmit");
  expect(posts(next)).toBe(false);
});

test("Given an ask in the same turn, When the call uses its ticket before any new message, Then it posts", () => {
  expect(posts(ticketOf())).toBe(true);
});

// Parity: every host's write gate gets the write's content (#864).
const TICKETED = "WORKIT_APPROVAL_TICKET=abc workit youtrack note X-1 --markdown hi\n";
const codexPatch = (body: string) =>
  (
    dispatchHook(
      codexAdapter,
      fixture("codex", "pre-tool-use-apply-patch", base, {
        tool_input: {
          command: `*** Begin Patch\n*** Add File: post.sh\n+${body}*** End Patch\n`,
        },
      }),
    ).json as { hookSpecificOutput?: { permissionDecision?: string } }
  ).hookSpecificOutput?.permissionDecision;
const cursorWrite = (content: string) =>
  (
    dispatchHook(
      cursorAdapter,
      fixture("cursor", "pre-tool-use", base, {
        tool_input: { file_path: path.join(base, "post.sh"), content },
      }),
    ).json as { permission?: string }
  ).permission;
const opencodeWrite = (tool: string, input: Record<string, unknown>): string | null => {
  try {
    checkWriteArgs(tool, input);
    return null;
  } catch (error) {
    return String(error);
  }
};

test("Given Codex apply_patch, Cursor's Write and OpenCode's write, edit and patch tools, When a write names the ticket variable, Then it is refused; a normal write is not", () => {
  expect(codexPatch(TICKETED)).toBe("deny");
  expect(codexPatch("echo hello\n")).not.toBe("deny");
  expect(cursorWrite(TICKETED)).toBe("deny");
  expect(cursorWrite("echo hello\n")).not.toBe("deny");
  const file = path.join(base, "post.sh");
  expect(opencodeWrite("write", { filePath: file, content: TICKETED })).toContain(
    "approval ticket",
  );
  expect(
    opencodeWrite("edit", {
      filePath: file,
      oldString: "a",
      newString: 'WORKIT_APPROVAL_"UNASKED"=x',
    }),
  ).toContain("approval ticket");
  expect(opencodeWrite("patch", { patchText: TICKETED })).toContain("approval ticket");
  expect(opencodeWrite("write", { filePath: file, content: "echo hello\n" })).toBeNull();
  expect(opencodeWrite("read", { filePath: file, note: TICKETED })).toBeNull();
});

test("Given a lead's ticket and a subagent's, When either is carried into the other's call, Then the hook denies it", () => {
  const lead = ticketOf();
  const worker = ticketOf("a1b2c3");
  const call = (ticket: string, agent?: string) =>
    (
      dispatchHook(
        claudeCodeAdapter,
        {
          session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
          transcript_path: path.join(base, "t.jsonl"),
          cwd: base,
          permission_mode: "auto",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: `WORKIT_APPROVAL_TICKET=${ticket} workit youtrack note X-1 --file note.md`,
          },
          tool_use_id: "toolu_04",
          ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}),
        },
        { CLAUDE_CODE_ENTRYPOINT: "cli" },
      ).json.hookSpecificOutput as Out | undefined
    )?.permissionDecision;
  expect(call(lead, "a1b2c3")).toBe("deny");
  expect(call(worker)).toBe("deny");
});
