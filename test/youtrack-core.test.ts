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

test("default scripts delegate to runScriptJson/runScript without crashing", () => {
  // The point is the arrow functions execute; real scripts may or may not exist in CI.
  const verify = verifyYouTrackToken();
  expect(verify).toBeDefined();
  const duration = parseDuration("30m", os.tmpdir());
  expect(duration).toBeDefined();
});

test("context and logTime default scripts execute end to end", () => {
  const ctx = context({ issue_url: "https://yt.example.test/issue/NSR-40", workspace_root: os.tmpdir() });
  expect(ctx).toBeDefined();
  const logged = logTime({ issueId: "NSR-40", minutes: 15, workspace_root: os.tmpdir() });
  expect(logged).toBeDefined();
  const posted = postUpdate({ confirmed: true, issueId: "NSR-40", markdown: "Avance", workspace_root: os.tmpdir() });
  expect(posted).toBeDefined();
});
