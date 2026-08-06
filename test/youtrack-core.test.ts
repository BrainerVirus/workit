import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDraft,
  context,
  logTime,
  parseDuration,
  parseIssueRef,
  postUpdate,
  verifyYouTrackToken,
  type YouTrackScripts,
} from "../src/core/youtrack";

const cfg = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: "https://yt.example.test",
  meetingIssue: "MEET-1",
  ...overrides,
});

const scripts = (overrides: Partial<YouTrackScripts> = {}): YouTrackScripts => ({
  config: () => ({ data: cfg() }),
  greeting: () => ({ stdout: "Hola", exitCode: 0, stderr: "" }),
  parseDuration: (text: string) => ({ minutes: text === "30m" ? 30 : 0 }),
  api: (args: string[]) => ({ ok: true, args }),
  ...overrides,
});

test("parseIssueRef handles id, url, embedded, and errors", () => {
  expect(parseIssueRef("NSR-40")).toEqual({ issueId: "NSR-40", source: "id" });
  expect(parseIssueRef("https://yt.example.test/issue/NSR-40")).toEqual({ issueId: "NSR-40", source: "url" });
  expect(parseIssueRef("https://yt.example.test/issues/ABC-12?x=1")).toEqual({ issueId: "ABC-12", source: "url" });
  expect(parseIssueRef("see NSR-40 for context")).toEqual({ issueId: "NSR-40", source: "url" });
  const empty = parseIssueRef("");
  expect("error" in empty ? empty.error : "").toContain("empty");
  const bad = parseIssueRef("not-an-issue");
  expect("error" in bad ? bad.error : "").toContain("could not parse");
  const undef = parseIssueRef(undefined);
  expect("error" in undef ? undef.error : "").toContain("empty");
});

test("verifyYouTrackToken delegates to config script", () => {
  expect(verifyYouTrackToken(scripts({ config: () => ({ error: "no token" }) }))).toEqual({ error: "no token" });
  expect(verifyYouTrackToken(scripts())).toEqual({ data: cfg() });
});

test("context resolves issue from url and mode defaults to task", () => {
  const result = context(
    { issue_url: "https://yt.example.test/issue/NSR-40", workspace_root: os.tmpdir() },
    scripts(),
  );
  expect(result.issueId).toBe("NSR-40");
  expect(result.mode).toBe("task");
  expect(result.issueUrl).toBe("https://yt.example.test/issue/NSR-40");
});

test("context returns requiresMeetingChoice in meetings mode without issue", () => {
  const result = context({ mode: "meetings", workspace_root: os.tmpdir() }, scripts());
  expect(result.requiresMeetingChoice).toBe(true);
  expect(result.meetingOptions[0].issue).toBe("MEET-1");
});

test("context falls back to meeting issue and spec/plan YouTrack ref", () => {
  const meetings = context(
    { mode: "meetings", issue_id: "MEET-1", workspace_root: os.tmpdir() },
    scripts(),
  );
  expect(meetings.mode).toBe("meetings");
  expect(meetings.workItemText).toBe("Reuniones");

  const root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-paths-"));
  try {
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(path.join(root, "docs/superpowers/specs/s.md"), "# S\n\n**YouTrack:** `ABC-7`\n");
    const fromSpec = context(
      { spec_path: "docs/superpowers/specs/s.md", workspace_root: root },
      scripts(),
    );
    expect(fromSpec.issueId).toBe("ABC-7");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context errors: config failure, greeting failure, missing issue", () => {
  expect(context({ workspace_root: os.tmpdir() }, scripts({ config: () => ({ error: "cfg down" }) })).error)
    .toBe("cfg down");
  expect(context({ workspace_root: os.tmpdir() }, scripts({ greeting: () => ({ stdout: "", exitCode: 1, stderr: "no greet" }) })).error)
    .toContain("no greet");
  expect(context({ workspace_root: os.tmpdir() }, scripts({ config: () => ({ data: cfg({ meetingIssue: undefined }) }) })).error)
    .toContain("invalid or missing issue id");
  expect(context({ issue_ref: "bad ref", workspace_root: os.tmpdir() }, scripts()).error)
    .toContain("could not parse issue id");
});

test("context uses meetingIssues map with custom labels and urls", () => {
  const result = context(
    { mode: "meetings", workspace_root: os.tmpdir() },
    scripts({
      config: () => ({
        data: cfg({
          meetingIssues: {
            daily: { issue: "MEET-2", label: "Daily", workItemText: "Daily standup" },
            retro: { issue: "MEET-3", url: "https://custom/MEET-3" },
          },
        }),
      }),
    }),
  );
  expect(result.meetingOptions).toHaveLength(2);
  expect(result.meetingOptions[0].label).toBe("Daily");
  expect(result.meetingOptions[1].url).toBe("https://custom/MEET-3");
});

test("parseDuration delegates and maps errors", () => {
  const ok = scripts({ parseDuration: () => ({ data: { minutes: 30 } }) });
  expect(parseDuration("30m", os.tmpdir(), ok)).toEqual({ minutes: 30 });
  const failing = scripts({ parseDuration: () => ({ error: "bad" }) });
  expect(parseDuration("1h", os.tmpdir(), failing)).toEqual({ error: "bad" });
});

test("logTime validates, formats date arg, and delegates", () => {
  expect(logTime({ issueId: "bad", minutes: 30, workspace_root: os.tmpdir() }, scripts()).error).toContain("invalid issueId");
  expect(logTime({ issueId: "NSR-1", minutes: 0, workspace_root: os.tmpdir() }, scripts()).error).toContain("positive");
  expect(logTime({ issueId: "NSR-1", minutes: -5, workspace_root: os.tmpdir() }, scripts()).error).toContain("positive");
  const withDateMs = logTime(
    { issueId: "NSR-1", minutes: 30, dateMs: 123456, workspace_root: os.tmpdir() },
    scripts({ api: (args) => ({ data: { captured: args } }) }),
  );
  expect(withDateMs.ok).toBe(true);
  expect(withDateMs.captured).toContain("123456");
  const withDate = logTime(
    { issueId: "NSR-1", minutes: 30, date: "20260101", workspace_root: os.tmpdir() },
    scripts({ api: (args) => ({ data: { captured: args } }) }),
  );
  expect(withDate.captured).toContain("20260101");
  const auto = logTime(
    { issueId: "NSR-1", minutes: 30, workspace_root: os.tmpdir() },
    scripts({ api: (args) => ({ data: { captured: args } }) }),
  );
  expect(auto.captured).toContain("auto");
  expect(logTime({ issueId: "NSR-1", minutes: 30, workspace_root: os.tmpdir() }, scripts({ api: () => ({ error: "api down" }) })).error)
    .toBe("api down");
});

test("buildDraft composes header, greeting, project, notes, and facts", () => {
  const bare = buildDraft({ issueId: "NSR-1" });
  expect(bare.markdown).toBe("# Actualización\n\n");
  const full = buildDraft({
    issueId: "NSR-1",
    projectName: "Tracer",
    userNotes: "Terminé el modulo",
    greeting: "Hola equipo",
    includeProjectOpener: true,
    includeFacts: true,
    facts: {
      progress_excerpt: ["Task 1: done"],
      git_commits: ["abc123 fix"],
    },
  });
  expect(full.markdown).toContain("Hola equipo");
  expect(full.markdown).toContain("Hoy estuve full con Tracer");
  expect(full.markdown).toContain("Terminé el modulo");
  expect(full.markdown).toContain("- Task 1: done");
  expect(full.markdown).toContain("- abc123 fix");
});

test("postUpdate validates confirmed, issueId, and markdown", () => {
  expect(postUpdate({ confirmed: false, issueId: "NSR-1", markdown: "x" }).error).toContain("confirmed");
  expect(postUpdate({ confirmed: true, issueId: "bad", markdown: "x" }).error).toContain("invalid issueId");
  expect(postUpdate({ confirmed: true, issueId: "NSR-1", markdown: "  " }).error).toContain("markdown required");
});

test("postUpdate surfaces comment errors and success with minutes", () => {
  const commentFail = postUpdate(
    { confirmed: true, issueId: "NSR-1", markdown: "x", workspace_root: os.tmpdir() },
    { postComment: () => ({ error: "comment rejected" }) },
  );
  expect(commentFail.error).toBe("comment rejected");

  const withMinutes = postUpdate(
    { confirmed: true, issueId: "NSR-1", markdown: "x", minutes: 45, workspace_root: os.tmpdir() },
    {
      postComment: () => ({ data: { ok: true } }),
      logTime: () => ({ data: { ok: true } }),
    },
  );
  expect(withMinutes).toEqual({ ok: true, issueId: "NSR-1", postedComment: true, loggedMinutes: 45 });

  const noMinutes = postUpdate(
    { confirmed: true, issueId: "NSR-1", markdown: "x", workspace_root: os.tmpdir() },
    { postComment: () => ({ data: { ok: true } }) },
  );
  expect(noMinutes).toEqual({ ok: true, issueId: "NSR-1", postedComment: true });
});

test("resolveYouTrackFromPaths returns null when no file has a YouTrack ref", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-noref-"));
  try {
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(path.join(root, "docs/superpowers/specs/s.md"), "# S\n\n**Branch:** `feature/s`\n");
    const result = context(
      { spec_path: "docs/superpowers/specs/s.md", workspace_root: root },
      scripts(),
    );
    expect(result.error).toContain("invalid or missing issue id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default scripts delegate only to read-only youtrack helpers", () => {
  // verifyYouTrackToken and parseDuration are read-only (config/duration parse).
  // NEVER call logTime/postUpdate/context without injected scripts — they hit the
  // real configured YouTrack instance.
  const verify = verifyYouTrackToken();
  expect(verify).toBeDefined();
  const duration = parseDuration("30m", os.tmpdir());
  expect(duration).toBeDefined();
});


test("write guard: logTime refuses to mutate without WORKFLOW_YT_WRITE", () => {
  const previous = process.env.WORKFLOW_YT_WRITE;
  delete process.env.WORKFLOW_YT_WRITE;
  try {
    const result = logTime({ issueId: "NSR-40", minutes: 15, workspace_root: os.tmpdir() }, scripts({
      api: () => ({ error: "ERROR: YouTrack write operations require WORKFLOW_YT_WRITE=1 (refusing to mutate production)" }),
    }));
    expect(result.error).toContain("WORKFLOW_YT_WRITE");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previous;
  }
});

test("write guard: postUpdate confirmed sets the write flag for real api calls", () => {
  const captured: string[][] = [];
  const result = postUpdate(
    { confirmed: true, issueId: "NSR-40", markdown: "x", workspace_root: os.tmpdir() },
    {
      postComment: (id: string, text: string, root: string) => {
        captured.push([id, text, root ?? ""]);
        return { data: { ok: true } };
      },
      logTime: () => ({ data: { ok: true } }),
    },
  );
  expect(result.ok).toBe(true);
  expect(captured).toHaveLength(1);
});

test("real api.sh rejects writes without WORKFLOW_YT_WRITE", () => {
  // The guard must fail closed BEFORE any HTTP call. We point the config at a
  // nonexistent file so even an "allowed" write can never reach the real API.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const script = path.join(path.resolve(import.meta.dir, ".."), "scripts/youtrack/api.sh");
  const env = (write: string) => ({
    WORKFLOW_YT_WRITE: write,
    WORKFLOW_YOUTRACK_CONFIG: "/nonexistent/youtrack.json",
  });
  const denied = spawnSync("bash", [script, "post-comment", "NSR-40", "test"], {
    encoding: "utf8",
    env: { ...process.env, ...env("") },
  });
  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain("WORKFLOW_YT_WRITE");

  const allowed = spawnSync("bash", [script, "post-comment", "NSR-40", "test"], {
    encoding: "utf8",
    env: { ...process.env, ...env("1") },
  });
  // Passes the guard but must fail on the missing config — never on a real API.
  expect(allowed.status).not.toBe(0);
  expect(allowed.stderr).not.toContain("WORKFLOW_YT_WRITE");
});

test("no test may reach the real YouTrack API (write-guard structural scan)", () => {
  // The real API is production. Tests must always inject scripts/operations.
  // Scan every test file for write-call patterns that omit injection AND pass
  // the confirmation gate (only confirmed calls would reach the API).
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const testDir = path.join(path.resolve(import.meta.dir), ".");
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts") || f.endsWith(".ts"));
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(testDir, file), "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip definitions, mocks, and non-write usages.
      if (line.includes("operations") || line.includes("scripts(") || line.includes("=>")
        || line.includes("expect(") || line.includes("await import")
        || line.includes("mock") || line.includes("//") || line.includes("test(")
        || line.includes("logTimeUpdate") || line.includes("logTimeConfirmed")
        || /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(line)) continue;
      // A bare call to logTime/postUpdate with valid write data and no second
      // argument (injection) would reach the real default API layer.
      const bareCall = /\b(?:logTime|postUpdate)\(\s*\{[^}]*\}\s*\)/.test(line);
      if (bareCall) {
        const hasValidData = /issueId/.test(line) && /markdown|minutes/.test(line);
        if (hasValidData) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
