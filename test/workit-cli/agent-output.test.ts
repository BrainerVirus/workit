import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { runTaskCommand } from "@/packages/workit-cli/src/task";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { nextHint } from "@/packages/workit-core/src/forge/pr-ops";
import { summarizeRow, type ReadRow } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-agent-output-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "1\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  return root;
};

const row = (fields: Record<string, unknown>): ReadRow =>
  ({
    v: 1,
    id: "r1",
    at: "2030-01-01T00:00:00Z",
    seq: 1,
    superseded: false,
    supersedeIgnored: false,
    actor: { session: "s" },
    branch: "feature/x",
    head: "abcdef1234567890",
    ...fields,
  }) as unknown as ReadRow;

test("Given an ad-hoc check row that passed, When summarized, Then it shows the name, result and exit code", () => {
  expect(
    summarizeRow(row({ type: "check", name: "lint", result: "passed", exitCode: 0 })).summary,
  ).toBe("lint passed, exit 0");
  expect(
    summarizeRow(row({ type: "check", argv: ["bun", "x"], result: "failed", exitCode: 2 })).summary,
  ).toBe("bun x failed, exit 2");
});

test("Given merge and fanout rows, When summarized, Then none repeats its type", () => {
  for (const type of ["pr.merge.intent", "pr.merge.verified", "fanout.planned"])
    expect(summarizeRow(row({ type, pr: 7, method: "squash", fanout: "f" })).summary).not.toBe(
      type,
    );
});

test("Given a merged PR, When nextHint runs, Then it names verify-delivery", () => {
  expect(nextHint("MERGED", 7)).toBe("workit verify-delivery merged");
  expect(nextHint("CLOSED", 7)).toContain("closed");
});

test("Given no verdict on the branch, When ledger check renders, Then the last line is a next: command", async () => {
  const root = repo();
  let stdout = "";
  const code = await main(["ledger", "check"], {
    cwd: root,
    env: { ...process.env, WORKIT_SESSION_ID: "s-reviewer" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  const last = stdout.trim().split("\n").at(-1) ?? "";
  expect(last).toStartWith("next: workit ledger verdict");
});

test("Given a task, When task inspect renders human output, Then it prints the task line and exits 0", async () => {
  const root = repo();
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "test" },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
  });
  const started = core.task({
    schemaVersion: 1,
    action: "start",
    expectedWorkspaceRevision: null,
    intent: {
      objective: "do it",
      scope: { description: "checkout", paths: ["."], exclusions: [] },
      authorityRefs: [],
    },
  });
  if (!started.ok) throw new Error(started.error);
  const id = (started.data as { id: string }).id;
  let out = "";
  let err = "";
  const code = await runTaskCommand(["task", "inspect", "--task", id], {
    cwd: root,
    out: { write: (t: string) => void (out += t) },
    err: { write: (t: string) => void (err += t) },
  });
  expect(code).toBe(0);
  expect(out).toContain(id);
  expect(err).not.toContain("uncaught_failure");
});
