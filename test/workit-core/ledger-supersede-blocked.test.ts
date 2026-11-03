import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkVerdicts,
  readLedger,
  recordVerdict,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const featureRepo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-supersede-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "feature.txt"), "feature\n");
  git(root, "add", "feature.txt");
  git(root, "commit", "-qm", "feature work");
  return root;
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};
const check = (root: string) =>
  checkVerdicts(root, "feature/x", value(readLedger(root, { integrity: true })).rows);
const as = (root: string, session: string, supersedes?: string) => ({
  cwd: root,
  actor: { host: "cli", session, agentId: null },
  ...(supersedes ? { supersedes } : {}),
});

test("Given a blocked verdict, When the same session later records a verified verdict on the same code, Then the verified verdict is current", () => {
  const root = featureRepo();
  value(recordVerdict(as(root, "v1"), { result: "blocked", how: "could not finish" }));
  const verified = value(recordVerdict(as(root, "v1"), { result: "verified", how: "ran it" }));
  const result = check(root);
  expect(result.accepted.verdict?.id).toBe(verified.id);
  expect(result.accepted.accepted).toBe(true);
});

test("Given a failed verdict, When the same session records a verified verdict without superseding, Then the failure still stands", () => {
  const root = featureRepo();
  const failed = value(recordVerdict(as(root, "v1"), { result: "failed", how: "broken" }));
  value(recordVerdict(as(root, "v1"), { result: "verified", how: "ran it" }));
  const result = check(root);
  expect(result.accepted.verdict?.id).toBe(failed.id);
});

test("Given a blocked verdict, When a verified verdict supersedes it by ledger row number, Then the verified verdict is current", () => {
  const root = featureRepo();
  const blocked = value(recordVerdict(as(root, "v1"), { result: "blocked", how: "stuck" }));
  const seq = value(readLedger(root)).rows.find((row) => row.id === blocked.id)?.seq;
  const verified = value(
    recordVerdict(as(root, "v1", `#${String(seq)}`), { result: "verified", how: "ran it" }),
  );
  expect(value(readLedger(root)).rows.find((row) => row.id === verified.id)?.supersedes).toBe(
    blocked.id,
  );
  expect(check(root).accepted.verdict?.id).toBe(verified.id);
});

test("Given a bare number that names no row, When a verdict supersedes it, Then the error says so", () => {
  const root = featureRepo();
  const result = recordVerdict(as(root, "v1", "99"), { result: "verified", how: "x" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("no ledger row 99");
});

test("Given a directory outside any git checkout, When a verdict is recorded there, Then the error names --cwd", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-nogit-"));
  dirs.push(dir);
  const result = recordVerdict(as(dir, "v1"), { result: "verified", how: "x", kind: "review" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(`${result.error} ${result.unblock ?? ""}`).toContain("--cwd");
});
