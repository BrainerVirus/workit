import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateCheckNames,
  loadCheckConfig,
  matchesNamedCheck,
  splitCommand,
} from "@/packages/workit-core/src/check-config";
import {
  MAX_LOG_BYTES,
  redactLog,
  runCheckCommand,
  tailLines,
} from "@/packages/workit-core/src/checks";

// Named-check config and the bounded, redacted runner behind `workit check` (S9b).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dir = (files: Record<string, string> = {}): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-checks-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
  return root;
};

test("splitCommand groups quotes and refuses shell syntax", () => {
  expect(splitCommand(`bun test --filter "a b" 'c'`)).toEqual([
    "bun",
    "test",
    "--filter",
    "a b",
    "c",
  ]);
  for (const shell of ["bun test | tee x", "echo $HOME", "a && b", "ls *.ts", "x > y"])
    expect(splitCommand(shell)).toBeInstanceOf(Error);
  expect(splitCommand(`echo "open`)).toBeInstanceOf(Error);
  expect(splitCommand("   ")).toBeInstanceOf(Error);
});

test("workit.checks.json wins; argv must match exactly, from the repo top", () => {
  const root = dir({
    "workit.checks.json": JSON.stringify({
      checks: { test: "bun test", lint: ["bun", "run", "lint"] },
    }),
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }),
  });
  const config = loadCheckConfig(root);
  expect(config).toMatchObject({ source: "workit.checks.json", error: null });
  expect(config.checks.map((check) => check.name)).toEqual(["test", "lint"]);
  expect(matchesNamedCheck(config, "test", ["bun", "test"], ".")).toBe(true);
  expect(matchesNamedCheck(config, "test", ["bun", "test", "--bail"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "test", ["true"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "test", ["bun", "test"], "packages/x")).toBe(false);
  expect(matchesNamedCheck(config, null, ["bun", "test"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "typecheck", ["bun", "run", "typecheck"], ".")).toBe(false);
  expect(gateCheckNames(config, "testing")).toEqual(["test"]);
  expect(gateCheckNames(config, "verification")).toEqual(["test", "lint"]);
});

test("package.json scripts are named checks run through the lockfile's package manager", () => {
  const bun = loadCheckConfig(
    dir({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { test: "x", build: "y" } }) }),
  );
  expect(bun.source).toBe("package.json");
  expect(bun.checks).toEqual([
    { name: "test", argv: ["bun", "run", "test"], accepts: [["bun", "run", "test"]] },
  ]);
  // `bun test` is bun's own runner, not the script.
  expect(matchesNamedCheck(bun, "test", ["bun", "test"], ".")).toBe(false);
  const npm = loadCheckConfig(
    dir({ "package.json": JSON.stringify({ scripts: { test: "x", lint: "y" } }) }),
  );
  expect(matchesNamedCheck(npm, "test", ["npm", "test"], ".")).toBe(true);
  expect(matchesNamedCheck(npm, "lint", ["npm", "lint"], ".")).toBe(false);
  const pnpm = loadCheckConfig(
    dir({ "pnpm-lock.yaml": "", "package.json": JSON.stringify({ scripts: { lint: "y" } }) }),
  );
  expect(matchesNamedCheck(pnpm, "lint", ["pnpm", "lint"], ".")).toBe(true);
  expect(loadCheckConfig(dir())).toMatchObject({ source: "none", checks: [], error: null });
  expect(gateCheckNames(loadCheckConfig(dir()), "testing")).toEqual([]);
});

test("a broken workit.checks.json is an error, and nothing matches it", () => {
  for (const text of [
    "{",
    JSON.stringify({ checks: [] }),
    JSON.stringify({ checks: { test: "a | b" } }),
    JSON.stringify({ checks: { "Bad Name": "x" } }),
  ]) {
    const config = loadCheckConfig(dir({ "workit.checks.json": text }));
    expect(config.error, text).toBeString();
    expect(matchesNamedCheck(config, "test", ["a"], ".")).toBe(false);
  }
});

test("redactLog masks tokens, key=value secrets, URL credentials and escapes", () => {
  const out = redactLog(
    [
      "\u001b[31mFAIL\u001b[0m",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "clone https://user:hunter2@example.com/repo.git",
      "auth: Bearer abcdefghijklmnop",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n"),
  );
  expect(out).toContain("FAIL");
  expect(out).not.toContain("\u001b");
  for (const secret of ["ghp_abcdefghij", "hunter2", "abcdefghijklmnop", "MIIabc"])
    expect(out).not.toContain(secret);
});

test("tailLines keeps the last lines, bounded in width", () => {
  const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  expect(tailLines(`${text}\n\n`, 3)).toEqual(["line 197", "line 198", "line 199"]);
  expect(tailLines("x".repeat(1000), 1)[0]).toHaveLength(401);
});

test("runCheckCommand streams output, keeps only the newest bytes, and mirrors the exit code", async () => {
  let streamed = 0;
  const big = await runCheckCommand(
    [
      process.execPath,
      "-e",
      `process.stdout.write("x".repeat(${MAX_LOG_BYTES}) + "\\nlast line\\n"); process.exitCode = 7`,
    ],
    { cwd: os.tmpdir(), onStdout: (text) => void (streamed += text.length) },
  );
  expect(big.exitCode).toBe(7);
  expect(streamed).toBe(MAX_LOG_BYTES + 11);
  expect(big.truncated).toBe(true);
  expect(Buffer.byteLength(big.log)).toBeLessThanOrEqual(MAX_LOG_BYTES);
  expect(tailLines(big.log, 1)).toEqual(["last line"]);
  const missing = await runCheckCommand(["workit-no-such-binary-xyz"], { cwd: os.tmpdir() });
  expect(missing).toMatchObject({ exitCode: 127, spawnError: "ENOENT" });
});
