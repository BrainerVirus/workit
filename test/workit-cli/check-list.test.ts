import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { run as checkVerb } from "@/packages/workit-cli/src/verbs/check";

// Retro 2026-11-17 C10: agents guessed check names. `workit check --list`
// and bare `workit check` print the configured names with their commands.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = (config: Record<string, unknown>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-check-list-"));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(path.join(root, ".workit", "checks.json"), JSON.stringify(config));
  return root;
};

const ENV = { ...process.env, WORKIT_SESSION_ID: "s-list", WORKIT_WORKSPACE_ROOT: "" };

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: ENV,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

/** The check verb on its own, past main's flag check. */
const verb = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await checkVerb(argv, {
    cwd,
    env: ENV,
    json: argv.includes("--json"),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

const CONFIG = {
  checks: { unit: ["sh", "scripts/unit.sh"], types: ["sh", "scripts/types.sh"] },
  groups: { ci: ["unit", "types"] },
};

for (const [label, call] of [
  ["workit check --list", (root: string) => run(root, ["check", "--list"])],
  ["the check verb with --list", (root: string) => verb(root, ["--list"])],
  ["workit check", (root: string) => run(root, ["check"])],
] as const)
  test(`G configured checks, W \`${label}\`, T each name prints with its command and the run exits 0`, async () => {
    const result = await call(repo(CONFIG));

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^\s+unit\s+sh scripts\/unit\.sh$/mu);
    expect(result.stdout).toMatch(/^\s+types\s+sh scripts\/types\.sh$/mu);
    expect(result.stdout).toMatch(/^\s+ci\s+group: unit, types$/mu);
  });

test("G configured checks, W `workit check --list --json`, T the envelope lists names, commands and groups", async () => {
  const result = await run(repo(CONFIG), ["check", "--list", "--json"]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: {
      checks: [
        { name: "unit", argv: ["sh", "scripts/unit.sh"] },
        { name: "types", argv: ["sh", "scripts/types.sh"] },
      ],
      groups: { ci: ["unit", "types"] },
    },
  });
});

test("G a guessed name, W `workit check test`, T it still fails naming the configured checks", async () => {
  const result = await run(repo(CONFIG), ["check", "test"]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('no configured check named "test"');
  expect(result.stderr).toContain("workit check unit|types");
});

test("Given a repo that configures only test, When `workit check lint` runs, Then the error lists test and ends with the ad-hoc Retry as", async () => {
  const result = await run(repo({ checks: { test: "true" } }), ["check", "lint"]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('no configured check named "lint"; configured: test');
  expect(result.stderr.trimEnd()).toEndWith("Retry as: workit check --name lint -- <command>");
});
