import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/youtrack";

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
  const token = path.join(dir, "youtrack.token");
  writeFileSync(token, "test-token\n");
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
    env: { WORKIT_YT_WRITE: "1" },
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

test("Given --date auto, When the same time entry is retried, Then the marker ignores the day and nothing is posted twice", async () => {
  const server = fakeYouTrack(() => false);
  const args = ["time", "ABC-3", "--minutes", "10", "--text", "standup"];
  await call(args);
  const retry = await call([...args, "--date", "auto"]);
  expect(retry.json().data.steps).toEqual([{ step: "time", status: "already_done" }]);
  expect(server.workItems).toHaveLength(1);
});

// `workit youtrack show|create` (#263): agents read and create issues through
// Workit (ytrack, else the built-in client) instead of the token file.

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

test("Given no ytrack, When workit youtrack show runs with --json, Then it prints the issue from the server and never the token", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    urls.push(String(input));
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer test-token",
    );
    return new Response(
      JSON.stringify({
        idReadable: "ABC-4",
        summary: "Flaky upload",
        description: "Fails 1 in 10",
        customFields: [{ name: "State", value: { name: "Open" } }],
        comments: [{ id: "1", text: "seen", author: { login: "jdoe" }, created: 0 }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const out = await callWith(["show", "ABC-4", "--json"], {});
  expect(out.code).toBe(0);
  expect(urls).toHaveLength(1);
  expect(out.json().data).toMatchObject({
    issueId: "ABC-4",
    summary: "Flaky upload",
    state: "Open",
    fields: [{ name: "State", value: "Open" }],
    comments: [{ id: "1", text: "seen", author: "jdoe" }],
    source: "builtin",
  });
  expect(out.stdout).not.toContain("test-token");
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

test("Given WORKIT_YT_WRITE=1 and no ytrack, When workit youtrack create runs, Then the issue is created on the server", async () => {
  const posts: unknown[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ idReadable: "ABC-9" }), { status: 200 });
    }
    expect(String(input)).toContain("/api/admin/projects");
    return new Response(JSON.stringify([{ id: "0-3", shortName: "ABC", name: "Alpha" }]), {
      status: 200,
    });
  }) as typeof fetch;
  const out = await callWith(
    ["create", "--project", "ABC", "--summary", "New", "--description", "Body"],
    { WORKIT_YT_WRITE: "1" },
  );
  expect(out.code).toBe(0);
  expect(posts).toEqual([{ project: { id: "0-3" }, summary: "New", description: "Body" }]);
  expect(out.json().data).toEqual({
    issueId: "ABC-9",
    url: `${BASE}/issue/ABC-9`,
    source: "builtin",
  });
});

test.skipIf(process.platform === "win32")(
  "Given ytrack on PATH, When workit youtrack show runs, Then ytrack answers and the built-in client is not called",
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
      throw new Error("the built-in client must not be called");
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
