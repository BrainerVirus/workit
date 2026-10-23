// workit doctor `checks_config` and `--fix`: the per-repo checks config lives in
// the self-ignoring `.workit/`; a root `workit.checks.json` is a legacy location.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixChecksConfig, runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { checksConfigFile, ensureWorkitDir } from "@/packages/workit-core/src/check-config";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-checks-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

let count = 0;
const repo = (files: Record<string, string>): string => {
  const root = path.join(scratch, `repo-${count++}`);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
};

const row = (cwd: string) =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd,
    configDir: path.join(scratch, "config"),
    stateDir: path.join(scratch, "state"),
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
  }).checks.find((check) => check.id === "checks_config")!;

const CONFIG = JSON.stringify({ checks: { test: "bun test" } });

test("Given only a root workit.checks.json, When doctor runs, Then checks_config warns and names .workit/checks.json", () => {
  const found = row(repo({ "workit.checks.json": CONFIG }));
  expect(found.status).toBe("warn");
  expect(found.fix).toContain(".workit/checks.json");
});

test("Given .workit/checks.json only, When doctor runs, Then checks_config passes", () => {
  expect(row(repo({ ".workit/checks.json": CONFIG })).status).toBe("pass");
});

test("Given both files, When doctor runs, Then it warns that the root file is ignored", () => {
  const found = row(repo({ ".workit/checks.json": CONFIG, "workit.checks.json": CONFIG }));
  expect(found.status).toBe("warn");
  expect(found.detail).toContain("ignored");
});

test("Given a root workit.checks.json, When --fix runs, Then it moves into .workit/ and the checkout stays clean", () => {
  const root = repo({ "workit.checks.json": CONFIG });
  spawnSync("git", ["init", "-q"], { cwd: root });
  expect(fixChecksConfig({ cwd: root })).toMatchObject({ action: "moved" });
  expect(existsSync(path.join(root, "workit.checks.json"))).toBe(false);
  expect(readFileSync(checksConfigFile(root), "utf8")).toBe(CONFIG);
  expect(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout).toBe(
    "",
  );
  expect(row(root).status).toBe("pass");
});

test("Given both files, When --fix runs, Then neither is overwritten", () => {
  const root = repo({
    ".workit/checks.json": CONFIG,
    "workit.checks.json": '{"checks":{"old":"true"}}',
  });
  expect(fixChecksConfig({ cwd: root })).toMatchObject({ action: "skipped" });
  expect(existsSync(path.join(root, "workit.checks.json"))).toBe(true);
  expect(readFileSync(path.join(root, ".workit/checks.json"), "utf8")).toBe(CONFIG);
});

test("Given a fresh repo, When a checks config is written under ensureWorkitDir, Then git sees nothing untracked", () => {
  const root = repo({});
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(ensureWorkitDir(root), "checks.json"), CONFIG);
  expect(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout).toBe(
    "",
  );
});

test("Given a .workit/.gitignore, When ensureWorkitDir runs, Then risk-paths is not ignored, the old `*` is rewritten and a custom file is kept", () => {
  const root = repo({});
  spawnSync("git", ["init", "-q"], { cwd: root });
  const ignore = path.join(ensureWorkitDir(root), ".gitignore");
  expect(readFileSync(ignore, "utf8")).toBe("*\n!risk-paths\n");
  writeFileSync(path.join(root, ".workit/risk-paths"), "src/billing/**\n");
  writeFileSync(path.join(root, ".workit/checks.json"), CONFIG);
  const status = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(status.stdout).toContain(".workit/risk-paths");
  expect(status.stdout).not.toContain("checks.json");
  writeFileSync(ignore, "*\n");
  ensureWorkitDir(root);
  expect(readFileSync(ignore, "utf8")).toBe("*\n!risk-paths\n");
  writeFileSync(ignore, "*\n!mine\n");
  ensureWorkitDir(root);
  expect(readFileSync(ignore, "utf8")).toBe("*\n!mine\n");
});
