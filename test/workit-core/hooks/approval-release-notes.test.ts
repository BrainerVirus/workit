// #864, release notes: `workit release notes approve <v>` is asked on the
// action itself, like a YouTrack write. Claude Code's PreToolUse (auto mode
// counts) and Pi's TUI dialog show the draft in full, and the call runs with
// the ticket bound to that draft's text; a mode where no person sees a prompt
// runs it marked unasked; a wrapped call is denied with its plain form.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseNotesAsk } from "@/packages/workit-core/src/approvals/release-notes-ask";
import { consumeInlineAsk } from "@/packages/workit-core/src/approvals/store";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-rn-ask-")));
const repo = path.join(base, "repo");
const saved = { state: process.env.WORKIT_STATE_DIR, config: process.env.WORKIT_CONFIG };
let run = 0;
beforeAll(() => {
  mkdirSync(path.join(base, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(base, "config");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
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

const DRAFT = path.join(repo, ".git", "workit", "release-notes", "1.0.0.md");
/** A long draft: the prompt shows all of it, never "N more lines". */
const NOTES = [
  "## Highlights",
  "",
  "- Faster startup",
  "",
  "## Changes",
  "",
  ...Array.from({ length: 80 }, (_, index) => `- change ${index + 1}`),
  "",
].join("\n");
const writeDraft = (text = NOTES) => {
  mkdirSync(path.dirname(DRAFT), { recursive: true });
  writeFileSync(DRAFT, text);
};
const COMMAND = "workit release notes approve 1.0.0";
const SESSION = "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11";

type Out = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: { command: string; description?: string };
};
const claude = (command: string, mode = "auto", entry = "cli"): Out =>
  dispatchHook(
    claudeCodeAdapter,
    {
      session_id: SESSION,
      transcript_path: path.join(base, "t.jsonl"),
      cwd: repo,
      permission_mode: mode,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Approve the release notes" },
      tool_use_id: "toolu_01",
    },
    { CLAUDE_CODE_ENTRYPOINT: entry },
  ).json.hookSpecificOutput ?? {};

const ticketOf = (command: string | undefined): string | undefined =>
  /^WORKIT_APPROVAL_TICKET=(\S+) workit release notes approve 1\.0\.0$/u.exec(command ?? "")?.[1];

const consume = (ticket: string, session: string, notes = readFileSync(DRAFT, "utf8")) => {
  const ask = releaseNotesAsk(["1.0.0"], { path: DRAFT, notes })!;
  return consumeInlineAsk({
    ticket,
    kind: ask.kind,
    argvHash: ask.argvHash,
    contentHash: ask.contentHash,
    verb: "release notes approve",
    session,
  });
};

test("Given Claude Code in auto mode and a draft, When the agent runs release notes approve, Then the host asks with the full notes and the call carries a ticket bound to that text", () => {
  writeDraft();
  const out = claude(COMMAND);
  expect(out.permissionDecision).toBe("ask");
  for (const line of NOTES.trimEnd().split("\n"))
    expect(out.permissionDecisionReason).toContain(line);
  expect(out.permissionDecisionReason).not.toContain("more lines");
  expect(out.permissionDecisionReason).not.toContain("Only the user runs");
  expect(out.updatedInput?.description).toBe("Approve the release notes");
  const ticket = ticketOf(out.updatedInput?.command);
  expect(ticket).toBeDefined();
  expect(consume(ticket!, SESSION).ok).toBe(true);
  // One yes, one use.
  expect(consume(ticket!, SESSION).ok).toBe(false);
});

test("Given an ask, When the draft changes before the call runs, Then the ticket does not cover it, and the next ask shows the new text", () => {
  writeDraft();
  const first = ticketOf(claude(COMMAND).updatedInput?.command)!;
  writeDraft(NOTES.replace("Faster startup", "Slower startup"));
  const used = consume(first, SESSION);
  expect(used.ok).toBe(false);
  expect(used.ok ? "" : used.reason).toContain("changed");
  const again = claude(COMMAND);
  expect(again.permissionDecisionReason).toContain("Slower startup");
  expect(consume(ticketOf(again.updatedInput?.command)!, SESSION).ok).toBe(true);
});

test("Given a ticket from one session, When another session uses it, Then it is refused", () => {
  writeDraft();
  const ticket = ticketOf(claude(COMMAND).updatedInput?.command)!;
  expect(consume(ticket, "another-session").ok).toBe(false);
});

test("Given bypassPermissions, dontAsk or an SDK entrypoint, When the call runs, Then nothing is asked and the call is marked unasked", () => {
  writeDraft();
  for (const [mode, entry, named] of [
    ["bypassPermissions", "cli", "bypassPermissions"],
    ["dontAsk", "cli", "dontAsk"],
    ["default", "sdk-ts", "sdk-ts"],
  ] as const) {
    const out = claude(COMMAND, mode, entry);
    expect(out.permissionDecision, mode).toBeUndefined();
    expect(out.updatedInput?.command, mode).toBe(`WORKIT_APPROVAL_UNASKED=${named} ${COMMAND}`);
  }
});

test("Given the call inside something else, When the hook runs, Then it is denied with the plain form", () => {
  writeDraft();
  for (const command of [`cd ${repo} && ${COMMAND}`, `${COMMAND} | cat`, `bash -c '${COMMAND}'`]) {
    const out = claude(command);
    expect(out.permissionDecision, command).toBe("deny");
    expect(out.permissionDecisionReason, command).toContain(`\`${COMMAND}\``);
  }
});

test("Given no draft (or --package, which needs the config), When the agent runs approve, Then the user-only ask stays and no ticket rides", () => {
  rmSync(path.dirname(DRAFT), { recursive: true, force: true });
  for (const command of [COMMAND, "workit release notes approve 1.0.0 --package pkg-a"]) {
    const out = claude(command);
    expect(out.permissionDecision, command).toBe("ask");
    expect(out.permissionDecisionReason, command).toContain("Only the user runs");
    expect(out.updatedInput, command).toBeUndefined();
  }
});

const pi = (mode: string, answer: string | undefined, shown: string[] = []) =>
  ({
    cwd: repo,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: {
      select: async (title: string) => {
        shown.push(title);
        return answer;
      },
    },
  }) as never;
const piCall = async (context: never) => {
  const event = { toolName: "bash", toolCallId: "call-1", input: { command: COMMAND } };
  const result = await enforceToolPolicy(event as never, context);
  return { result, command: event.input.command };
};

test("Given Pi's TUI, When the user approves the dialog showing the full notes, Then the call runs with its ticket; Reject blocks it", async () => {
  writeDraft();
  const shown: string[] = [];
  const approved = await piCall(pi("tui", "Approve once", shown));
  expect(approved.result).toBeUndefined();
  for (const line of NOTES.trimEnd().split("\n")) expect(shown[0]).toContain(line);
  expect(consume(ticketOf(approved.command)!, "pi-session").ok).toBe(true);
  const rejected = await piCall(pi("tui", "Reject"));
  expect((rejected.result as { block?: boolean }).block).toBe(true);
  expect(rejected.command).toBe(COMMAND);
});

test("Given Pi without a dialog (print mode), When the agent runs approve, Then it is blocked: only the user runs it", async () => {
  writeDraft();
  const { result, command } = await piCall(pi("print", undefined));
  expect((result as { block?: boolean; reason?: string }).block).toBe(true);
  expect((result as { reason?: string }).reason).toContain("Only the user runs");
  expect(command).toBe(COMMAND);
});
