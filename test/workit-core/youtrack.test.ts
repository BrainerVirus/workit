import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// The config chain WORKFLOW_TOOLKIT_CONFIG → WORKFLOW_TOOLKIT_CONFIG_DIR → XDG must
// resolve via XDG alone in isolation tests: earlier test files may leak the override
// vars into the ambient env (same fix family as config.test.ts).

const withNeutralXdg = async <T>(xdg: string, fn: () => Promise<T> | T): Promise<T> => {
  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
    WORKFLOW_TOOLKIT_CONFIG_DIR: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  };
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  try {
    return await fn();
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
  readCredentials,
  redact,
} from "@/packages/workit-core/src/core/youtrack-tools";
import {
  youTrackApi,
  youTrackConfigLoad,
  youTrackTokenCreateUrl,
  youTrackWorkDateMs,
} from "@/packages/workit-core/src/core/youtrack";
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

test("tokens are removed from errors", () => {
  expect(redact("request Bearer secret-token failed", "secret-token")).toBe(
    "request Bearer [REDACTED] failed",
  );
});

test("credentials use neutral XDG config and require token mode 0600", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-"));
  const directory = path.join(xdg, "workit");
  mkdirSync(directory);
  const tokenPath = path.join(directory, "youtrack.token");
  writeFileSync(tokenPath, "dummy-token\n", { mode: 0o644 });
  writeFileSync(path.join(directory, "youtrack.json"), JSON.stringify({ tokenFile: tokenPath }));

  expect(configPath({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv, "/unused")).toBe(
    path.join(directory, "youtrack.json"),
  );
  if (process.platform !== "win32") {
    expect(() => readCredentials({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv, "/unused")).toThrow(
      "youtrack.token mode must be 0600",
    );

    chmodSync(tokenPath, 0o600);
    expect(readCredentials({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv, "/unused")).toEqual({
      configPath: path.join(directory, "youtrack.json"),
      token: "dummy-token",
    });
  }
});

test.skipIf(process.platform === "win32")("bundled YouTrack scripts honor XDG_CONFIG_HOME", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-script-"));
  const directory = path.join(xdg, "workflow-toolkit");
  mkdirSync(directory);
  const tokenPath = path.join(directory, "youtrack.token");
  writeFileSync(tokenPath, "dummy-token\n", { mode: 0o600 });
  writeFileSync(
    path.join(directory, "youtrack.json"),
    JSON.stringify({
      tokenFile: tokenPath,
      baseUrl: "https://youtrack.example.test",
      meetingIssue: "MEET-1",
    }),
  );

  withNeutralXdg(xdg, () => {
    const out = youTrackConfigLoad();
    expect("data" in out ? out.data.meetingIssue : null).toBe("MEET-1");
  });
});

test("CA-03: youtrack config read resolves the token file inside the active config dir only", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-yt-active-dir-"));
  const workit = path.join(xdg, "workit");
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(workit, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  const activeToken = path.join(workit, "youtrack.token");
  writeFileSync(activeToken, "dummy-token\n", { mode: 0o600 });
  writeFileSync(path.join(legacy, "youtrack.token"), "legacy-decoy\n", { mode: 0o600 });
  writeFileSync(
    path.join(workit, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://youtrack.example.test", tokenFile: activeToken }),
  );
  withNeutralXdg(xdg, () => {
    const out = youTrackConfigLoad();
    expect("data" in out).toBe(true);
    if ("data" in out) {
      expect(out.data.configPath).toBe(path.resolve(path.join(workit, "youtrack.json")));
      expect(out.data.tokenPath).toBe(path.resolve(activeToken));
    }
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
        const out = youTrackConfigLoad() as { ok?: boolean; error?: string; configPath?: string };
        expect(out.error, content).toBeTruthy();
        expect(String(out.error ?? ""), content).toContain(ytFile);
        expect(out.ok, content).toBe(false);
        expect(out.configPath, content).toBe(ytFile);

        const work = youTrackWorkDateMs("auto") as { error?: string };
        expect(work.error, content).toBeTruthy();
        expect(String(work.error ?? ""), content).toContain(ytFile);

        expect(() => readCredentials(), content).toThrow(ytFile);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init scaffolding uses the neutral XDG config directory", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-init-"));
  withNeutralXdg(xdg, () => {
    initApplyData("youtrack_scaffold");
    const directory = path.join(xdg, "workit");
    const config = JSON.parse(readFileSync(path.join(directory, "youtrack.json"), "utf8"));
    expect(config.tokenFile).toBe(path.join(directory, "youtrack.token"));
    expect(config.tokenDefaults.description).toContain("OpenCode workit");
    expect(config.tokenDefaults.description).not.toContain("Cursor");
  });
});

test("token helper runtime output uses OpenCode-neutral descriptions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-token-help-"));
  const config = path.join(root, "youtrack.json");
  writeFileSync(config, JSON.stringify({ baseUrl: "https://example.youtrack.cloud" }));
  const previous = process.env.WORKFLOW_YOUTRACK_CONFIG;
  process.env.WORKFLOW_YOUTRACK_CONFIG = config;
  try {
    const output = youTrackTokenCreateUrl().data;
    expect(output.tokenDescription).toContain("OpenCode workit");
    expect(JSON.stringify(output)).not.toContain("Cursor");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a youtrack.json without baseUrl, When the token-create link is built, Then there is no organization default and a clear error", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-token-nobase-"));
  const config = path.join(root, "youtrack.json");
  writeFileSync(config, JSON.stringify({}));
  const previous = process.env.WORKFLOW_YOUTRACK_CONFIG;
  process.env.WORKFLOW_YOUTRACK_CONFIG = config;
  try {
    const output = youTrackTokenCreateUrl().data;
    expect(output.createUrl).toBeNull();
    expect(output.error).toContain("baseUrl missing");
    expect(output.error).toContain(config);
    expect(JSON.stringify(output)).not.toMatch(/youtrack\.cloud/);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
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

test("bundled API failures never expose the token or authorization header", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-redact-"));
  const tokenPath = path.join(root, "youtrack.token");
  const config = path.join(root, "youtrack.json");
  writeFileSync(tokenPath, "secret-token\n", { mode: 0o600 });
  writeFileSync(
    config,
    JSON.stringify({ tokenFile: tokenPath, baseUrl: "https://youtrack.example.test" }),
  );

  const previousConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("offline");
  }) as unknown as typeof fetch;
  process.env.WORKFLOW_YOUTRACK_CONFIG = config;
  try {
    const result = await youTrackApi(["post-comment", "NSR-40", "Revisado"], "1");
    expect(called).toBe(true); // fetch is used, not the curl binary
    expect("error" in result).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("Authorization");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
