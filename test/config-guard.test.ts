import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_ITEM_IDS, configGuardError, CONFIG_GAP_MARKER, describeConfigGaps } from "../src/core/config-guard";
import { createYouTrackTools, readCredentials } from "../src/tools/youtrack";

const withIsolatedConfig = async (dir: string, fn: () => Promise<void> | void) => {
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
    WORKFLOW_TOOLKIT_CONFIG_DIR: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  };
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
};

test("empty config dir reports all item ids missing without throwing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-empty-"));
  await withIsolatedConfig(dir, () => {
    const gaps = describeConfigGaps();
    expect(gaps.ok).toBe(false);
    expect(gaps.missing).toEqual(ALL_ITEM_IDS);
  });
});

test("partial config reports only youtrack_token when scoped, plus vcs ids unscoped", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-partial-"));
  mkdirSync(path.join(dir, "workflow-toolkit"), { recursive: true });
  writeFileSync(
    path.join(dir, "workflow-toolkit", "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", tokenFile: "./token" }, null, 2),
    "utf8",
  );
  await withIsolatedConfig(dir, () => {
    const scoped = describeConfigGaps(["youtrack_json", "youtrack_token"]);
    expect(scoped.missing).toEqual(["youtrack_token"]);
    const unscoped = describeConfigGaps();
    expect(unscoped.missing).not.toContain("youtrack_json");
    for (const id of ["youtrack_token", "vcs_json", "gitlab_token", "github_token"]) {
      expect(unscoped.missing).toContain(id);
    }
  });
});

test("configGuardError contains marker, missing ids, and fix path", () => {
  const error = configGuardError(["youtrack_json", "youtrack_token"]);
  expect(error).toContain(CONFIG_GAP_MARKER);
  expect(error).toContain("youtrack_json, youtrack_token");
  expect(error).toContain("npx flowkit init");
});

test("youtrack tools return structured config-gap error instead of raw ENOENT", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-tool-"));
  const tools = createYouTrackTools();
  const ctx = { directory: "/repo", worktree: "/repo" } as never;
  await withIsolatedConfig(dir, async () => {
    const raw = await tools.workflow_youtrack_log_time.execute(
      { confirmed: true, issueId: "NSR-1", minutes: 30 }, ctx,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(CONFIG_GAP_MARKER);
    expect(result.error).not.toContain("ENOENT");
  });
});

test("youtrack tools honor WORKFLOW_TOOLKIT_CONFIG pointing at the config dir", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-override-"));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", tokenFile: path.join(dir, "youtrack.token") }, null, 2),
    "utf8",
  );
  writeFileSync(path.join(dir, "youtrack.token"), "override-token\n", { mode: 0o600 });
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    const scoped = describeConfigGaps(["youtrack_json", "youtrack_token"]);
    expect(scoped.ok).toBe(true);
    const credentials = await readCredentials();
    expect(credentials.token).toBe("override-token");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("youtrack tools honor WORKFLOW_TOOLKIT_CONFIG_DIR-only pointing at the config dir", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-override-dir-"));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", tokenFile: path.join(dir, "youtrack.token") }, null, 2),
    "utf8",
  );
  writeFileSync(path.join(dir, "youtrack.token"), "dir-override-token\n", { mode: 0o600 });
  const previous = {
    WORKFLOW_TOOLKIT_CONFIG_DIR: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
  };
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    const scoped = describeConfigGaps(["youtrack_json", "youtrack_token"]);
    expect(scoped.ok).toBe(true);
    const credentials = await readCredentials();
    expect(credentials.token).toBe("dir-override-token");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
