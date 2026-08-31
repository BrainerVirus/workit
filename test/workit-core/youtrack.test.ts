import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

// Minimal valid YouTrack config so tool executes (which read credentials for redact)
// work in a clean HOME (CI has no real ~/.config/workflow-toolkit).
const withYouTrackConfig = async (fn: () => Promise<void> | void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-yt-config-"));
  mkdirSync(path.join(dir, "workflow-toolkit"), { recursive: true });
  const tokenPath = path.join(dir, "workflow-toolkit", "token");
  writeFileSync(tokenPath, "test-token\n", "utf8");
  chmodSync(tokenPath, 0o600);
  writeFileSync(
    path.join(dir, "workflow-toolkit", "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", tokenFile: "./token" }, null, 2),
    "utf8",
  );
  return withNeutralXdg(dir, async () => {
    try {
      return await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
};
import {
  configPath,
  normalizeContext,
  postUpdate,
  readCredentials,
  redact,
} from "../../packages/workit-core/src/core/youtrack-tools";
import {
  youTrackApi,
  youTrackConfigLoad,
  youTrackTokenCreateUrl,
  youTrackWorkDateMs,
} from "../../packages/workit-core/src/core/youtrack";
import {
  initApplyData,
  initStatusData,
  toolkitStatusData,
} from "../../packages/workit-core/src/core/init";
import { createYouTrackTools } from "../../packages/workit-opencode/src/tools/youtrack";

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
      retry: "workit_youtrack_log_time",
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
      retry: "workit_youtrack_post",
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

test.skipIf(process.platform === "win32")(
  "standalone time logging preserves ambiguous and not-applied outcomes",
  async () => {
    const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-outcome-"));
    const directory = path.join(xdg, "workflow-toolkit");
    mkdirSync(directory);
    const tokenPath = path.join(directory, "youtrack.token");
    writeFileSync(tokenPath, "dummy-token\n", { mode: 0o600 });
    writeFileSync(path.join(directory, "youtrack.json"), JSON.stringify({ tokenFile: tokenPath }));
    await withNeutralXdg(xdg, async () => {
      for (const [operation, outcome, retry] of [
        [
          async () => {
            throw new Error("transport lost");
          },
          "unknown",
          undefined,
        ],
        [
          async () => ({ ok: false, error: "not sent", outcome: "not_applied" }),
          "not_applied",
          "workit_youtrack_log_time",
        ],
      ] as const) {
        const tools = createYouTrackTools({
          verifyToken: async () => ({}),
          context: async () => ({}),
          parseDuration: async () => ({}),
          postComment: async () => ({}),
          logTime: operation,
        });
        const raw = await tools.workit_youtrack_log_time.execute(
          { confirmed: true, issueId: "NSR-40", minutes: 30 },
          { directory: "/repo", worktree: "/repo" } as never,
        );
        const result = JSON.parse(raw as string);
        expect(result.data.outcome).toBe(outcome);
        expect(result.data.retry).toBe(retry);
        if (outcome === "unknown") expect(result.data.instructions).toContain("do not retry");
      }
    });
  },
);

test("bundled standalone time logging rejects invalid inputs before credentials or HTTP", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-preflight-"));
  const bin = path.join(root, "bin");
  const sentinel = path.join(root, "http-dispatched");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "curl"), `#!/bin/sh\ntouch '${sentinel}'\nexit 99\n`, {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    await withNeutralXdg(path.join(root, "missing-config"), async () => {
      const tools = createYouTrackTools();
      for (const [input, error] of [
        [{ confirmed: true, issueId: "bad", minutes: 30 }, "invalid issueId"],
        [{ confirmed: true, issueId: "NSR-40", minutes: 0 }, "minutes must be positive"],
        [{ confirmed: true, issueId: "NSR-40", minutes: -1 }, "minutes must be positive"],
      ] as const) {
        const raw = await tools.workit_youtrack_log_time.execute(input, {
          directory: root,
          worktree: root,
        } as never);
        expect(JSON.parse(raw as string)).toEqual({
          ok: false,
          data: {
            issueId: input.issueId,
            loggedMinutes: 0,
            outcome: "not_applied",
            retry: "workit_youtrack_log_time",
            instructions: "Correct the invalid input, then retry workit_youtrack_log_time once.",
          },
          error,
        });
      }
      expect(existsSync(sentinel)).toBe(false);
    });
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("YouTrack context rejects escaped spec and plan paths before credentials or operations", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-path-"));
  const root = path.join(parent, "repo");
  mkdirSync(root);
  let calls = 0;
  const tools = createYouTrackTools({
    verifyToken: async () => {
      calls++;
    },
    context: async () => {
      calls++;
      return {};
    },
    parseDuration: async () => ({}),
    postComment: async () => ({}),
    logTime: async () => ({}),
  });
  for (const input of [{ spec_path: "/tmp/outside" }, { plan_path: "../outside" }]) {
    const raw = await tools.workit_youtrack_context.execute(
      input as never,
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).error).toContain("repository-relative");
  }
  const outside = path.join(parent, "outside.md");
  writeFileSync(outside, "**YouTrack:** NSR-40\n");
  symlinkSync(outside, path.join(root, "linked.md"));
  const linked = await tools.workit_youtrack_context.execute({ spec_path: "linked.md" }, {
    directory: root,
    worktree: root,
  } as never);
  expect(JSON.parse(linked as string).error).toContain("repository-relative");
  expect(calls).toBe(0);
  rmSync(parent, { recursive: true, force: true });
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
      meetingIssue: "IRPT-12",
    }),
  );

  withNeutralXdg(xdg, () => {
    const out = youTrackConfigLoad();
    expect("data" in out ? out.data.meetingIssue : null).toBe("IRPT-12");
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-yt-shapes-"));
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

        const status = initStatusData(workit);
        const item = status.items.find((i: { id: string }) => i.id === "youtrack_json");
        expect(item.ok, content).toBe(false);
        expect(String(status.youtrack_config?.error ?? ""), content).toContain(ytFile);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init scaffolding and status share the neutral XDG config directory", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-youtrack-init-"));
  withNeutralXdg(xdg, () => {
    initApplyData("youtrack_scaffold");
    const directory = path.join(xdg, "workit");
    const config = JSON.parse(readFileSync(path.join(directory, "youtrack.json"), "utf8"));
    expect(config.tokenFile).toBe(path.join(directory, "youtrack.token"));
    expect(config.tokenDefaults.description).toContain("OpenCode workit");
    expect(config.tokenDefaults.description).not.toContain("Cursor");

    const configEditPath = initStatusData().youtrack_config.config_edit_path;
    if (process.platform === "win32") {
      expect(existsSync(configEditPath)).toBe(true);
      expect(path.basename(configEditPath)).toBe("youtrack.json");
    } else {
      expect(configEditPath).toBe(path.join(realpathSync(directory), "youtrack.json"));
    }
  });
});

test("toolkit status reads YouTrack health from its Result data envelope", async () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-toolkit-status-"));
  const workit = path.join(xdg, "workit");
  mkdirSync(workit, { recursive: true });
  const youTrackToken = path.join(workit, "youtrack.token");
  const gitLabToken = path.join(workit, "gitlab.token");
  writeFileSync(youTrackToken, "youtrack-token\n", { mode: 0o600 });
  writeFileSync(gitLabToken, "gitlab-token\n", { mode: 0o600 });
  writeFileSync(
    path.join(workit, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://youtrack.example.test", tokenFile: youTrackToken }),
  );
  writeFileSync(
    path.join(workit, "vcs.json"),
    JSON.stringify({
      provider: "gitlab",
      gitlab: { apiUrl: "https://gitlab.example.test/api/v4", tokenFile: gitLabToken },
    }),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.includes("youtrack.example.test")
      ? new Response(JSON.stringify({ id: "1", login: "workit" }))
      : new Response(JSON.stringify({ username: "workit" }));
  }) as typeof fetch;
  try {
    await withNeutralXdg(xdg, async () => {
      const status = await toolkitStatusData(workit);
      expect(status.youtrack_verify).toEqual({
        data: expect.objectContaining({ ok: true, login: "workit" }),
      });
      expect(status.vcs_verify).toEqual(
        expect.objectContaining({ ok: true, provider: "gitlab", username: "workit" }),
      );
      expect(status).toEqual(
        expect.objectContaining({ youtrack_ok: true, vcs_ok: true, ready: true }),
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(xdg, { recursive: true, force: true });
  }
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

test("meeting context exposes only the configured meetingIssue", () => {
  expect(
    normalizeContext(
      {
        config: {
          meetingIssue: "IRPT-12",
          meetingIssues: { web: { issue: "NSXFT-21" } },
        },
        meetingOptions: [
          { key: "general", issue: "IRPT-12", label: "General", workItemText: "Reuniones" },
          { key: "web", issue: "NSXFT-21", label: "Web", workItemText: "Reuniones web" },
        ],
        requiresMeetingChoice: true,
        issueId: null,
      },
      "meetings",
    ),
  ).toEqual({
    config: { meetingIssue: "IRPT-12" },
    meetingOptions: [
      { key: "general", issue: "IRPT-12", label: "General", workItemText: "Reuniones" },
    ],
    requiresMeetingChoice: false,
    issueId: "IRPT-12",
    workItemText: "Reuniones",
  });
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

test("registers seven standard tools without workspace_root and guards mutations", async () => {
  const tools = createYouTrackTools({
    verifyToken: async () => ({}),
    context: async () => ({}),
    parseDuration: async () => ({ minutes: 30 }),
    postComment: async () => ({}),
    logTime: async () => ({}),
  });
  expect(Object.keys(tools).sort()).toEqual(
    [
      "workit_youtrack_verify_token",
      "workit_youtrack_parse_issue",
      "workit_youtrack_context",
      "workit_youtrack_parse_duration",
      "workit_youtrack_draft",
      "workit_youtrack_log_time",
      "workit_youtrack_post",
    ].sort(),
  );
  for (const definition of Object.values(tools)) {
    expect("workspace_root" in definition.args).toBe(false);
  }
  for (const name of ["workit_youtrack_log_time", "workit_youtrack_post"] as const) {
    const raw = await tools[name].execute(
      { confirmed: false } as never,
      { directory: "/repo", worktree: "/repo" } as never,
    );
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
  }
});

test.skipIf(process.platform === "win32")(
  "verify token, parse issue, parse duration, and draft tools execute",
  async () =>
    withYouTrackConfig(async () => {
      const tools = createYouTrackTools({
        verifyToken: async () => ({ data: { ok: true } }),
        context: async () => ({ data: { issueId: "NSR-1" } }),
        parseDuration: async () => ({ minutes: 30 }),
        postComment: async () => ({ data: { ok: true } }),
        logTime: async () => ({ data: { ok: true } }),
      });
      const ctx = { directory: "/repo", worktree: "/repo" } as never;

      const verify = JSON.parse(
        (await tools.workit_youtrack_verify_token.execute({}, ctx)) as string,
      );
      expect(verify.ok).toBe(true);

      const parsed = JSON.parse(
        (await tools.workit_youtrack_parse_issue.execute({ issue_ref: "NSR-40" }, ctx)) as string,
      );
      expect(parsed.ok).toBe(true);
      expect(parsed.data.issueId).toBe("NSR-40");

      const duration = JSON.parse(
        (await tools.workit_youtrack_parse_duration.execute({ text: "30m" }, ctx)) as string,
      );
      expect(duration.ok).toBe(true);
      expect(duration.data.minutes).toBe(30);

      const draft = JSON.parse(
        (await tools.workit_youtrack_draft.execute(
          {
            issueId: "NSR-40",
            userNotes: "Avance",
          },
          ctx,
        )) as string,
      );
      expect(draft.ok).toBe(true);
      expect(draft.data.markdown).toContain("Avance");
    }),
);

test.skipIf(process.platform === "win32")(
  "log_time and post tools execute with confirmed and redact tokens from errors",
  async () =>
    withYouTrackConfig(async () => {
      const tools = createYouTrackTools({
        verifyToken: async () => ({}),
        context: async () => ({}),
        parseDuration: async () => ({ minutes: 30 }),
        postComment: async () => ({ data: { ok: true } }),
        logTime: async () => ({ error: "boom with secret" }),
      });
      const ctx = { directory: "/repo", worktree: "/repo" } as never;

      const logged = JSON.parse(
        (await tools.workit_youtrack_log_time.execute(
          {
            confirmed: true,
            issueId: "NSR-1",
            minutes: 30,
          },
          ctx,
        )) as string,
      );
      expect(logged.ok).toBe(false);
      expect(logged.error).toContain("boom");

      const posted = JSON.parse(
        (await tools.workit_youtrack_post.execute(
          {
            confirmed: true,
            issueId: "NSR-1",
            markdown: "Actualización",
          },
          ctx,
        )) as string,
      );
      expect(posted.ok).toBe(true);
    }),
);

test.skipIf(process.platform === "win32")(
  "context tool normalizes meetings mode and rejects escaped paths",
  async () =>
    withYouTrackConfig(async () => {
      const tools = createYouTrackTools({
        verifyToken: async () => ({}),
        context: async (input: any) => ({
          data: { issueId: input.mode === "meetings" ? "MEET-1" : null },
        }),
        parseDuration: async () => ({ minutes: 30 }),
        postComment: async () => ({}),
        logTime: async () => ({}),
      });
      const ctx = { directory: "/repo", worktree: "/repo" } as never;
      const meetings = JSON.parse(
        (await tools.workit_youtrack_context.execute(
          {
            mode: "meetings",
          },
          ctx,
        )) as string,
      );
      expect(meetings.ok).toBe(true);

      const escaped = JSON.parse(
        (await tools.workit_youtrack_context.execute(
          {
            spec_path: "../outside.md",
          },
          ctx,
        )) as string,
      );
      expect(escaped.ok).toBe(false);
    }),
);
