// Stack-wide verdicts (#334): a verdict at the top of a stack covers a lower
// branch only when it judged that branch's exact code: its commits by
// verbatim patch-id (whitespace counts), its resulting files unchanged in the
// judged tree, and its own lane below full (decision B3). Fail closed.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLedger,
  recordVerdict,
  storeRoot,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";
import { checkVerdictsCovered } from "@/packages/workit-core/src/verdict-cover";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};

/** main, then feature/a with `lower`, then feature/b built by `upper`; a cached stack a → b. */
const stackRepo = (lower: Record<string, string>, upper: (root: string) => void): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-cover-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  commit(root, { "README.md": "# app\n" }, "base");
  git(root, "checkout", "-qb", "feature/a");
  commit(root, lower, "lower");
  git(root, "checkout", "-qb", "feature/b");
  upper(root);
  const stacks = path.join(value(storeRoot(root)).root, "stacks");
  mkdirSync(stacks, { recursive: true });
  writeFileSync(
    path.join(stacks, "s.json"),
    JSON.stringify({
      name: "s",
      trunk: "main",
      branches: [{ branch: "feature/a" }, { branch: "feature/b" }],
    }),
  );
  value(
    recordVerdict(
      { cwd: root, actor: { host: "cli", session: "reviewer-2", agentId: null } },
      { result: "verified", how: "exercised the stack", kind: "review" },
    ),
  );
  return root;
};

const lowerCover = (root: string) =>
  checkVerdictsCovered(root, "feature/a", value(readLedger(root, { integrity: true })).rows);

const PY_IN = "def f(x):\n    if x:\n        a()\n        b()\n";
const PY_OUT = "def f(x):\n    if x:\n        a()\n    b()\n";

test("Given a top verdict over unchanged lower code, When the lower branch is checked, Then the top verdict covers it", () => {
  const root = stackRepo({ "src/a.ts": "export const a = 1;\n" }, (r) =>
    commit(r, { "src/b.ts": "export const b = 1;\n" }, "upper"),
  );
  const result = lowerCover(root);
  expect(result.accepted.accepted).toBe(true);
  expect(result.cover).toMatchObject({ stack: "s", branch: "feature/b" });
});

test("Given the judged history carries the lower commit re-indented (same stable patch-id), When checked, Then the lower branch is not covered", () => {
  const root = stackRepo({ "m.py": PY_IN }, (r) => {
    // Rebuild the upper history from main with the lower commit re-indented,
    // then restore the lower file's content in a later commit.
    git(r, "reset", "-q", "--hard", "main");
    commit(r, { "m.py": PY_OUT }, "lower, re-indented");
    commit(r, { "m.py": PY_IN, "src/b.ts": "export const b = 1;\n" }, "upper");
  });
  const result = lowerCover(root);
  expect(result.cover).toBeNull();
  expect(result.accepted.accepted).toBe(false);
});

test("Given an upper commit rewrites a lower file, When checked, Then the lower branch is not covered", () => {
  const root = stackRepo({ "src/a.ts": "export const a = 1;\n" }, (r) =>
    commit(
      r,
      { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 1;\n" },
      "upper",
    ),
  );
  const result = lowerCover(root);
  expect(result.cover).toBeNull();
  expect(result.accepted.accepted).toBe(false);
});

test("Given the lower branch is lane full (a risk path), When checked, Then it needs its own verdict", () => {
  const root = stackRepo({ "src/auth/login.ts": "export const login = 1;\n" }, (r) =>
    commit(r, { "src/b.ts": "export const b = 1;\n" }, "upper"),
  );
  const result = lowerCover(root);
  expect(result.cover).toBeNull();
  expect(result.accepted.accepted).toBe(false);
});
