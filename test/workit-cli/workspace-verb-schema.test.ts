// #614: the files `workit workspace set` and setup write start with "$schema",
// so an editor opening them gets completion; a user's own value is kept and
// Workit reads the file back unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySetupPreview } from "@/packages/workit-cli/src/admin/setup";
import { buildSetupPreview } from "@/packages/workit-cli/src/logic";
import type { Io } from "@/packages/workit-cli/src/output";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";
import { createInitialDraft } from "@/packages/workit-cli/src/wizard-state";
import { readConfigFromDir } from "@/packages/workit-core/src/core/config";
import { readWorkspacesResult } from "@/packages/workit-core/src/core/workspaces";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

const SCHEMA = "https://unpkg.com/@brainervirus/workit-core/schemas/workspaces.json";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-workspace-schema-");
});
afterAll(() => configHome.restore());

const file = () => path.join(configHome.configDir, "workspaces.json");
const ENTRY = { name: "work", glob: "/home/u/work/**", vcs: { provider: "github" } };

beforeEach(() => {
  writeFileSync(file(), `${JSON.stringify({ workspaces: [ENTRY] }, null, 2)}\n`);
});
afterEach(() => {
  for (const name of [file(), `${file()}.bak`]) rmSync(name, { force: true });
});

const set = async (...pairs: string[]) => {
  const io: Io = {
    json: true,
    cwd: configHome.home,
    env: { CLAUDECODE: "1" },
    stdout: () => undefined,
    stderr: () => undefined,
  };
  return runWorkspace(["set", "work", ...pairs], io);
};

test("Given a workspaces.json without $schema, When workspace set rewrites it, Then $schema comes first and Workit reads it unchanged", async () => {
  expect(await set("changelog=update")).toBe(0);
  const text = readFileSync(file(), "utf8");
  expect(text.startsWith(`{\n  "$schema": "${SCHEMA}",\n  "workspaces"`)).toBe(true);
  const read = readWorkspacesResult(configHome.configDir);
  expect(read.status).toBe("valid");
  expect(read.entries).toEqual([{ ...ENTRY, changelog: "update" }]);
});

test("Given a user's own $schema, When workspace set rewrites the file, Then that value is kept", async () => {
  writeFileSync(
    file(),
    `${JSON.stringify({ workspaces: [ENTRY], $schema: "./local-schema.json" }, null, 2)}\n`,
  );
  expect(await set("docs=when-user-facing")).toBe(0);
  const written = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)[0]).toBe("$schema");
  expect(written.$schema).toBe("./local-schema.json");
});

test("Given setup writing config.json and workspaces.json, Then each starts with its $schema, and a user's config.json value is kept", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-setup-schema-"));
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      `${JSON.stringify({ $schema: "./mine.json", locale: "es" }, null, 2)}\n`,
    );
    const draft = createInitialDraft(readConfigFromDir(dir));
    draft.values.workspaces = [{ ...ENTRY }];
    draft.values.locale = "en";
    const preview = buildSetupPreview(draft.values, { dir, cwd: dir, env: {} });
    expect(preview.ok).toBe(true);
    applySetupPreview(preview, { configDir: dir, cwd: dir, env: {} });

    const workspaces = JSON.parse(readFileSync(path.join(dir, "workspaces.json"), "utf8"));
    expect(Object.keys(workspaces)[0]).toBe("$schema");
    expect(workspaces.$schema).toBe(SCHEMA);
    expect(readWorkspacesResult(dir).status).toBe("valid");

    const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(Object.keys(config)[0]).toBe("$schema");
    expect(config.$schema).toBe("./mine.json");
    expect(readConfigFromDir(dir).locale).toBe("en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
