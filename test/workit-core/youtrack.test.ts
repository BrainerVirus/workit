import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// The config chain WORKIT_CONFIG → WORKIT_CONFIG_DIR → XDG must
// resolve via XDG alone in isolation tests: earlier test files may leak the override
// vars into the ambient env (same fix family as config.test.ts).

// Synchronous on purpose: an async helper the callers did not await restored
// the env late (a loop's calls interleaved and leaked XDG_CONFIG_HOME into
// later test files) and turned a failing expect into an unhandled rejection.
const withNeutralXdg = <T>(xdg: string, fn: () => T): T => {
  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WORKIT_CONFIG: process.env.WORKIT_CONFIG,
    WORKIT_CONFIG_DIR: process.env.WORKIT_CONFIG_DIR,
  };
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.WORKIT_CONFIG;
  delete process.env.WORKIT_CONFIG_DIR;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

import {
  configPath,
  normalizeContext,
  postUpdate,
} from "@/packages/workit-core/src/core/youtrack-tools";
import { youTrackWorkDateMs } from "@/packages/workit-core/src/core/youtrack";
import { initApplyData } from "@/packages/workit-core/src/core/init";

test("comment success plus ambiguous time failure does not recommend retry", async () => {
  const result = await postUpdate(
    {
      confirmed: true,
      issueId: "NSR-40",
      markdown: "Revisado",
      minutes: 30,
    },
    {
      postComment: async () => ({ ok: true }),
      logTime: async () => {
        throw new Error("time failed");
      },
    },
  );
  expect(result).toEqual({
    ok: false,
    data: {
      issueId: "NSR-40",
      postedComment: true,
      loggedMinutes: 0,
      outcome: "unknown",
      instructions:
        "Check YouTrack time entries manually; do not retry while the outcome is unknown.",
    },
    error: "time failed",
  });
});

test("ambiguous comment failure records known effects and does not recommend retry", async () => {
  let logged = false;
  const result = await postUpdate(
    {
      confirmed: true,
      issueId: "NSR-40",
      markdown: "Revisado",
      minutes: 30,
    },
    {
      postComment: async () => {
        throw new Error("comment failed");
      },
      logTime: async () => {
        logged = true;
      },
    },
  );
  expect(logged).toBe(false);
  expect(result).toEqual({
    ok: false,
    data: {
      issueId: "NSR-40",
      postedComment: false,
      loggedMinutes: 0,
      outcome: "unknown",
      instructions: "Check YouTrack comments manually; do not retry while the outcome is unknown.",
    },
    error: "comment failed",
  });
});

test("explicit not_applied time failure safely retries time only", async () => {
  const result = await postUpdate(
    {
      confirmed: true,
      issueId: "NSR-40",
      markdown: "Revisado",
      minutes: 30,
    },
    {
      postComment: async () => ({ ok: true }),
      logTime: async () => ({
        ok: false,
        error: "rejected before request",
        outcome: "not_applied",
      }),
    },
  );
  expect(result).toEqual({
    ok: false,
    data: {
      issueId: "NSR-40",
      postedComment: true,
      loggedMinutes: 0,
      outcome: "not_applied",
      retry: "youtrack.time",
    },
    error: "rejected before request",
  });
});

test("explicit not_applied comment failure safely retries the missing effects", async () => {
  const result = await postUpdate(
    {
      confirmed: true,
      issueId: "NSR-40",
      markdown: "Revisado",
      minutes: 30,
    },
    {
      postComment: async () => ({
        ok: false,
        error: "rejected before request",
        outcome: "not_applied",
      }),
      logTime: async () => ({ ok: true }),
    },
  );
  expect(result).toEqual({
    ok: false,
    data: {
      issueId: "NSR-40",
      postedComment: false,
      loggedMinutes: 0,
      outcome: "not_applied",
      retry: "youtrack.update",
    },
    error: "rejected before request",
  });
});

test("posting requires explicit confirmation before either effect", async () => {
  let calls = 0;
  const result = await postUpdate(
    {
      confirmed: false,
      issueId: "NSR-40",
      markdown: "Revisado",
      minutes: 30,
    },
    {
      postComment: async () => {
        calls++;
      },
      logTime: async () => {
        calls++;
      },
    },
  );
  expect(calls).toBe(0);
  expect(result).toEqual({ ok: false, data: null, error: "confirmed: true required" });
});

test("youtrack.json resolves in the neutral XDG config dir", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-"));
  expect(configPath({ XDG_CONFIG_HOME: xdg }, "/unused")).toBe(
    path.join(xdg, "workit", "youtrack.json"),
  );
  rmSync(xdg, { recursive: true, force: true });
});

test("bundled YouTrack config reads honor XDG_CONFIG_HOME", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-script-"));
  const directory = path.join(xdg, "workit");
  mkdirSync(directory);
  writeFileSync(
    path.join(directory, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://youtrack.example.test", timezone: "UTC" }),
  );
  withNeutralXdg(xdg, () => {
    const out = youTrackWorkDateMs("auto");
    expect("data" in out ? out.data.timezoneSource : null).toBe("youtrack.json");
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("AR-07: non-object youtrack.json shapes fail closed with the exact path", () => {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wf-yt-shapes-"));
  const workit = path.join(dir, "workit");
  mkdirSync(workit, { recursive: true });
  const ytFile = path.join(workit, "youtrack.json");
  try {
    for (const content of ["null", '"just a string"', "42", "[]", "[1, 2, 3]"]) {
      writeFileSync(ytFile, content, "utf8");
      withNeutralXdg(dir, () => {
        const work = youTrackWorkDateMs("auto") as { error?: string };
        expect(work.error, content).toBeTruthy();
        expect(String(work.error ?? ""), content).toContain(ytFile);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Given no ytrack, When init scaffolds YouTrack, Then youtrack.json has no token and the result names the ytrack install", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-init-"));
  withNeutralXdg(xdg, () => {
    const out = initApplyData("youtrack_scaffold");
    const directory = path.join(xdg, "workit");
    const config = JSON.parse(readFileSync(path.join(directory, "youtrack.json"), "utf8"));
    expect(config.tokenFile).toBeUndefined();
    expect(config.tokenDefaults).toBeUndefined();
    expect(existsSync(path.join(directory, "youtrack.token"))).toBe(false);
    expect(out.ytrack).toMatchObject({ ok: false, reason: "missing" });
    expect(out.ytrack.unblock).toContain("github.com/BrainerVirus/youtrack-cli");
    expect(out.ytrack.unblock).toContain("ytrack auth login --host youtrack.example.com");
    expect(out.instruction).toContain(out.ytrack.unblock);
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("Given an older host, When it asks init for the token placeholder, Then nothing is written and the answer names ytrack", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-noplaceholder-"));
  withNeutralXdg(xdg, () => {
    const out = initApplyData("youtrack_token_placeholder");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no longer uses a YouTrack token file");
    expect(out.unblock).toContain("ytrack auth login");
    expect(existsSync(path.join(xdg, "workit", "youtrack.token"))).toBe(false);
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("meeting context exposes only the configured meetingIssue", () => {
  expect(
    normalizeContext(
      {
        config: {
          meetingIssue: "MEET-1",
          meetingIssues: { web: { issue: "MEET-9" } },
        },
        meetingOptions: [
          { key: "general", issue: "MEET-1", label: "General", workItemText: "Meetings" },
          { key: "web", issue: "MEET-9", label: "Web", workItemText: "Web meetings" },
        ],
        requiresMeetingChoice: true,
        issueId: null,
      },
      "meetings",
    ),
  ).toEqual({
    config: { meetingIssue: "MEET-1" },
    meetingOptions: [
      { key: "general", issue: "MEET-1", label: "General", workItemText: "Meetings" },
    ],
    requiresMeetingChoice: false,
    issueId: "MEET-1",
    workItemText: "Meetings",
  });
});

test("Given no meeting issue in youtrack.json, When meeting context is normalized, Then it asks for one instead of using a built-in issue", () => {
  const out = normalizeContext(
    { config: { baseUrl: "https://yt.example.test" }, meetingOptions: [], issueId: null },
    "meetings",
  ) as Record<string, unknown>;
  expect(out.error).toContain("meetingIssue");
  expect(out.requiresIssueInput).toBe(true);
});
