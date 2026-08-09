import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTemplate, writeTemplate, listTemplates } from "../../packages/workit-core/src/core/templates";

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
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("writeTemplate then readTemplate returns config source", () => {
  const dir = cfgDir();
  try {
    const written = writeTemplate("issue-update", "# Mi template\n\n{{userNotes}}\n", true);
    expect(written.ok).toBe(true);
    const tpl = readTemplate("issue-update");
    expect(tpl.source).toBe("config");
    expect(tpl.content).toContain("Mi template");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("writeTemplate requires confirmed", () => {
  const dir = cfgDir();
  try {
    const no = writeTemplate("issue-update", "x", false);
    expect(no.ok).toBe(false);
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("listTemplates reports sources", () => {
  const dir = cfgDir();
  try {
    writeTemplate("greeting", "hola", true);
    const list = listTemplates();
    const issue = list.find((t) => t.name === "issue-update");
    const greeting = list.find((t) => t.name === "greeting");
    expect(issue?.source).toBe("repo");
    expect(greeting?.source).toBe("config");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});
