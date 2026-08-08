import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_ITEM_IDS, configGuardError, CONFIG_GAP_MARKER, describeConfigGaps } from "../src/core/config-guard";
import { createYouTrackTools } from "../src/tools/youtrack";

const withXdgConfig = async (dir: string, fn: () => Promise<void> | void) => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("empty config dir reports all item ids missing without throwing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-empty-"));
  await withXdgConfig(dir, () => {
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
  await withXdgConfig(dir, () => {
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
  await withXdgConfig(dir, async () => {
    const raw = await tools.workflow_youtrack_log_time.execute(
      { confirmed: true, issueId: "NSR-1", minutes: 30 }, ctx,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(CONFIG_GAP_MARKER);
    expect(result.error).not.toContain("ENOENT");
  });
});
