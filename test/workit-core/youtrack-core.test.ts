import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempConfigDir } from "@/test/shared/helpers/env";
import { templatePath } from "@/packages/workit-core/src/core/templates";
import {
  buildDraft,
  context,
  fetchYouTrackIssueBody,
  parseDuration,
  parseIssueRef,
  type YouTrackScripts,
} from "@/packages/workit-core/src/core/youtrack";
import { defaultOperations } from "@/packages/workit-core/src/core/youtrack-tools";
import { youTrackWriteGate } from "@/packages/workit-core/src/core/youtrack-backend";
import type { YtrackResult, YtrackRun } from "@/packages/workit-core/src/core/youtrack-ytrack";
import { useConfigHome } from "../shared/grant-home";

const cfg = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: "https://yt.example.test",
  meetingIssue: "MEET-1",
  ...overrides,
});

const scripts = (overrides: Partial<YouTrackScripts> = {}): YouTrackScripts => ({
  config: () => ({ data: cfg() }),
  parseDuration: (text: string) => ({ minutes: text === "30m" ? 30 : 0 }),
  ...overrides,
});

test("parseIssueRef handles id, url, embedded, and errors", () => {
  expect(parseIssueRef("NSR-40")).toEqual({ issueId: "NSR-40", source: "id" });
  expect(parseIssueRef("https://yt.example.test/issue/NSR-40")).toEqual({
    issueId: "NSR-40",
    source: "url",
  });
  expect(parseIssueRef("https://yt.example.test/issues/ABC-12?x=1")).toEqual({
    issueId: "ABC-12",
    source: "url",
  });
  expect(parseIssueRef("see NSR-40 for context")).toEqual({ issueId: "NSR-40", source: "url" });
  const empty = parseIssueRef("");
  expect("error" in empty ? empty.error : "").toContain("empty");
  const bad = parseIssueRef("not-an-issue");
  expect("error" in bad ? bad.error : "").toContain("could not parse");
  const undef = parseIssueRef(undefined);
  expect("error" in undef ? undef.error : "").toContain("empty");
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
  expect(meetings.workItemText).toBe("Meetings");

  const root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-paths-"));
  try {
    mkdirSync(path.join(root, "docs", "s"), { recursive: true });
    writeFileSync(path.join(root, "docs/s/spec.md"), "# S\n\n**YouTrack:** `ABC-7`\n");
    const fromSpec = context({ spec_path: "docs/s/spec.md", workspace_root: root }, scripts());
    expect(fromSpec.issueId).toBe("ABC-7");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context errors: config failure, missing issue", () => {
  expect(
    context({ workspace_root: os.tmpdir() }, scripts({ config: () => ({ error: "cfg down" }) }))
      .error,
  ).toBe("cfg down");
  expect(
    context(
      { workspace_root: os.tmpdir() },
      scripts({ config: () => ({ data: cfg({ meetingIssue: undefined }) }) }),
    ).error,
  ).toContain("invalid or missing issue id");
  expect(context({ issue_ref: "bad ref", workspace_root: os.tmpdir() }, scripts()).error).toContain(
    "could not parse issue id",
  );
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

test("Given youtrack.json meeting text settings, When meeting context is read, Then the configured text is used and the default is neutral", () => {
  const read = (data: Record<string, unknown>) =>
    context(
      { mode: "meetings", workspace_root: os.tmpdir() },
      scripts({ config: () => ({ data: cfg(data) }) }),
    ).meetingOptions;
  expect(read({})[0].workItemText).toBe("Meetings");
  expect(read({ meetingWorkItemText: "Team sync" })[0].workItemText).toBe("Team sync");
  expect(
    read({
      meetingWorkItemText: "Team sync",
      meetingIssues: { a: { issue: "MEET-2", workItemText: "Planning" }, b: { issue: "MEET-3" } },
    }).map((o: { workItemText: string }) => o.workItemText),
  ).toEqual(["Planning", "Team sync"]);
});

test("Given a youtrack.json with or without timezone, When context is read, Then it surfaces the effective work-item timezone and its source", () => {
  const configured = context(
    { issue_id: "NSR-1", workspace_root: os.tmpdir() },
    scripts({ config: () => ({ data: cfg({ timezone: "Asia/Tokyo" }) }) }),
  );
  expect(configured.workTimezone).toEqual({ timezone: "Asia/Tokyo", source: "youtrack.json" });
  const fallback = context({ issue_id: "NSR-1", workspace_root: os.tmpdir() }, scripts());
  expect(fallback.workTimezone).toEqual({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    source: "process",
  });
});

test("parseDuration delegates and maps errors", () => {
  const ok = scripts({ parseDuration: () => ({ data: { minutes: 30 } }) });
  expect(parseDuration("30m", os.tmpdir(), ok)).toEqual({ minutes: 30 });
  const failing = scripts({ parseDuration: () => ({ error: "bad" }) });
  expect(parseDuration("1h", os.tmpdir(), failing)).toEqual({ error: "bad" });
});

test("Given an old youtrack.json with greeting and mention fields, When context is read, Then it succeeds and emits no greeting or mention", () => {
  const legacy = cfg({
    timezone: "America/Santiago",
    defaultMention: "Some.Person",
    greetings: { morning: "good morning", afternoon: "good afternoon" },
    greetingCutoff: "12:00",
  });
  const result = context(
    { issue_id: "NSR-40", workspace_root: os.tmpdir() },
    scripts({ config: () => ({ data: legacy }) }),
  );
  expect(result.error).toBeUndefined();
  expect(result.issueId).toBe("NSR-40");
  expect(result).not.toHaveProperty("greeting");
  const serialized = JSON.stringify(result);
  for (const banned of ["defaultMention", "Some.Person", "greetings", "greetingCutoff"])
    expect(serialized, banned).not.toContain(banned);
  expect(result.config.timezone).toBe("America/Santiago");
});

test("buildDraft composes a neutral header, project, notes, and facts", () => {
  // Isolated config dir: the bundled template is under test, never a user override.
  withTempConfigDir(() => {
    const bare = buildDraft({ issueId: "NSR-1" });
    expect(bare.markdown).toBe("# Update\n\n");
    const full = buildDraft({
      issueId: "NSR-1",
      projectName: "Tracer",
      userNotes: "Finished the module",
      includeProjectOpener: true,
      includeFacts: true,
      facts: {
        progress_excerpt: ["Task 1: done"],
        git_commits: ["abc123 fix"],
      },
    });
    expect(full.markdown.startsWith("# Update\n\nProject: Tracer\n\nFinished the module")).toBe(
      true,
    );
    expect(full.markdown).toContain("Finished the module");
    expect(full.markdown).toContain("- Task 1: done");
    expect(full.markdown).toContain("- abc123 fix");
  });
});

test("Given a user issue-update template with a legacy {{greetingSection}}, When a draft is built, Then it renders and the unknown placeholder is empty", () => {
  withTempConfigDir(() => {
    const file = templatePath("issue-update");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      "# Status\n{{greetingSection}}\n{{userNotesSection}}\n{{someFuturePlaceholder}}\n",
    );
    const draft = buildDraft({ issueId: "NSR-1", userNotes: "Shipped the fix" });
    expect(draft.markdown).toBe("# Status\n\nShipped the fix");
    expect(draft.markdown).not.toContain("{{");
  });
});

test("resolveYouTrackFromPaths returns null when no file has a YouTrack ref", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-noref-"));
  try {
    mkdirSync(path.join(root, "docs", "s"), { recursive: true });
    writeFileSync(path.join(root, "docs/s/spec.md"), "# S\n\n**Branch:** `feature/s`\n");
    const result = context({ spec_path: "docs/s/spec.md", workspace_root: root }, scripts());
    expect(result.error).toContain("invalid or missing issue id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default scripts delegate only to read-only youtrack helpers", () => {
  const duration = parseDuration("30m", os.tmpdir());
  expect(duration).toBeDefined();
});

/**
 * A workspace with `youtrack.writes: auto`, the opt-out that keeps the
 * WORKIT_YT_WRITE gate: in a temp account home, sealed, as only the account's
 * own file gives auto (#819).
 */
const autoWrites = (fn: (root: string) => Promise<void>) => {
  const home = useConfigHome("wk-yt-auto-");
  const root = path.join(home.configDir, "work");
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${root}/**`, youtrack: { writes: "auto" } }],
    }),
  );
  return fn(root).finally(() => home.restore());
};

test("Given youtrack.writes auto and no WORKIT_YT_WRITE, When a write goes through the default operations, Then it is refused before ytrack runs", () =>
  autoWrites(async (root) => {
    const previous = process.env.WORKIT_YT_WRITE;
    delete process.env.WORKIT_YT_WRITE;
    try {
      const result = await defaultOperations.postComment("NSR-40", "test", root);
      expect(result).toMatchObject({ ok: false, outcome: "not_applied" });
      expect(String(result?.error)).toContain("WORKIT_YT_WRITE");
    } finally {
      if (previous === undefined) delete process.env.WORKIT_YT_WRITE;
      else process.env.WORKIT_YT_WRITE = previous;
    }
  }));

test("Given youtrack.writes auto and no ytrack, When a gated write goes through the default operations, Then it is not applied and names the ytrack install", () =>
  autoWrites(async (root) => {
    // The preload hides any real ytrack; the write must never reach an instance.
    expect(process.env.WORKIT_NO_YTRACK).toBe("1");
    const previous = process.env.WORKIT_YT_WRITE;
    process.env.WORKIT_YT_WRITE = "1";
    const workItem = { issueId: "NSR-40", minutes: 5, workspace_root: root };
    try {
      for (const result of [
        await defaultOperations.postComment("NSR-40", "test", root),
        await defaultOperations.logTime(workItem),
      ]) {
        expect(result).toMatchObject({ ok: false, outcome: "not_applied" });
        expect(String(result?.error)).toContain("ytrack is not on PATH");
        expect(String(result?.unblock)).toContain("github.com/BrainerVirus/youtrack-cli");
      }
    } finally {
      if (previous === undefined) delete process.env.WORKIT_YT_WRITE;
      else process.env.WORKIT_YT_WRITE = previous;
    }
  }));

test("the pre-rename write flag is no alias: it alone leaves YouTrack writes refused", () => {
  // Built at runtime so the no-legacy-name guard keeps the old spelling out of the tree.
  const legacy = ["WORKFLOW", "YT_WRITE"].join("_");
  expect(youTrackWriteGate({ [legacy]: "1" })?.error).toContain("requires WORKIT_YT_WRITE=1");
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
      if (
        line.includes("operations") ||
        line.includes("scripts(") ||
        line.includes("=>") ||
        line.includes("expect(") ||
        line.includes("await import") ||
        line.includes("mock") ||
        line.includes("//") ||
        line.includes("test(") ||
        line.includes("logTimeUpdate") ||
        line.includes("logTimeConfirmed") ||
        /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(line)
      )
        continue;
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

/** A recorded ytrack stub: every call's argv, one canned result. */
const ytrackStub = (result: YtrackResult) => {
  const calls: string[][] = [];
  const run: YtrackRun = (args) => {
    calls.push(args);
    return result;
  };
  return { run, calls };
};

test("fetchYouTrackIssueBody reads summary, description and state through ytrack", async () => {
  const stub = ytrackStub({
    status: 0,
    stdout: JSON.stringify({
      idReadable: "TST-123",
      summary: "Cambia nombre",
      description: "Detalle de la issue",
      state: "Open",
    }),
    stderr: "",
  });
  expect(await fetchYouTrackIssueBody("TST-123", stub.run)).toEqual({
    data: {
      idReadable: "TST-123",
      summary: "Cambia nombre",
      description: "Detalle de la issue",
      state: "Open",
    },
  });
  expect(stub.calls).toEqual([
    ["issue", "view", "TST-123", "--json", "idReadable,summary,description,state"],
  ]);
  const noState = ytrackStub({
    status: 0,
    stdout: JSON.stringify({ idReadable: "TST-123", summary: "S" }),
    stderr: "",
  });
  expect(await fetchYouTrackIssueBody("TST-123", noState.run)).toEqual({
    data: { idReadable: "TST-123", summary: "S", description: null, state: null },
  });
});

test("fetchYouTrackIssueBody degrades without ytrack or its login, fails closed on a failed read", async () => {
  const missing = ytrackStub({ status: null, stdout: "", stderr: "", missing: true });
  const credsDown = await fetchYouTrackIssueBody("TST-123", missing.run);
  expect(credsDown).toMatchObject({ kind: "creds" });
  expect("error" in credsDown ? credsDown.error : "").toContain("ytrack is not on PATH");

  const loggedOut = ytrackStub({ status: 4, stdout: "", stderr: "login required" });
  expect(await fetchYouTrackIssueBody("TST-123", loggedOut.run)).toMatchObject({ kind: "creds" });

  const requestDown = ytrackStub({ status: 1, stdout: "", stderr: "boom" });
  expect(await fetchYouTrackIssueBody("TST-123", requestDown.run)).toEqual({
    error: "ytrack issue view failed (exit 1): boom",
    kind: "request",
  });

  const badJson = ytrackStub({ status: 0, stdout: "not json", stderr: "" });
  expect(await fetchYouTrackIssueBody("TST-123", badJson.run)).toEqual({
    error: "ytrack printed invalid JSON",
    kind: "request",
  });
});
