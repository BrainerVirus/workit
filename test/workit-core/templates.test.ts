import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTemplate } from "@/packages/workit-core/src/core/templates";

const savedEnv = new Map<string, string | undefined>();

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-templates-"));
  savedEnv.set("WORKFLOW_TOOLKIT_CONFIG", process.env.WORKFLOW_TOOLKIT_CONFIG);
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  return dir;
};

const cleanupEnv = () => {
  const value = savedEnv.get("WORKFLOW_TOOLKIT_CONFIG");
  if (value === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = value;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  savedEnv.clear();
};

test("readTemplate falls back to repo when config template missing", () => {
  const dir = cfgDir();
  try {
    const tpl = readTemplate("issue-update");
    expect(tpl.source).toBe("repo");
    expect(tpl.content.length).toBeGreaterThan(0);
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a user config template overrides the repo template", () => {
  const dir = cfgDir();
  try {
    mkdirSync(path.join(dir, "templates"), { recursive: true });
    writeFileSync(
      path.join(dir, "templates", "issue-update.md"),
      "# Mi template\n\n{{userNotes}}\n",
    );
    const tpl = readTemplate("issue-update");
    expect(tpl.source).toBe("config");
    expect(tpl.content).toContain("Mi template");
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});
