import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createIssue,
  showIssue,
  ytrackRunner,
  type IssueDeps,
  type YtrackResult,
} from "@/packages/workit-core/src/core/youtrack-issue";

// `workit youtrack show|create` (#263): ytrack --json when it is installed,
// the built-in client otherwise; the token never reaches the output.

const BASE = "https://yt.example.test";
const TOKEN = "perm:secret-token";

type Call = { url: string; method: string; body?: unknown };

/** Deps with a scripted ytrack and a scripted REST server. */
function fakes(
  ytrack: (args: string[], input?: string) => YtrackResult,
  rest: (call: Call) => { status: number; stdout: string; stderr?: string } = () => ({
    status: 500,
    stdout: "",
  }),
) {
  const ytrackCalls: { args: string[]; input?: string }[] = [];
  const restCalls: Call[] = [];
  const deps: IssueDeps = {
    ytrack: (args, input) => {
      ytrackCalls.push({ args, input });
      return ytrack(args, input);
    },
    creds: () => ({ token: TOKEN, base: BASE }),
    request: async (url, init) => {
      expect(init.token).toBe(TOKEN);
      const call = { url, method: init.method, body: init.body };
      restCalls.push(call);
      const out = rest(call);
      return { status: out.status, stdout: out.stdout, stderr: out.stderr ?? "" };
    },
  };
  return { deps, ytrackCalls, restCalls };
}

const missing = (): YtrackResult => ({ status: null, stdout: "", stderr: "", missing: true });

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

test("Given ytrack is installed, When an issue is shown, Then ytrack issue view --json is used and normalized", async () => {
  const { deps, ytrackCalls, restCalls } = fakes(() => ({
    status: 0,
    stdout: JSON.stringify(YTRACK_ISSUE),
    stderr: "",
  }));
  const result = await showIssue("ABC-1", deps);
  expect(ytrackCalls[0].args.slice(0, 4)).toEqual(["issue", "view", "ABC-1", "--json"]);
  expect(ytrackCalls[0].args[4]).toContain("comments");
  expect(restCalls).toHaveLength(0);
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

const API_ISSUE = {
  idReadable: "ABC-2",
  summary: "Slow login",
  description: null,
  customFields: [
    { name: "State", value: { name: "In Progress" } },
    { name: "Estimation", value: { presentation: "1h 30m" } },
    { name: "Assignee", value: null },
  ],
  comments: [
    { id: "4-2", text: "gone", author: { login: "x" }, created: 0, deleted: true },
    { id: "4-3", text: "Looking", author: { login: "jdoe" }, created: Date.UTC(2026, 9, 2) },
  ],
};

test("Given ytrack is missing, When an issue is shown, Then the built-in client reads it and the token never appears", async () => {
  const { deps, restCalls } = fakes(missing, () => ({
    status: 0,
    stdout: JSON.stringify(API_ISSUE),
  }));
  const result = await showIssue("ABC-2", deps);
  expect(restCalls).toHaveLength(1);
  expect(restCalls[0].method).toBe("GET");
  expect(restCalls[0].url.startsWith(`${BASE}/api/issues/ABC-2?fields=`)).toBe(true);
  expect(result).toEqual({
    ok: true,
    data: {
      issueId: "ABC-2",
      summary: "Slow login",
      description: null,
      state: "In Progress",
      url: `${BASE}/issue/ABC-2`,
      fields: [
        { name: "State", value: "In Progress" },
        { name: "Estimation", value: "1h 30m" },
        { name: "Assignee", value: null },
      ],
      comments: [
        { id: "4-3", text: "Looking", author: "jdoe", created: "2026-10-02T00:00:00.000Z" },
      ],
      source: "api",
    },
  });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test("Given ytrack is logged out (exit 4), When an issue is shown, Then the built-in client takes over", async () => {
  const { deps, restCalls } = fakes(
    () => ({ status: 4, stdout: "", stderr: "authentication required" }),
    () => ({ status: 0, stdout: JSON.stringify(API_ISSUE) }),
  );
  const result = await showIssue("ABC-2", deps);
  expect(result.ok && result.data.source).toBe("api");
  expect(restCalls).toHaveLength(1);
});

test("Given ytrack fails for another reason, When an issue is shown, Then the failure is reported and the API is not called", async () => {
  const { deps, restCalls } = fakes(() => ({
    status: 1,
    stdout: "",
    stderr: 'issue "ABC-9" not found',
  }));
  const result = await showIssue("ABC-9", deps);
  expect(result).toMatchObject({ ok: false, code: "failed" });
  expect(!result.ok && result.error).toContain("not found");
  expect(restCalls).toHaveLength(0);
});

test("Given the API answers an error that echoes the token, When an issue is shown, Then the token is redacted", async () => {
  const { deps } = fakes(missing, () => ({
    status: 401,
    stdout: "",
    stderr: `bad token ${TOKEN}`,
  }));
  const result = await showIssue("ABC-2", deps);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(!result.ok && result.error).toContain("[REDACTED]");
});

test("Given no write gate, When an issue is created, Then it is refused naming WORKIT_YT_WRITE and nothing runs", async () => {
  const { deps, ytrackCalls, restCalls } = fakes(missing);
  const result = await createIssue({ project: "ABC", summary: "New" }, {}, deps);
  expect(result).toMatchObject({ ok: false, code: "blocked" });
  expect(!result.ok && result.error).toContain("WORKIT_YT_WRITE=1");
  expect(ytrackCalls).toHaveLength(0);
  expect(restCalls).toHaveLength(0);
});

test("Given the write gate and ytrack, When an issue is created, Then ytrack issue create gets the description on stdin", async () => {
  const { deps, ytrackCalls, restCalls } = fakes(() => ({
    status: 0,
    stdout: JSON.stringify({ idReadable: "ABC-7", url: `${BASE}/issue/ABC-7` }),
    stderr: "",
  }));
  const result = await createIssue(
    { project: "ABC", summary: "New", description: "Body" },
    { WORKIT_YT_WRITE: "1" },
    deps,
  );
  expect(ytrackCalls).toEqual([
    {
      args: [
        "issue",
        "create",
        "--project",
        "ABC",
        "--summary",
        "New",
        "--description-file",
        "-",
        "--json",
        "idReadable,url",
      ],
      input: "Body",
    },
  ]);
  expect(restCalls).toHaveLength(0);
  expect(result).toEqual({
    ok: true,
    data: { issueId: "ABC-7", url: `${BASE}/issue/ABC-7`, source: "ytrack" },
  });
});

test("Given the write gate and no ytrack, When an issue is created, Then the built-in client finds the project and posts once", async () => {
  const { deps, restCalls } = fakes(missing, (call) =>
    call.method === "GET"
      ? {
          status: 0,
          stdout: JSON.stringify([
            { id: "0-1", shortName: "XYZ", name: "Other" },
            { id: "0-2", shortName: "ABC", name: "Alpha" },
          ]),
        }
      : { status: 0, stdout: JSON.stringify({ idReadable: "ABC-8" }) },
  );
  const result = await createIssue(
    { project: "abc", summary: "New" },
    { WORKIT_YT_WRITE: "1" },
    deps,
  );
  expect(restCalls.filter((call) => call.method === "POST")).toEqual([
    {
      url: `${BASE}/api/issues?fields=idReadable`,
      method: "POST",
      body: { project: { id: "0-2" }, summary: "New" },
    },
  ]);
  expect(result).toEqual({
    ok: true,
    data: { issueId: "ABC-8", url: `${BASE}/issue/ABC-8`, source: "api" },
  });
});

test("Given no ytrack and no credentials, When an issue is shown, Then it is unavailable and names ytrack auth login", async () => {
  const { deps } = fakes(missing);
  const result = await showIssue("ABC-1", {
    ...deps,
    creds: () => ({ error: "missing youtrack.json" }),
  });
  expect(result).toMatchObject({ ok: false, code: "unavailable" });
  expect(!result.ok && result.unblock).toContain("ytrack auth login");
});

// The real runner: a stub `ytrack` on PATH (POSIX sh, so not on Windows).
let dir = "";
const savedConfig = process.env.WORKIT_YOUTRACK_CONFIG;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wk-ytrack-"));
  writeFileSync(path.join(dir, "youtrack.json"), JSON.stringify({ baseUrl: `${BASE}/` }));
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.WORKIT_YOUTRACK_CONFIG;
  else process.env.WORKIT_YOUTRACK_CONFIG = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

test("Given no ytrack on PATH, When the runner runs, Then it reports ytrack missing", () => {
  const empty = path.join(dir, "empty");
  mkdirSync(empty, { recursive: true });
  expect(ytrackRunner({ PATH: empty })(["issue", "view", "ABC-1"]).missing).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "Given a ytrack stub on PATH, When the runner runs, Then it passes args, stdin and youtrack.json's host",
  () => {
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const log = path.join(dir, "ytrack.log");
    const stub = path.join(bin, "ytrack");
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s|%s|' "$YTRACK_HOST" "$*" > "${log}"\ncat >> "${log}"\nprintf '{"idReadable":"ABC-5"}'\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
    const out = ytrackRunner({ PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` })(
      ["issue", "create", "--summary", "S"],
      "Body",
    );
    expect(out).toEqual({ status: 0, stdout: '{"idReadable":"ABC-5"}', stderr: "" });
    expect(readFileSync(log, "utf8")).toBe(`${BASE}|issue create --summary S|Body`);
  },
);
