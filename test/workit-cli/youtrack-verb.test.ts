import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/youtrack";

// `workit youtrack` (S16 review M4): every write carries a deterministic
// marker and is read back, so a retry after a lost response never duplicates.

const BASE = "https://yt.example.test";
let dir = "";
const saved = {
  WORKFLOW_YOUTRACK_CONFIG: process.env.WORKFLOW_YOUTRACK_CONFIG,
  WORKFLOW_YT_WRITE: process.env.WORKFLOW_YT_WRITE,
};
const realFetch = globalThis.fetch;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wk-yt-verb-"));
  const token = path.join(dir, "youtrack.token");
  writeFileSync(token, "test-token\n");
  chmodSync(token, 0o600);
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: BASE, tokenFile: token, timezone: "UTC" }),
  );
  process.env.WORKFLOW_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  process.env.WORKFLOW_YT_WRITE = "1";
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

/** A YouTrack issue whose POSTs apply on the server; `dropResponse` loses the reply. */
const fakeYouTrack = (dropResponse: () => boolean) => {
  const comments: { id: string; text: string }[] = [];
  const workItems: { id: string; text: string }[] = [];
  const posts: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const list = url.includes("/comments") ? comments : workItems;
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(url);
      list.push({ id: `${list.length + 1}`, text: body.text });
      if (dropResponse()) throw new Error("socket hang up (timeout)");
      return new Response(JSON.stringify({ id: `${list.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify(list), { status: 200 });
  }) as typeof fetch;
  return { comments, workItems, posts };
};

const call = async (argv: string[]) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io);
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
