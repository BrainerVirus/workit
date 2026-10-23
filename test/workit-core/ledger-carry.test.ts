// Wider verdict carry-over (#334, decision mvk5q3io): a verdict at head H
// still applies at H' when the branch's own change since H is review lane
// `none` (docs, comments or formatting, generated copies, an empty commit),
// or, for a `unit` verdict only, a small test-only change off risk paths.
// Anything else (behavior, a risk path, an opaque file, an unreadable diff,
// a row the gates cannot trust) is stale, and a stale verdict whose change is
// small and off risk paths asks only a focused re-verify of that change.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendObserved,
  checkVerdicts,
  ledgerPath,
  readLedger,
  recordVerdict,
  type LedgerResult,
  type VerdictKind,
  type VerdictResult,
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

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const write = (root: string, file: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

const commit = (root: string, files: Record<string, string | Buffer>, message: string) => {
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const APP = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

/** main with a README; feature/x adds src/app.ts and its test, checked out. */
const featureRepo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-carry-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  commit(root, { "README.md": "# app\n" }, "base");
  git(root, "checkout", "-qb", "feature/x");
  commit(
    root,
    {
      "src/app.ts": APP,
      "test/app.test.ts": 'import { add } from "../src/app";\nadd(1, 2);\n',
    },
    "feature",
  );
  return root;
};

const verdict = (root: string, kind: VerdictKind = "review", result: VerdictResult = "verified") =>
  value(
    recordVerdict(
      { cwd: root, actor: { host: "cli", session: "reviewer-2", agentId: null } },
      { result, how: "exercised it", kind },
    ),
  );

const check = (root: string) =>
  checkVerdicts(root, "feature/x", value(readLedger(root, { integrity: true })).rows);

test("Given a verified head, When a follow-up commit touches only README.md, Then the verdict carries with the lane-none reason", () => {
  const root = featureRepo();
  const judged = verdict(root);
  commit(root, { "README.md": "# app\n\nHow to use it.\n" }, "docs");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.current.basis).toBe("carried");
  expect(result.verdicts[0].carry).toEqual({
    rule: "lane-none",
    since: judged.head as string,
    files: ["README.md"],
  });
  expect(result.reverify).toBeNull();
});

test("Given a verified head, When an empty commit or a comment-only edit follows, Then the verdict carries", () => {
  const root = featureRepo();
  verdict(root);
  commit(root, {}, "ci: retrigger");
  expect(check(root).accepted.accepted).toBe(true);
  commit(root, { "src/app.ts": `// Adds two numbers.\n${APP}` }, "docs: comment");
  const result = check(root);
  expect(result.accepted.accepted).toBe(true);
  expect(result.verdicts[0].carry).toMatchObject({ rule: "lane-none", files: ["src/app.ts"] });
});

test("Given a verified head, When the follow-up changes source code, Then the verdict is stale and a focused re-verify names the file", () => {
  const root = featureRepo();
  const judged = verdict(root);
  commit(root, { "src/app.ts": APP.replace("a + b", "a + b + 0") }, "fix");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
  expect(result.current.basis).toBe("stale");
  expect(result.verdicts[0].carry).toBeNull();
  expect(result.reverify).toEqual({
    scope: "focused",
    since: judged.head as string,
    files: ["src/app.ts"],
  });
});

test("Given a unit verdict, When a small test-only change follows, Then it carries as tests-only", () => {
  const root = featureRepo();
  verdict(root, "unit", "tests-verified");
  commit(root, { "test/app.test.ts": 'import { add } from "../src/app";\nadd(2, 2);\n' }, "test");
  const result = check(root);
  expect(result.accepted.accepted).toBe(true);
  expect(result.verdicts[0].carry).toMatchObject({
    rule: "tests-only",
    files: ["test/app.test.ts"],
  });
});

test("Given a live or review verdict, When a test-only change follows, Then it does not carry and asks a focused re-verify", () => {
  for (const kind of ["live", "review"] as const) {
    const root = featureRepo();
    verdict(root, kind);
    commit(root, { "test/app.test.ts": "export {};\n" }, "test");
    const result = check(root);
    expect(result.accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
    expect(result.reverify).toMatchObject({ scope: "focused", files: ["test/app.test.ts"] });
  }
});

test("Given a verified head, When a comment-only edit lands on a risk path, Then the verdict is stale and no focused re-verify is offered", () => {
  const root = featureRepo();
  commit(root, { "src/auth/login.ts": "export const login = 1;\n" }, "auth");
  verdict(root);
  commit(root, { "src/auth/login.ts": "// Logs in.\nexport const login = 1;\n" }, "comment");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
  expect(result.reverify).toBeNull();
});

test("Given a unit verdict, When a binary or a lockfile changes, Then the verdict is stale", () => {
  const binary = featureRepo();
  verdict(binary, "unit");
  commit(binary, { "test/fixture.bin": Buffer.from([0, 1, 2, 0]) }, "fixture");
  expect(check(binary).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
  const lock = featureRepo();
  verdict(lock, "unit");
  commit(lock, { "bun.lock": "{}\n" }, "deps");
  expect(check(lock).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given a verified head, When the branch is rebased onto a moved main and then gets a docs commit, Then the verdict still carries", () => {
  const root = featureRepo();
  verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "src/other.ts": "export const other = 1;\n" }, "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "docs/usage.md": "Use add().\n" }, "docs");
  const result = check(root);
  expect(result.accepted.accepted).toBe(true);
  expect(result.verdicts[0].carry).toMatchObject({ rule: "lane-none", files: ["docs/usage.md"] });
});

test("Given a rebase that also rewrote the branch's code, When checked, Then the verdict is stale", () => {
  const root = featureRepo();
  verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "src/other.ts": "export const other = 1;\n" }, "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/app.ts": APP.replace("a + b", "b + a") }, "swap");
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given an independent failure, When a docs-only commit follows, Then the failure carries too and still blocks", () => {
  const root = featureRepo();
  verdict(root, "review", "failed");
  commit(root, { "README.md": "# app\n\nmore\n" }, "docs");
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
});

test("Given a hand-appended verdict, When a docs-only commit follows, Then it never carries", () => {
  const root = featureRepo();
  value(
    appendObserved(root, {
      type: "commit.recorded",
      actor: { host: "cli", session: "author", agentId: null },
      branch: "feature/x",
      session: "author",
      head: git(root, "rev-parse", "HEAD"),
    }),
  );
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({
      v: 1,
      id: "forged-1",
      at: new Date().toISOString(),
      type: "verdict",
      kind: "unit",
      result: "verified",
      how: "trust me",
      branch: "feature/x",
      head: git(root, "rev-parse", "HEAD"),
      base: "main",
      observer: "agent_asserted",
      self: false,
      selfReason: null,
      sessionSource: "env",
      actor: { host: "cli", session: "someone-else", agentId: null },
    })}\n`,
  );
  commit(root, { "README.md": "# app\n\nmore\n" }, "docs");
  const result = check(root);
  expect(result.verdicts[0]).toMatchObject({ basis: "stale", carry: null, accepted: false });
  expect(result.accepted.accepted).toBe(false);
});
