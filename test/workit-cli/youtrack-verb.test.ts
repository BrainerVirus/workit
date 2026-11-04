import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/youtrack";
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
};
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
const fakeYouTrack = (dropResponse: () => boolean) => {
  const comments: { id: string; text: string }[] = [];
  const workItems: { id: string; text: string }[] = [];
  const posts: string[] = [];
  const write = (list: typeof comments, kind: string, text: string): WriteResult => {
    posts.push(kind);
    list.push({ id: `${list.length + 1}`, text });
    if (dropResponse()) return { ok: false, error: "socket hang up (timeout)", outcome: "unknown" };
    return { ok: true, data: { id: `${list.length}` } };
  };
  current = {
    kind: "ytrack",
    showIssue: async () => ({ ok: false, code: "failed", error: "not used" }),
    createIssue: async () => ({ ok: false, code: "failed", error: "not used" }),
    addComment: async (_issueId, text) => write(comments, "comment", text),
    addWorkItem: async (_issueId, item) => write(workItems, "workItem", item.text),
    texts: async (_issueId, where) => ({
      texts: (where === "comments" ? comments : workItems).map((item) => item.text),
      complete: true,
    }),
  };
  return { comments, workItems, posts };
};

const call = async (argv: string[]) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env: { WORKIT_YT_WRITE: "1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io, () => current);
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

const callWith = async (argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io);
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

test("Given no WORKIT_YT_WRITE, When workit youtrack create runs, Then it is refused naming the gate and nothing is sent", async () => {
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

test("Given no WORKIT_YT_WRITE, When workit youtrack note runs, Then it is refused naming the gate and nothing is read or sent", async () => {
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
