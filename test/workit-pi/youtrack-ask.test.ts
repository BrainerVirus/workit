// #864, Pi: in the TUI a plain `workit youtrack …` write shows its full text
// in a dialog on the tool call itself; Approve runs that call with its ticket
// and the verb posts in it; Reject blocks it. Print and RPC modes have no
// dialog: the call runs unticketed and the verb refuses with the terminal line.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consumeInlineAsk } from "@/packages/workit-core/src/approvals/store";
import { youTrackAsk } from "@/packages/workit-core/src/approvals/youtrack-ask";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-pi-yt-ask-")));
const saved = { state: process.env.WORKIT_STATE_DIR, config: process.env.WORKIT_CONFIG };
let run = 0;
beforeAll(() => {
  mkdirSync(path.join(base, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(base, "config");
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

const ctx = (mode: string, answer: string | undefined, shown: string[] = []) =>
  ({
    cwd: base,
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

const NOTE = "Pi progress:\n- step one\n- step two";
const COMMAND = "workit youtrack note X-1 --file note.md";

const call = async (command: string, context: never) => {
  const event = { toolName: "bash", toolCallId: "call-1", input: { command } };
  const result = await enforceToolPolicy(event as never, context);
  return { result, command: event.input.command };
};

test("Given Pi's TUI, When the user approves the dialog showing the full comment, Then the call runs with its ticket and the verb's yes is bound to it", async () => {
  writeFileSync(path.join(base, "note.md"), NOTE);
  const shown: string[] = [];
  const { result, command } = await call(COMMAND, ctx("tui", "Approve once", shown));
  expect(result).toBeUndefined();
  for (const line of NOTE.split("\n")) expect(shown[0]).toContain(line);
  expect(shown[0]).not.toMatch(/ap_[a-z2-7]{8}/u);
  const ticket = /^WORKIT_APPROVAL_TICKET=(\S+) workit youtrack note X-1 --file note\.md$/u.exec(
    command,
  )?.[1];
  expect(ticket).toBeDefined();
  const ask = youTrackAsk(["note", "X-1", "--file", "note.md"], base)!;
  const used = consumeInlineAsk({
    ticket: ticket!,
    kind: ask.kind,
    argvHash: ask.argvHash,
    contentHash: ask.contentHash,
    verb: "youtrack note",
    session: "pi-session",
  });
  expect(used.ok).toBe(true);
});

test("Given Pi's TUI, When the user rejects or dismisses, Then the call is blocked and runs unchanged never", async () => {
  writeFileSync(path.join(base, "note.md"), NOTE);
  for (const answer of ["Reject", undefined]) {
    const { result, command } = await call(COMMAND, ctx("tui", answer));
    expect(result, String(answer)).toMatchObject({
      block: true,
      reason: expect.stringContaining("nothing was posted"),
    });
    expect(command).toBe(COMMAND);
  }
  // A rejected or dismissed dialog leaves no ask row, so nothing can be replayed (#864).
  expect(existsSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "inline"))).toBe(false);
});

test("Given Pi print mode, When the call runs, Then no dialog shows and no ticket is added", async () => {
  writeFileSync(path.join(base, "note.md"), NOTE);
  const shown: string[] = [];
  const { command } = await call(COMMAND, ctx("print", "Approve once", shown));
  expect(shown).toEqual([]);
  expect(command).toBe(COMMAND);
});

test("Given a wrapped YouTrack write in Pi, When it is called, Then it is blocked naming the plain call", async () => {
  const { result } = await call(`${COMMAND} | tail -3`, ctx("tui", "Approve once"));
  expect(result).toMatchObject({
    block: true,
    reason: expect.stringContaining(`Run \`${COMMAND}\` as its own call`),
  });
});
