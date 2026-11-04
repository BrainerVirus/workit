import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  builtinBackend,
  youTrackBackend,
  youTrackWriteGate,
} from "@/packages/workit-core/src/core/youtrack-backend";
import {
  writeOnce,
  withMarker,
  youTrackMarker,
} from "@/packages/workit-core/src/core/youtrack-writes";
import { ytrackRunner, ytrackStatus } from "@/packages/workit-core/src/core/youtrack-ytrack";

// The YouTrack backend seam (#263): ytrack --json when it is on PATH, the
// token-file client only when it is missing. ytrack is a recorded stub on a
// temp PATH; no real YouTrack is called.

const BASE = "https://yt.example.test";
const TOKEN = "perm:secret-token";
let dir = "";
let stub = "";
const savedConfig = process.env.WORKIT_YOUTRACK_CONFIG;

/** A recorded ytrack: answers `<a>-<b>.json` / `.exit` / `.err` for `ytrack <a> <b> …`. */
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
if [ -n "$YTRACK_TOKEN" ]; then echo TOKEN-IN-ENV >> "$STUB_DIR/calls"; fi
key="$1-$2"
cat > "$STUB_DIR/$key.stdin"
printf '%s\\n' "$YTRACK_HOST" > "$STUB_DIR/host"
if [ -f "$STUB_DIR/$key.json" ]; then cat "$STUB_DIR/$key.json"; fi
if [ -f "$STUB_DIR/$key.err" ]; then cat "$STUB_DIR/$key.err" >&2; fi
if [ -f "$STUB_DIR/$key.exit" ]; then exit "$(cat "$STUB_DIR/$key.exit")"; fi
exit 0
`;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wk-yt-backend-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ytrack"), STUB);
  chmodSync(path.join(bin, "ytrack"), 0o755);
  // tokenFile names a file that does not exist: the ytrack path must not need it.
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: `${BASE}/`, tokenFile: path.join(dir, "absent.token") }),
  );
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.WORKIT_YOUTRACK_CONFIG;
  else process.env.WORKIT_YOUTRACK_CONFIG = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  stub = mkdtempSync(path.join(dir, "rec-"));
});

const env = (): NodeJS.ProcessEnv => ({
  PATH: [path.join(dir, "bin"), "/usr/bin", "/bin"].join(path.delimiter),
  STUB_DIR: stub,
});
const answerRaw = (key: string, stdout: string, exit = 0, err = "") => {
  writeFileSync(path.join(stub, `${key}.json`), stdout);
  if (exit) writeFileSync(path.join(stub, `${key}.exit`), String(exit));
  if (err) writeFileSync(path.join(stub, `${key}.err`), err);
};
const answer = (key: string, json: unknown, exit = 0, err = "") =>
  answerRaw(key, JSON.stringify(json), exit, err);
const calls = (): string[] =>
  existsSync(path.join(stub, "calls"))
    ? readFileSync(path.join(stub, "calls"), "utf8").trim().split("\n")
    : [];
const stdin = (key: string) => readFileSync(path.join(stub, `${key}.stdin`), "utf8");

const YTRACK_ISSUE = {
  idReadable: "ABC-1",
  summary: "Crash on start",
  description: "Steps",
  state: "Open",
  url: `${BASE}/issue/ABC-1`,
  customFields: [
    { name: "State", kind: "state", value: "Open" },
    { name: "Assignee", kind: "user", value: { login: "jdoe", fullName: "J Doe" } },
    { name: "Tags", kind: "enum", value: ["a", "b"] },
  ],
  comments: [
    {
      id: "4-1",
      text: "Reproduced",
      author: { login: "jroe", fullName: "J Roe" },
      created: "2026-10-01T10:00:00Z",
    },
  ],
};

describe.skipIf(process.platform === "win32")("ytrack backend (stub on PATH)", () => {
  test("Given ytrack on PATH, When the backend is chosen, Then it is ytrack aimed at youtrack.json's host with no token", async () => {
    const backend = youTrackBackend(env());
    expect(backend.kind).toBe("ytrack");
    answer("issue-view", YTRACK_ISSUE);
    await backend.showIssue("ABC-1");
    expect(readFileSync(path.join(stub, "host"), "utf8").trim()).toBe(BASE);
    expect(calls()).not.toContain("TOKEN-IN-ENV");
  });

  test("Given ytrack on PATH, When an issue is shown, Then issue view --json is parsed into one shape", async () => {
    answer("issue-view", YTRACK_ISSUE);
    const result = await youTrackBackend(env()).showIssue("ABC-1");
    expect(calls()).toEqual([
      "issue view ABC-1 --json idReadable,summary,description,state,url,customFields,comments",
    ]);
    expect(result).toEqual({
      ok: true,
      data: {
        issueId: "ABC-1",
        summary: "Crash on start",
        description: "Steps",
        state: "Open",
        url: `${BASE}/issue/ABC-1`,
        fields: [
          { name: "State", value: "Open" },
          { name: "Assignee", value: "jdoe" },
          { name: "Tags", value: ["a", "b"] },
        ],
        comments: [
          { id: "4-1", text: "Reproduced", author: "jroe", created: "2026-10-01T10:00:00Z" },
        ],
        source: "ytrack",
      },
    });
  });

  test("Given ytrack is logged out (exit 4), When an issue is shown, Then it is unavailable naming ytrack auth login", async () => {
    answer("issue-view", {}, 4, "authentication required");
    const result = await youTrackBackend(env()).showIssue("ABC-1");
    expect(result).toMatchObject({ ok: false, code: "unavailable", unblock: "ytrack auth login" });
  });

  test("Given ytrack fails (exit 1), When an issue is shown, Then the failure carries its stderr", async () => {
    answer("issue-view", {}, 1, 'issue "ABC-9" not found');
    const result = await youTrackBackend(env()).showIssue("ABC-9");
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(!result.ok && result.error).toContain("not found");
  });

  test("Given ytrack, When an issue is created, Then issue create gets the description on stdin", async () => {
    answer("issue-create", { idReadable: "ABC-7", url: `${BASE}/issue/ABC-7` });
    const result = await youTrackBackend(env()).createIssue({
      project: "ABC",
      summary: "New",
      description: "Body",
    });
    expect(calls()).toEqual([
      "issue create --project ABC --summary New --description-file - --json idReadable,url",
    ]);
    expect(stdin("issue-create")).toBe("Body");
    expect(result).toEqual({
      ok: true,
      data: { issueId: "ABC-7", url: `${BASE}/issue/ABC-7`, source: "ytrack" },
    });
  });

  test("Given ytrack, When a comment is written once, Then the marker is read back through issue view and the body goes on stdin", async () => {
    answer("issue-view", { comments: [] });
    answer("issue-comment", { id: "4-9" });
    const backend = youTrackBackend(env());
    const marker = youTrackMarker({ operation: "note", issueId: "ABC-1", markdown: "Hi" });
    const outcome = await writeOnce(
      "ABC-1",
      marker,
      "comments",
      async () => {
        const result = await backend.addComment("ABC-1", withMarker("Hi", marker));
        return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
      },
      backend,
    );
    expect(outcome.status).toBe("done");
    expect(calls()).toEqual([
      "issue view ABC-1 --json comments",
      "issue comment ABC-1 --body-file - --json id,url",
    ]);
    expect(stdin("issue-comment")).toBe(withMarker("Hi", marker));
  });

  test("Given the marker is already on the issue, When the write is retried, Then ytrack writes nothing", async () => {
    const marker = youTrackMarker({ operation: "time", issueId: "ABC-1", minutes: 5 });
    answer("work-item-list", [{ id: "1", text: withMarker("review", marker) }]);
    const outcome = await writeOnce(
      "ABC-1",
      marker,
      "workItems",
      async () => {
        throw new Error("must not write");
      },
      youTrackBackend(env()),
    );
    expect(outcome.status).toBe("already_done");
    expect(calls()).toEqual(["work-item list ABC-1 --json id,text"]);
  });

  test("Given ytrack, When a work item is added, Then minutes and the work day are passed as flags", async () => {
    answer("work-item-add", { id: "115-3" });
    const result = await youTrackBackend(env()).addWorkItem("ABC-1", {
      minutes: 90,
      text: "Code review",
      dateMs: Date.UTC(2026, 9, 6),
    });
    expect(calls()).toEqual([
      "work-item add ABC-1 --duration 90 --date 2026-10-06 --text Code review --json id,date,duration",
    ]);
    expect(result).toMatchObject({ ok: true, data: { workItemId: "115-3", minutes: 90 } });
  });

  test("Given ytrack exit 4 or 2 on a write, Then it is not_applied; exit 1 is unknown", async () => {
    const backend = youTrackBackend(env());
    answer("issue-comment", {}, 4, "authentication required");
    expect(await backend.addComment("ABC-1", "x")).toMatchObject({
      ok: false,
      outcome: "not_applied",
      unblock: "ytrack auth login",
    });
    answer("issue-comment", {}, 2);
    expect(await backend.addComment("ABC-1", "x")).toMatchObject({ outcome: "not_applied" });
    answer("issue-comment", {}, 1, "timeout");
    expect(await backend.addComment("ABC-1", "x")).toMatchObject({ outcome: "unknown" });
  });

  test("Given ytrack, When its status is read for the doctor, Then version and the active host's auth state come back without a token", () => {
    answerRaw("version-", "ytrack version 0.1.0 (2026-10-07)\ncommit abc123\n");
    answer("auth-status", [
      {
        host: "acme.youtrack.cloud",
        active: true,
        login: "jdoe",
        state: "ok",
        tokenSource: "keyring",
        error: "",
      },
    ]);
    expect(ytrackStatus(ytrackRunner(env()))).toEqual({
      installed: true,
      version: "0.1.0",
      auth: "ok",
      hosts: [
        {
          host: "acme.youtrack.cloud",
          active: true,
          login: "jdoe",
          state: "ok",
          tokenSource: "keyring",
          error: null,
        },
      ],
      error: null,
    });
    expect(calls()).toEqual([
      "version",
      "auth status --json host,active,login,state,tokenSource,error",
    ]);
  });

  test("Given ytrack is not logged in, When its status is read, Then auth is logged_out", () => {
    answer("auth-status", [], 4, "not logged in");
    expect(ytrackStatus(ytrackRunner(env()))).toMatchObject({
      installed: true,
      auth: "logged_out",
    });
  });
});

test("Given no ytrack on PATH, When the backend is chosen, Then it is the built-in client and the doctor sees ytrack missing", () => {
  const empty = path.join(dir, "empty");
  mkdirSync(empty, { recursive: true });
  expect(youTrackBackend({ PATH: empty }).kind).toBe("builtin");
  expect(ytrackStatus(ytrackRunner({ PATH: empty }))).toEqual({ installed: false });
});

// The token-file fallback, with a scripted REST server.
type Call = { url: string; method: string; body?: unknown };
function builtin(rest: (call: Call) => { status: number; stdout: string; stderr?: string }) {
  const restCalls: Call[] = [];
  const backend = builtinBackend({
    creds: () => ({ token: TOKEN, base: BASE }),
    request: async (url, init) => {
      expect(init.token).toBe(TOKEN);
      const call = { url, method: init.method, body: init.body };
      restCalls.push(call);
      const out = rest(call);
      return { status: out.status, stdout: out.stdout, stderr: out.stderr ?? "" };
    },
    api: async () => ({ data: { ok: true } }),
  });
  return { backend, restCalls };
}

test("Given the built-in client, When an issue is shown, Then REST fields are normalized and deleted comments dropped", async () => {
  const { backend, restCalls } = builtin(() => ({
    status: 0,
    stdout: JSON.stringify({
      idReadable: "ABC-2",
      summary: "Slow login",
      description: null,
      customFields: [
        { name: "State", value: { name: "In Progress" } },
        { name: "Estimation", value: { presentation: "1h 30m" } },
      ],
      comments: [
        { id: "4-2", text: "gone", author: { login: "x" }, created: 0, deleted: true },
        { id: "4-3", text: "Looking", author: { login: "jdoe" }, created: Date.UTC(2026, 9, 2) },
      ],
    }),
  }));
  const result = await backend.showIssue("ABC-2");
  expect(restCalls[0].url.startsWith(`${BASE}/api/issues/ABC-2?fields=`)).toBe(true);
  expect(result).toMatchObject({
    ok: true,
    data: {
      state: "In Progress",
      url: `${BASE}/issue/ABC-2`,
      fields: [
        { name: "State", value: "In Progress" },
        { name: "Estimation", value: "1h 30m" },
      ],
      comments: [{ id: "4-3", author: "jdoe", created: "2026-10-02T00:00:00.000Z" }],
      source: "builtin",
    },
  });
});

test("Given the built-in client and an error that echoes the token, When an issue is shown, Then the token is redacted", async () => {
  const { backend } = builtin(() => ({ status: 401, stdout: "", stderr: `bad token ${TOKEN}` }));
  const result = await backend.showIssue("ABC-2");
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(!result.ok && result.error).toContain("[REDACTED]");
});

test("Given the built-in client, When an issue is created, Then it finds the project and posts once", async () => {
  const { backend, restCalls } = builtin((call) =>
    call.method === "GET"
      ? { status: 0, stdout: JSON.stringify([{ id: "0-2", shortName: "ABC", name: "Alpha" }]) }
      : { status: 0, stdout: JSON.stringify({ idReadable: "ABC-8" }) },
  );
  const result = await backend.createIssue({ project: "abc", summary: "New" });
  expect(restCalls.filter((call) => call.method === "POST")).toEqual([
    {
      url: `${BASE}/api/issues?fields=idReadable`,
      method: "POST",
      body: { project: { id: "0-2" }, summary: "New" },
    },
  ]);
  expect(result).toEqual({
    ok: true,
    data: { issueId: "ABC-8", url: `${BASE}/issue/ABC-8`, source: "builtin" },
  });
});

test("Given the built-in client, When a full page is read back, Then a miss is not conclusive", async () => {
  const items = Array.from({ length: 500 }, (_, index) => ({ id: `${index}`, text: "x" }));
  const { backend } = builtin(() => ({ status: 0, stdout: JSON.stringify(items) }));
  expect((await backend.texts("ABC-1", "comments"))?.complete).toBe(false);
});

test("Given no WORKIT_YT_WRITE, When a write is gated, Then it is blocked naming the flag", () => {
  expect(youTrackWriteGate({})).toMatchObject({ ok: false, code: "blocked" });
  expect(youTrackWriteGate({})?.error).toContain("WORKIT_YT_WRITE=1");
  expect(youTrackWriteGate({ WORKIT_YT_WRITE: "1" })).toBeNull();
});
