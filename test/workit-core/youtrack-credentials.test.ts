import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCredentials } from "@/packages/workit-core/src/core/youtrack-tools";

test("YouTrack credentials honor WORKFLOW_TOOLKIT_CONFIG pointing at the config dir", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-override-"));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify(
      { baseUrl: "https://yt.example.test", tokenFile: path.join(dir, "youtrack.token") },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "youtrack.token"), "override-token\n", { mode: 0o600 });
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    const credentials = await readCredentials();
    expect(credentials.token).toBe("override-token");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("YouTrack credentials honor WORKFLOW_TOOLKIT_CONFIG_DIR-only pointing at the config dir", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-guard-override-dir-"));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify(
      { baseUrl: "https://yt.example.test", tokenFile: path.join(dir, "youtrack.token") },
      null,
      2,
    ),
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
