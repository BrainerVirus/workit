import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { readLedger } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (root: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
};

const branchWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-deslop-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  write(root, { "src/calc.ts": "export const one = 1;\n" });
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  write(root, files);
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature");
  return root;
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKIT_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const NARRATION = [
  "export const one = 1;",
  "export function total(items: number[]): number {",
  "  // start the sum at zero",
  "  let sum = 0;",
  "  // add each item to the sum",
  "  for (const item of items) sum += item;",
  "  return sum;",
  "}",
  "",
].join("\n");

const CLI = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");

test("Given a diff adding narration comments, When deslop scan --diff runs with only git on PATH, Then it lists each with file:line and class, spawning nothing but a bounded number of git calls", () => {
  const root = branchWith({ "src/calc.ts": NARRATION });
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is not on PATH");
  const bin = mkdtempSync(path.join(os.tmpdir(), "wk-deslop-bin-"));
  dirs.push(bin);
  const log = path.join(bin, "git.log");
  writeFileSync(log, "");
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [CLI, "deslop", "scan", "--diff", "main"], {
    cwd: root,
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: bin,
      WORKIT_SESSION_ID: "s-agent",
      WORKIT_CONFIG: path.join(root, ".config-workit"),
      WORKIT_STATE_DIR: path.join(root, ".state-workit"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("src/calc.ts:3  narration  start the sum at zero");
  expect(result.stdout).toContain("src/calc.ts:5  narration  add each item to the sum");
  const gitCalls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  expect(gitCalls.length).toBeGreaterThan(0);
  expect(gitCalls.length).toBeLessThanOrEqual(20);
});

test("Given a diff adding a licence header, a prettier-ignore and an issue link, When scanned with --json, Then they are classed allowed", async () => {
  const root = branchWith({
    "src/matrix.ts": [
      "// SPDX-License-Identifier: MIT",
      "// prettier-ignore",
      "export const matrix = [1,0,",
      "                       0,1];",
      "// the gateway drops the first request after idle, see #412",
      "export const retries = 2;",
      "",
    ].join("\n"),
  });
  const result = await run(root, ["deslop", "scan", "--diff", "main", "--json"]);
  expect(result.code).toBe(0);
  const findings = result.json().data.findings;
  expect(
    findings.map((finding: { line: number; class: string }) => [finding.line, finding.class]),
  ).toEqual([
    [1, "allowed"],
    [2, "allowed"],
    [5, "allowed"],
  ]);
});

test("Given lane self and a new eslint-disable or oxlint-disable, When scanned, Then the result raises the lane to focused and names its passes", async () => {
  for (const directive of [
    "eslint-disable-next-line no-console",
    "oxlint-disable-next-line no-console",
  ]) {
    const root = branchWith({
      "src/log.ts": `export function log(text: string) {\n  // ${directive}\n  console.info(text);\n}\n`,
    });
    const result = await run(root, ["deslop", "scan", "--lane", "self", "--json"]);
    expect(result.code).toBe(0);
    const data = result.json().data;
    expect(data.lane).toMatchObject({ from: "self", lane: "focused", source: "flag" });
    expect(data.counts.suppression).toBe(1);
    expect(data.passes.map((pass: { id: string }) => pass.id)).toContain("no-comments");
    expect(data.passes.map((pass: { id: string }) => pass.id)).toContain("test-quality");
  }
});

test("Given a small behaviour change with no suppression, When scanned without --lane, Then the diff's own lane is kept", async () => {
  const root = branchWith({ "src/calc.ts": "export const one = 1;\nexport const two = 2;\n" });
  const data = (await run(root, ["deslop", "scan", "--json"])).json().data;
  expect(data.lane).toMatchObject({ from: "self", lane: "self", source: "diff" });
  expect(data.findings).toEqual([]);
});

test("Given a changed test asserting call order on an internal mock, When deslop scans, Then test-audit's finding is part of the scan", async () => {
  const root = branchWith({
    "test/calc.test.ts": [
      'import { expect, mock, test } from "bun:test";',
      'import * as store from "../src/store";',
      'import { total } from "../src/calc";',
      'test("saves after loading", () => {',
      '  const load = mock.method(store, "load");',
      '  const save = mock.method(store, "save");',
      "  total([1]);",
      "  expect(load).toHaveBeenCalledBefore(save);",
      "});",
      "",
    ].join("\n"),
  });
  const data = (await run(root, ["deslop", "scan", "--json"])).json().data;
  expect(
    data.testAudit.findings.map((finding: { rule: string; line: number }) => [
      finding.rule,
      finding.line,
    ]),
  ).toEqual([["mock-call-order", 8]]);
});

test("Given a finished deslop, When deslop result runs, Then one result line is recorded in the ledger", async () => {
  const root = branchWith({ "src/calc.ts": NARRATION });
  const result = await run(root, [
    "deslop",
    "result",
    "--lane",
    "focused",
    "--removed",
    "42",
    "--reshapes",
    "3",
    "--open",
    "1",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("deslop: lane focused, -42 lines, 3 reshapes, 1 open");
  const ledger = readLedger(root);
  expect(ledger.ok).toBe(true);
  const rows = ledger.ok ? ledger.value.rows.filter((row) => row.type === "deslop.result") : [];
  expect(rows.map((row) => [row.what, row.branch])).toEqual([
    ["deslop: lane focused, -42 lines, 3 reshapes, 1 open", "feature/x"],
  ]);
});

test("Given deslop result without --removed, Then it refuses with the usage", async () => {
  const root = branchWith({ "src/calc.ts": NARRATION });
  const result = await run(root, ["deslop", "result", "--lane", "self"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("--removed <n> is required");
});
