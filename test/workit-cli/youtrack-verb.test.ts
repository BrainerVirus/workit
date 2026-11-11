import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run, type YouTrackDeps } from "@/packages/workit-cli/src/verbs/youtrack";
import { recordApprovalGrant } from "@/packages/workit-core/src/approvals/store";
import type {
  WriteResult,
  YouTrackBackend,
} from "@/packages/workit-core/src/core/youtrack-backend";

// `workit youtrack` (S16 review M4): every write carries a deterministic
// marker and is read back, so a retry after a lost response never duplicates.

const BASE = "https://yt.example.test";
let dir = "";
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_YT_WRITE: process.env.WORKIT_YT_WRITE,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
};
let stateRun = 0;
// Each test gets its own approvals registry and pending-write journal.
beforeEach(() => {
  stateRun += 1;
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${stateRun}`);
});
const realFetch = globalThis.fetch;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wk-yt-verb-"));
  // A leftover legacy token file and key: Workit must never read or send either.
  const token = path.join(dir, "youtrack.token");
  writeFileSync(token, "legacy-test-token\n");
  chmodSync(token, 0o600);
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: BASE, tokenFile: token, timezone: "UTC" }),
  );
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  process.env.WORKIT_YT_WRITE = "1";
  // No workspace covers the test dir: the default (ask) applies unless a test passes auto.
  mkdirSync(path.join(dir, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(dir, "config");
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An in-memory YouTrack behind the backend seam; `dropResponse` loses a write's reply after it applied. */
let current: YouTrackBackend;
type Entry = { id: string; text: string; minutes?: number; date?: string };
/** Every entry is the current user's; `crash` makes a write land and then kill the call. */
const fakeYouTrack = (dropResponse: () => boolean, crash: () => boolean = () => false) => {
  const comments: Entry[] = [];
  const workItems: Entry[] = [];
  const posts: string[] = [];
  const write = (list: Entry[], kind: string, entry: Omit<Entry, "id">): WriteResult => {
    posts.push(kind);
    list.push({ id: `${kind}-${list.length + 1}`, ...entry });
    if (crash()) throw new Error("interrupted");
    if (dropResponse())
      return {
        ok: false,
        error: "socket hang up (timeout)",
        outcome: "unknown",
      };
    return { ok: true, data: { id: `${list.length}` } };
  };
  current = {
    kind: "ytrack",
    showIssue: async () => ({ ok: false, code: "failed", error: "not used" }),
    createIssue: async () => ({
      ok: true,
      data: { issueId: "ABC-99", url: null, source: "ytrack" },
    }),
    addComment: async (_issueId, text) => write(comments, "comment", { text }),
    addWorkItem: async (_issueId, item) =>
      write(workItems, "workItem", {
        text: item.text,
        minutes: item.minutes,
        date: new Date(item.dateMs).toISOString().slice(0, 10),
      }),
    texts: async (_issueId, where) => ({
      texts: (where === "comments" ? comments : workItems).map((item) => item.text),
      complete: true,
    }),
    ownEntries: async (_issueId, where) => (where === "comments" ? comments : workItems),
  };
  return { comments, workItems, posts };
};

const AUTO: YouTrackDeps = { writes: () => "auto" };
const ASK: YouTrackDeps = { writes: () => "ask" };

const call = async (argv: string[], deps: YouTrackDeps = AUTO, env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env: { WORKIT_YT_WRITE: "1", ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io, () => current, deps);
  return { code, json: () => JSON.parse(stdout) };
};

test("Given a note whose comment POST applied but timed out, When it is retried, Then the read-back settles it and nothing is posted twice", async () => {
  let drop = true;
  const server = fakeYouTrack(() => drop);
  const first = await call(["note", "ABC-1", "--markdown", "Progress", "--minutes", "30"]);
  expect(first.code).toBe(0);
  expect(first.json().data.steps).toEqual([
    { step: "comment", status: "settled" },
    { step: "time", status: "settled" },
  ]);
  drop = false;
  const retry = await call(["note", "ABC-1", "--markdown", "Progress", "--minutes", "30"]);
  expect(retry.code).toBe(0);
  expect(retry.json().data.steps).toEqual([
    { step: "comment", status: "already_done" },
    { step: "time", status: "already_done" },
  ]);
  expect(server.posts).toHaveLength(2);
  expect(server.comments).toHaveLength(1);
  expect(server.comments[0].text).toMatch(/Progress\n\n<!-- workit-action:[0-9a-f]{64} -->$/);
  expect(server.workItems).toHaveLength(1);
});

test("Given a logged time entry, When the same time command runs again, Then it is skipped as already done", async () => {
  const server = fakeYouTrack(() => false);
  const args = ["time", "ABC-2", "--minutes", "15", "--text", "review", "--date", "2026-10-03"];
  expect((await call(args)).json().data.steps).toEqual([{ step: "time", status: "done" }]);
  expect((await call(args)).json().data.steps).toEqual([{ step: "time", status: "already_done" }]);
  expect(server.workItems).toHaveLength(1);
  // A different entry (other minutes) is a different marker and is written.
  await call(["time", "ABC-2", "--minutes", "20", "--text", "review", "--date", "2026-10-03"]);
  expect(server.workItems).toHaveLength(2);
});

test("Given --date auto, When the same time entry is retried, Then the marker ignores the day and nothing is posted twice", async () => {
  const server = fakeYouTrack(() => false);
  const args = ["time", "ABC-3", "--minutes", "10", "--text", "standup"];
  await call(args);
  const retry = await call([...args, "--date", "auto"]);
  expect(retry.json().data.steps).toEqual([{ step: "time", status: "already_done" }]);
  expect(server.workItems).toHaveLength(1);
});

// `workit youtrack show|create` (#263): agents read and create issues through
// Workit and ytrack; there is no token-file client to fall back to.

const callWith = async (argv: string[], env: NodeJS.ProcessEnv, deps: YouTrackDeps = AUTO) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io, undefined, deps);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

/** A PATH without ytrack, and a fetch that fails the test if anything calls YouTrack directly. */
const noYtrack = (): NodeJS.ProcessEnv => {
  const empty = path.join(dir, "no-ytrack");
  mkdirSync(empty, { recursive: true });
  globalThis.fetch = (async () => {
    throw new Error("Workit must not call YouTrack without ytrack");
  }) as unknown as typeof fetch;
  return { PATH: empty };
};

test("Given no ytrack, When workit youtrack show runs, Then it fails naming the ytrack install and the host login, and no token is read or sent", async () => {
  const out = await callWith(["show", "ABC-4", "--json"], noYtrack());
  expect(out.code).not.toBe(0);
  const body = out.json();
  expect(body.error).toContain("ytrack is not on PATH");
  expect(body.unblock).toContain("https://github.com/BrainerVirus/youtrack-cli");
  expect(body.unblock).toContain("ytrack auth login --host yt.example.test");
  expect(out.stdout).not.toContain("legacy-test-token");
});

test("Given writes: auto and no WORKIT_YT_WRITE, When workit youtrack create runs, Then it is refused naming the gate and nothing is sent", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    posts.push(String(input));
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const out = await callWith(["create", "--project", "ABC", "--summary", "New"], {});
  expect(out.code).toBe(3);
  expect(out.json().error).toContain("WORKIT_YT_WRITE=1");
  expect(posts).toHaveLength(0);
});

test("Given WORKIT_YT_WRITE=1 and no ytrack, When workit youtrack create or note runs, Then nothing is sent and the unblock names the ytrack install", async () => {
  const env = { ...noYtrack(), WORKIT_YT_WRITE: "1" };
  const created = await callWith(["create", "--project", "ABC", "--summary", "New"], env);
  expect(created.code).not.toBe(0);
  expect(created.json().unblock).toContain("https://github.com/BrainerVirus/youtrack-cli");
  const note = await callWith(["note", "ABC-1", "--markdown", "Hi"], env);
  expect(note.code).not.toBe(0);
  expect(note.json().unblock).toContain("ytrack auth login --host yt.example.test");
  expect(note.json().data.steps).toEqual([{ step: "comment", status: "failed" }]);
});

test.skipIf(process.platform === "win32")(
  "Given ytrack on PATH, When workit youtrack show runs, Then ytrack answers and nothing else is called",
  async () => {
    const bin = path.join(dir, "ytrack-bin");
    mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, "ytrack");
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '{"idReadable":"ABC-6","summary":"Via ytrack","state":"Fixed","customFields":[],"comments":[]}'\n`,
    );
    chmodSync(stub, 0o755);
    globalThis.fetch = (async () => {
      throw new Error("Workit must not call YouTrack directly");
    }) as unknown as typeof fetch;
    const out = await callWith(["show", "ABC-6"], { PATH: bin });
    expect(out.code).toBe(0);
    expect(out.json().data).toMatchObject({
      issueId: "ABC-6",
      summary: "Via ytrack",
      state: "Fixed",
      source: "ytrack",
    });
  },
);

test("Given writes: auto and no WORKIT_YT_WRITE, When workit youtrack note runs, Then it is refused naming the gate and nothing is read or sent", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    urls.push(String(input));
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const out = await callWith(["note", "ABC-1", "--markdown", "Hi"], {});
  expect(out.code).toBe(3);
  expect(out.json().error).toContain("WORKIT_YT_WRITE=1");
  expect(urls).toHaveLength(0);
});

// #780: every write asks the user first by default, through the approval
// channel; an identical entry is refused; an interrupted write is reported.

const requests = (): string[] => {
  try {
    return readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "requests")).map(
      (name) => name.replace(/\.json$/, ""),
    );
  } catch {
    return [];
  }
};

/** The user's yes at their own terminal (`workit approve <id>`, via: terminal). */
const userApproves = (id: string) => {
  const granted = recordApprovalGrant({
    id,
    host: "terminal",
    session: null,
    toolUseId: null,
    via: "terminal",
  });
  expect(granted.ok).toBe(true);
};

test("Given the default, When the agent runs workit youtrack time X-1 --minutes 30, Then a request is recorded and nothing is posted until the user approves; the re-run posts once", async () => {
  const server = fakeYouTrack(() => false);
  const args = ["time", "X-1", "--minutes", "30"];
  // No WORKIT_YT_WRITE: the user's yes is the gate in ask mode.
  const first = await call(args, ASK, { WORKIT_YT_WRITE: "" });
  expect(first.code).toBe(3);
  const refusal = first.json();
  expect(refusal.data).toMatchObject({
    reason: "approval_needed",
    posted: false,
  });
  expect(refusal.error).toContain(`approve: run \`workit approve ${refusal.data.approval}\` now`);
  expect(requests()).toEqual([refusal.data.approval]);
  expect(server.posts).toHaveLength(0);
  // Asking again without a yes still posts nothing.
  expect((await call(args, ASK)).code).toBe(3);
  expect(server.posts).toHaveLength(0);

  userApproves(refusal.data.approval);
  const posted = await call(args, ASK);
  expect(posted.code).toBe(0);
  expect(posted.json().data.steps).toEqual([{ step: "time", status: "done" }]);
  expect(server.workItems).toHaveLength(1);

  // The same command again: the marker shows it landed, so nothing is asked or posted.
  const again = await call(args, ASK);
  expect(again.code).toBe(0);
  expect(again.json().data.steps).toEqual([{ step: "time", status: "already_done" }]);
  expect(server.posts).toHaveLength(1);
});

test("Given an approved write, When the agent changes the minutes, Then the yes does not cover it and a new request is written", async () => {
  const server = fakeYouTrack(() => false);
  const first = await call(["time", "X-2", "--minutes", "30"], ASK);
  userApproves(first.json().data.approval);
  const changed = await call(["time", "X-2", "--minutes", "45"], ASK);
  expect(changed.code).toBe(3);
  expect(changed.json().data.reason).toBe("approval_stale");
  expect(changed.json().data.approval).not.toBe(first.json().data.approval);
  expect(server.posts).toHaveLength(0);
});

test("Given a yes used by a run whose write did not land, When the agent re-runs, Then it gets a new request to approve and posts nothing", async () => {
  const server = fakeYouTrack(() => false);
  current.addWorkItem = async () => ({
    ok: false,
    error: "logged out",
    outcome: "not_applied",
  });
  const args = ["time", "X-3", "--minutes", "30"];
  userApproves((await call(args, ASK)).json().data.approval);
  expect((await call(args, ASK)).code).not.toBe(0);
  const retry = await call(args, ASK);
  expect(retry.code).toBe(3);
  expect(retry.json().data.reason).toBe("approval_consumed");
  expect(retry.json().error).toContain(`workit approve ${retry.json().data.approval}`);
  expect(server.posts).toHaveLength(0);
});

test("Given an identical work item by the same user, When the same time is logged, Then it is refused with duplicate_entry and the entry id, before any ask", async () => {
  const server = fakeYouTrack(() => false);
  server.workItems.push({
    id: "115-3",
    text: "review",
    minutes: 30,
    date: "2026-10-03",
  });
  const out = await call(
    ["time", "ABC-7", "--minutes", "30", "--text", "review", "--date", "2026-10-03"],
    ASK,
  );
  expect(out.code).toBe(3);
  expect(out.json().error).toStartWith("duplicate_entry: ABC-7 already has your work item 115-3");
  expect(out.json().data).toMatchObject({
    reason: "duplicate_entry",
    entryId: "115-3",
  });
  expect(requests()).toEqual([]);
  expect(server.posts).toHaveLength(0);
  // Other minutes are a different entry.
  const other = await call(
    ["time", "ABC-7", "--minutes", "45", "--text", "review", "--date", "2026-10-03"],
    AUTO,
  );
  expect(other.code).toBe(0);
});

test("Given an identical comment by the same user, When the note is posted again, Then it is refused with duplicate_entry in auto mode too", async () => {
  const server = fakeYouTrack(() => false);
  server.comments.push({ id: "4-17", text: "Deployed to staging" });
  const out = await call(["note", "ABC-8", "--markdown", "Deployed to staging\n"], AUTO);
  expect(out.code).toBe(3);
  expect(out.json().data).toMatchObject({
    reason: "duplicate_entry",
    entryId: "4-17",
  });
  expect(server.posts).toHaveLength(0);
});

test("Given a call interrupted after its write landed, When the next call runs, Then it reports that the earlier write landed", async () => {
  let crash = true;
  const server = fakeYouTrack(
    () => false,
    () => crash,
  );
  await expect(call(["time", "ABC-9", "--minutes", "20", "--text", "fix"], AUTO)).rejects.toThrow(
    "interrupted",
  );
  crash = false;
  const next = await call(["note", "ABC-10", "--markdown", "Unrelated"], AUTO);
  expect(next.code).toBe(0);
  expect(next.json().data.earlier).toEqual([
    expect.objectContaining({ issueId: "ABC-9", step: "time", landed: true }),
  ]);
  // Settled once: the call after that has nothing to report.
  const later = await call(["note", "ABC-11", "--markdown", "Later"], AUTO);
  expect(later.json().data.earlier).toEqual([]);
  expect(server.workItems).toHaveLength(1);
});

test("Given a call killed before its write landed, When the next call runs, Then it reports that the earlier write did not land", async () => {
  fakeYouTrack(() => false);
  const landed = current.addWorkItem;
  current.addWorkItem = async () => {
    throw new Error("killed before sending");
  };
  await expect(call(["time", "ABC-12", "--minutes", "20"], AUTO)).rejects.toThrow("killed");
  current.addWorkItem = landed;
  const next = await call(["note", "ABC-13", "--markdown", "Hi"], AUTO);
  expect(next.json().data.earlier).toEqual([
    expect.objectContaining({ issueId: "ABC-12", landed: false }),
  ]);
});

test("Given the default, When workit youtrack create runs, Then it asks first and creates the issue only after the yes", async () => {
  fakeYouTrack(() => false);
  let created = 0;
  const create = current.createIssue;
  current.createIssue = async (input) => {
    created += 1;
    return create(input);
  };
  const args = ["create", "--project", "ABC", "--summary", "New"];
  const first = await call(args, ASK);
  expect(first.code).toBe(3);
  expect(created).toBe(0);
  userApproves(first.json().data.approval);
  expect((await call(args, ASK)).code).toBe(0);
  expect(created).toBe(1);
});
