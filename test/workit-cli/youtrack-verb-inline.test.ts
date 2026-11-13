// #864: a YouTrack write is approved on the action itself. Claude Code's
// PreToolUse asks on `workit youtrack …` with the full text (auto mode
// counts), and the verb, run with the ticket the hook put on that one call,
// posts in the same call. A yes never travels to another call: a rejected
// prompt's row is useless to a script, a second run, a changed file or a
// later ask. Hook payloads are shaped like Claude Code 2.1.323's.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run, type YouTrackDeps } from "@/packages/workit-cli/src/verbs/youtrack";
import { recordInlineAsk } from "@/packages/workit-core/src/approvals/store";
import { youTrackAsk } from "@/packages/workit-core/src/approvals/youtrack-ask";
import type {
  WriteResult,
  YouTrackBackend,
} from "@/packages/workit-core/src/core/youtrack-backend";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

let dir = "";
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
};
let stateRun = 0;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-yt-inline-")));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", timezone: "UTC" }),
  );
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  // A config redirect: youtrack.writes reads as ask, the default.
  mkdirSync(path.join(dir, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(dir, "config");
});
beforeEach(() => {
  stateRun += 1;
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${stateRun}`);
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

let posts: string[] = [];
const backend = (): YouTrackBackend => {
  const comments: { id: string; text: string }[] = [];
  const done = (text: string): WriteResult => {
    posts.push(text);
    comments.push({ id: `c-${comments.length + 1}`, text });
    return { ok: true, data: { id: String(comments.length) } };
  };
  return {
    kind: "ytrack",
    showIssue: async () => ({ ok: false, code: "failed", error: "not used" }),
    createIssue: async () => ({
      ok: true,
      data: { issueId: "ABC-9", url: null, source: "ytrack" },
    }),
    addComment: async (_issue, text) => done(text),
    addWorkItem: async (_issue, item) => done(`work ${item.minutes}`),
    texts: async () => ({ texts: comments.map((one) => one.text), complete: true }),
    ownEntries: async () => [],
    attachFiles: async () => ({ ok: true, data: {} }),
    applyCommand: async () => ({ ok: true, data: {} }),
    supports: () => "ok",
  };
};
const ASK: YouTrackDeps = { writes: () => "ask" };

/** The verb as the shell runs it: `env` holds what the command's prefix set. */
const verb = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const io: Io = {
    json: false,
    cwd: dir,
    env: { CLAUDECODE: "1", ...env },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stdout += text),
  };
  const yt = backend();
  const code = await run(argv, io, () => yt, ASK);
  return { code, stdout };
};

/** A recorded Claude Code PreToolUse payload for a Bash call. */
const payload = (command: string, mode = "auto") => ({
  session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
  transcript_path: path.join(dir, "transcript.jsonl"),
  cwd: dir,
  permission_mode: mode,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "Post the progress note to YouTrack" },
  tool_use_id: "toolu_01PMiHjoK931ujj44BvCpRHZ",
});

type Out = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: { command: string; description?: string };
};
const pre = (
  command: string,
  mode = "auto",
  env: NodeJS.ProcessEnv = { CLAUDE_CODE_ENTRYPOINT: "cli" },
) =>
  (dispatchHook(claudeCodeAdapter, payload(command, mode), env).json.hookSpecificOutput ??
    {}) as Out;

/** The env prefix the host runs the call with, and the command after it. */
const prefixOf = (out: Out): { name: string; value: string; rest: string } => {
  const match = /^(\w+)=('[^']*'|\S+) (.*)$/su.exec(out.updatedInput?.command ?? "");
  expect(match).not.toBeNull();
  const [, name, value, rest] = match!;
  return { name, value: value.replace(/^'|'$/gu, ""), rest };
};

const NOTE = "Progress on ABC-1:\n- parser done\n- tests green";
const command = "workit youtrack note ABC-1 --file note.md";
const argv = ["note", "ABC-1", "--file", "note.md"];
const requests = (): string[] => {
  try {
    return readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "requests"));
  } catch {
    return [];
  }
};

test("Given Claude Code in auto mode and workit youtrack note X --file f, When the hook runs, Then it asks with the full comment and the call posts once with no workit approve and no ap_ id", async () => {
  posts = [];
  writeFileSync(path.join(dir, "note.md"), NOTE);
  const out = pre(command);
  expect(out.permissionDecision).toBe("ask");
  for (const line of NOTE.split("\n")) expect(out.permissionDecisionReason).toContain(line);
  expect(out.permissionDecisionReason).not.toMatch(/ap_[a-z2-7]{8}|workit approve/u);
  const prefix = prefixOf(out);
  expect(prefix.name).toBe("WORKIT_APPROVAL_TICKET");
  expect(prefix.rest).toBe(command);
  expect(out.updatedInput?.description).toBe("Post the progress note to YouTrack");

  const ran = await verb(argv, { WORKIT_APPROVAL_TICKET: prefix.value });
  expect(ran.code).toBe(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("parser done");
  expect(ran.stdout).not.toMatch(/ap_[a-z2-7]{8}|workit approve/u);
  expect(requests()).toEqual([]);
});

test("Given bypassPermissions or an SDK entrypoint, When the call runs, Then nothing is approved and the verb refuses naming the mode", async () => {
  posts = [];
  writeFileSync(path.join(dir, "note.md"), NOTE);
  for (const [mode, env, named] of [
    ["bypassPermissions", { CLAUDE_CODE_ENTRYPOINT: "cli" }, "bypassPermissions mode"],
    ["dontAsk", { CLAUDE_CODE_ENTRYPOINT: "cli" }, "dontAsk mode"],
    ["default", { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, "the sdk-ts entrypoint"],
  ] as const) {
    const out = pre(command, mode, env);
    expect(out.permissionDecision, mode).toBeUndefined();
    const prefix = prefixOf(out);
    expect(prefix.name, mode).toBe("WORKIT_APPROVAL_UNASKED");
    const ran = await verb(argv, { WORKIT_APPROVAL_UNASKED: prefix.value });
    expect(ran.code, mode).toBe(3);
    expect(ran.stdout, mode).toContain(named);
    expect(ran.stdout, mode).toContain("nothing was posted");
  }
  expect(posts).toEqual([]);
  expect(
    readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals")).includes("inline"),
  ).toBe(false);
});

test("Given an ask the user rejected, When the same verb runs through a path the hook did not ask on, Then it does not post", async () => {
  posts = [];
  writeFileSync(path.join(dir, "note.md"), NOTE);
  // The prompt showed and the user said no: the call with the ticket never ran.
  const rejected = prefixOf(pre(command));
  // A script or bash -c runs the verb with no ticket: the asked row is useless to it.
  const script = await verb(argv);
  expect(script.code).toBe(3);
  expect(script.stdout).toContain("approval_needed");
  // A forged ticket (say, read from the asked row's file name) is not the ticket.
  const files = readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "inline"));
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain(rejected.value);
  expect((await verb(argv, { WORKIT_APPROVAL_TICKET: "A".repeat(32) })).code).toBe(3);
  // The rejected ticket on another call, or on the same call with the file changed.
  expect(
    (await verb(["note", "ABC-2", "--file", "note.md"], { WORKIT_APPROVAL_TICKET: rejected.value }))
      .stdout,
  ).toContain("another call");
  writeFileSync(path.join(dir, "note.md"), `${NOTE}\n- and one more line`);
  expect((await verb(argv, { WORKIT_APPROVAL_TICKET: rejected.value })).stdout).toContain(
    "changed",
  );
  writeFileSync(path.join(dir, "note.md"), NOTE);
  // A new ask for the same call closes the rejected one.
  const next = prefixOf(pre(command));
  expect((await verb(argv, { WORKIT_APPROVAL_TICKET: rejected.value })).stdout).toContain(
    "approval_not_bound",
  );
  expect(posts).toEqual([]);
  // The new yes posts once; a second run with the same ticket does not.
  expect((await verb(argv, { WORKIT_APPROVAL_TICKET: next.value })).code).toBe(0);
  posts = [];
  const twice = await verb(["note", "ABC-1", "--file", "note.md"], {
    WORKIT_APPROVAL_TICKET: next.value,
  });
  expect(twice.stdout).toContain("approval_not_bound");
  expect(posts).toEqual([]);
});

test("Given an ask past its lifetime, When the call runs with its ticket, Then it does not post", async () => {
  posts = [];
  writeFileSync(path.join(dir, "note.md"), NOTE);
  const ask = youTrackAsk(argv, dir)!;
  const { ticket } = recordInlineAsk(
    {
      kind: ask.kind,
      argvHash: ask.argvHash,
      contentHash: ask.contentHash,
      host: "claude_code",
      session: "s",
      toolUseId: "toolu_1",
    },
    new Date(Date.now() - 11 * 60_000),
  );
  const ran = await verb(argv, { WORKIT_APPROVAL_TICKET: ticket });
  expect(ran.code).toBe(3);
  expect(ran.stdout).toContain("expired");
  expect(posts).toEqual([]);
});

test("Given the same comment refused twice, When the requests are listed, Then there is exactly one request for that text", async () => {
  writeFileSync(path.join(dir, "note.md"), NOTE);
  const first = await verb(argv, { CLAUDECODE: "" });
  const second = await verb(argv, { CLAUDECODE: "" });
  expect(first.code).toBe(3);
  expect(second.code).toBe(3);
  expect(requests()).toHaveLength(1);
});

test("Given a host with no native ask (OpenCode, Codex, Cursor), When a YouTrack write is refused, Then the line is one short terminal command, with an id only when several requests wait", async () => {
  writeFileSync(path.join(dir, "note.md"), NOTE);
  const one = await verb(argv, { CLAUDECODE: "", OPENCODE: "1" });
  expect(one.code).toBe(3);
  expect(one.stdout).toContain("`workit approve` in a terminal");
  expect(one.stdout).not.toMatch(/ap_[a-z2-7]{8}/u);
  const other = await verb(["time", "ABC-1", "--minutes", "30"], { CLAUDECODE: "", OPENCODE: "1" });
  expect(other.stdout).toMatch(/`workit approve ap_[a-z2-7]{8}` in a terminal/u);
});

test("Given Claude Code ran the verb with no ticket (a script, bash -c), When it is refused, Then it names the plain call that makes the host ask", async () => {
  writeFileSync(path.join(dir, "note.md"), NOTE);
  const out = await verb(argv);
  expect(out.stdout).toContain("run it as its own call");
});
