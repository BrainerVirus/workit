// #614: `workit doctor` checks each config file against its published JSON
// Schema and names the file and the JSON path of every bad value.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";

const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-schema-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
const row = (files: Record<string, unknown>) => {
  const configDir = path.join(scratch, `config-${count++}`);
  mkdirSync(configDir, { recursive: true });
  for (const [name, value] of Object.entries(files))
    writeFileSync(path.join(configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  return runDoctor({
    host: "cli",
    cwd: scratch,
    home: scratch,
    configDir,
    stateDir: path.join(scratch, "state"),
    env: { PATH: process.env.PATH ?? "", WORKFLOW_TOOLKIT_CONFIG: configDir },
  }).checks.find((check) => check.id === "config_schema")!;
};

test("Given a workspaces.json with an invalid value, When doctor runs, Then it names the file and the JSON path", () => {
  const check = row({
    "workspaces.json": {
      workspaces: [{ name: "work", glob: "/home/u/work/**", changelog: "sometimes", typo: true }],
    },
  });
  expect(check.status).toBe("warn");
  const file = path.join(scratch, `config-${count - 1}`, "workspaces.json");
  expect(check.detail).toContain(
    `${file} workspaces[0].changelog: "sometimes" is not one of off|update|create`,
  );
  expect(check.detail).toContain(`${file} workspaces[0].typo: unknown key "typo"`);
});

test("Given config files that match their schemas, When doctor runs, Then the row passes", () => {
  const check = row({
    "workspaces.json": {
      $schema: "https://unpkg.com/@brainervirus/workit-core/schemas/workspaces.json",
      workspaces: [{ name: "work", glob: "/home/u/work/**", changelog: "update" }],
    },
    "config.json": { locale: "en", updates: "prompt" },
  });
  expect(check.status).toBe("pass");
});
