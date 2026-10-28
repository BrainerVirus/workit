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
  carryLabel,
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
      {
        cwd: root,
        actor: { host: "cli", session: "reviewer-2", agentId: null },
      },
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
  expect(result.verdicts[0].carry).toMatchObject({
    rule: "lane-none",
    files: ["src/app.ts"],
  });
});

test("Given a verified head, When the follow-up changes source code, Then the verdict is stale and a focused re-verify names the file", () => {
  const root = featureRepo();
  const judged = verdict(root);
  commit(root, { "src/app.ts": APP.replace("a + b", "a + b + 0") }, "fix");
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
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
    expect(result.accepted).toMatchObject({
      accepted: false,
      reasons: ["stale"],
    });
    expect(result.reverify).toMatchObject({
      scope: "focused",
      files: ["test/app.test.ts"],
    });
  }
});

test("Given a verified head, When a comment-only edit lands on a risk path, Then the verdict is stale and no focused re-verify is offered", () => {
  const root = featureRepo();
  commit(root, { "src/auth/login.ts": "export const login = 1;\n" }, "auth");
  verdict(root);
  commit(root, { "src/auth/login.ts": "// Logs in.\nexport const login = 1;\n" }, "comment");
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  expect(result.reverify).toBeNull();
});

test("Given a unit verdict, When a binary or a lockfile changes, Then the verdict is stale", () => {
  const binary = featureRepo();
  verdict(binary, "unit");
  commit(binary, { "test/fixture.bin": Buffer.from([0, 1, 2, 0]) }, "fixture");
  expect(check(binary).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  const lock = featureRepo();
  verdict(lock, "unit");
  commit(lock, { "bun.lock": "{}\n" }, "deps");
  expect(check(lock).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
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
  expect(result.verdicts[0].carry).toMatchObject({
    rule: "lane-none",
    files: ["docs/usage.md"],
  });
});

test("Given a rebase that also rewrote the branch's code, When checked, Then the verdict is stale", () => {
  const root = featureRepo();
  verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "src/other.ts": "export const other = 1;\n" }, "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/app.ts": APP.replace("a + b", "b + a") }, "swap");
  expect(check(root).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
});

test("Given an independent failure, When a docs-only commit follows, Then the failure carries too and still blocks", () => {
  const root = featureRepo();
  verdict(root, "review", "failed");
  commit(root, { "README.md": "# app\n\nmore\n" }, "docs");
  expect(check(root).accepted).toMatchObject({
    accepted: false,
    reasons: ["failing_verdict"],
  });
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
  expect(result.verdicts[0]).toMatchObject({
    basis: "stale",
    carry: null,
    accepted: false,
  });
  expect(result.accepted.accepted).toBe(false);
});

// ---------------------------------------------------------------------------
// Exact carry (#334 review): patch-ids and the diff hash drop hunk line
// numbers, so after a rebase the same edit moved within a file looked
// unchanged. Carry now needs the branch's own files to be identical blobs.

/** A function whose early return sits behind three identical context lines. */
const ROLE = (name: string, early: string) =>
  `export function ${name}(u: unknown): boolean {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  if (u) return ${early};\n  const d = 4;\n  const e = 5;\n  return !!(a + b + c + d + e);\n}\n`;
const ROLES = (admin: string, guest: string) => ROLE("isAdmin", admin) + ROLE("isGuest", guest);

/**
 * main and feature/x both hold src/roles.ts; the branch flips isAdmin and is
 * judged. Then main moves, and the branch is rebased with the flip moved to
 * isGuest instead (plus `extra` files). Returns the judged verdict.
 */
const movedHunkAfterRebase = (root: string, extra: Record<string, string>) => {
  git(root, "checkout", "-q", "main");
  commit(root, { "src/roles.ts": ROLES("false", "false") }, "roles");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/roles.ts": ROLES("true", "false") }, "admin early true");
  const judged = verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "NOTES.md": "n\n" }, "main moves");
  git(root, "checkout", "-q", "feature/x");
  git(root, "reset", "-q", "--hard", "HEAD~1");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/roles.ts": ROLES("false", "true"), ...extra }, "guest early true");
  return judged;
};

test("Given a rebase that moved the judged edit from isAdmin to isGuest (same context), When checked, Then the verdict is stale", () => {
  const root = featureRepo();
  movedHunkAfterRebase(root, {});
  const result = check(root);
  expect(result.current.basis).toBe("stale");
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
});

test("Given the moved edit after a rebase plus a docs file, When checked, Then the verdict is stale, not carried as lane none", () => {
  const root = featureRepo();
  movedHunkAfterRebase(root, { "docs/x.md": "hi\n" });
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  expect(result.verdicts[0].carry).toBeNull();
  expect(result.reverify?.files).toContain("src/roles.ts");
});

test("Given a pure rebase whose base also edited a branch file, When checked, Then the verdict is stale (the base change in that file is drift)", () => {
  const root = featureRepo();
  verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "test/app.test.ts": "// base side\n" }, "main edits a branch file");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "-X", "theirs", "main");
  expect(check(root).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
});

test("Given a CLI-observed patch-equal restack row over a moved edit, When checked, Then it does not carry", () => {
  const root = featureRepo();
  git(root, "checkout", "-q", "main");
  commit(root, { "src/roles.ts": ROLES("false", "false") }, "roles");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const fromBase = git(root, "rev-parse", "main");
  const fromHead = commit(root, { "src/roles.ts": ROLES("true", "false") }, "admin early true");
  verdict(root);
  git(root, "checkout", "-q", "main");
  const toBase = commit(root, { "NOTES.md": "n\n" }, "main moves");
  git(root, "checkout", "-q", "feature/x");
  git(root, "reset", "-q", "--hard", "HEAD~1");
  git(root, "rebase", "-q", "main");
  const head = commit(root, { "src/roles.ts": ROLES("false", "true") }, "guest early true");
  const restacked = (to: string) =>
    value(
      appendObserved(root, {
        type: "stack.restacked",
        actor: { host: "cli", session: "author", agentId: null },
        stack: "s",
        branch: "feature/x",
        head: to,
        fromHead,
        fromBase,
        toBase,
        patchEqual: true,
        forced: false,
      }),
    );
  restacked(head);
  expect(check(root).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  // Control: the same row over an identical restack carries.
  git(root, "reset", "-q", "--hard", "HEAD~1");
  const same = commit(root, { "src/roles.ts": ROLES("true", "false") }, "admin early true");
  restacked(same);
  expect(check(root).accepted.accepted).toBe(true);
});

test("Given a verified head, When requirements.txt gains a dependency and CMakeLists.txt a compile definition, Then the verdict does not carry", () => {
  const root = featureRepo();
  commit(root, { "requirements.txt": "flask==2.0\n", "CMakeLists.txt": "project(app)\n" }, "deps");
  verdict(root);
  commit(
    root,
    {
      "requirements.txt": "flask==2.0\nevil-pkg==6.6.6\n",
      "CMakeLists.txt": "project(app)\nadd_compile_definitions(EVIL)\n",
    },
    "deps2",
  );
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  expect(result.verdicts[0].carry).toBeNull();
});

test("Given a unit verdict, When a runtime file under src/fixtures/ or spec/ changes, Then it is not a tests-only carry", () => {
  for (const file of ["src/fixtures/config.json", "spec/config.rb"]) {
    const root = featureRepo();
    commit(root, { [file]: "admin = false\n" }, "cfg");
    verdict(root, "unit", "tests-verified");
    commit(root, { [file]: "admin = true\n" }, "cfg2");
    const result = check(root);
    expect(result.accepted).toMatchObject({
      accepted: false,
      reasons: ["stale"],
    });
    expect(result.verdicts[0].carry).toBeNull();
  }
});

test("Given a unit verdict, When a `*_test.go` or `*.spec.ts` file changes, Then it carries as tests-only", () => {
  for (const file of ["pkg/app_test.go", "src/app.spec.ts"]) {
    const root = featureRepo();
    commit(root, { [file]: "a\n" }, "t");
    verdict(root, "unit", "tests-verified");
    commit(root, { [file]: "b\n" }, "t2");
    expect(check(root).verdicts[0].carry).toMatchObject({
      rule: "tests-only",
      files: [file],
    });
  }
});

// ---------------------------------------------------------------------------
// Clean rebase: the base also edited a file the branch touches, elsewhere in
// it. The branch's patch is unchanged and the head is exactly the judged head
// cleanly rebased, so the verdict carries; any change to the patch does not.

/** Forty numbered lines, `edits` replacing some of them. */
const NUMBERED = (edits: Record<number, string> = {}) =>
  Array.from({ length: 40 }, (_, index) => edits[index] ?? `line ${index}`).join("\n") + "\n";

/** feature/x (two commits) also edits line 2 of src/shared.ts, which main holds; judged. */
const sharedFileRepo = (self = false) => {
  const root = featureRepo();
  git(root, "checkout", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED() }, "shared");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED({ 2: "line 2 branch" }) }, "edit shared");
  const judged = self
    ? value(
        recordVerdict(
          {
            cwd: root,
            actor: { host: "cli", session: "author", agentId: null },
          },
          {
            result: "verified",
            how: "exercised it",
            kind: "review",
            self: true,
          },
        ),
      )
    : verdict(root);
  return { root, judged };
};

/** main edits `line` of src/shared.ts; then feature/x is rebased onto it. */
const moveMainAndRebase = (root: string, line: number) => {
  git(root, "checkout", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED({ [line]: `line ${line} main` }) }, "main moves");
  git(root, "checkout", "-q", "feature/x");
  return spawnSync("git", ["rebase", "-q", "main"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
  }).status;
};

test("Given a verified head, When main edits another part of a branch file and the branch is rebased cleanly, Then the verdict carries as a rebase with the patch unchanged", () => {
  const { root, judged } = sharedFileRepo();
  expect(moveMainAndRebase(root, 35)).toBe(0);
  const result = check(root);
  expect(result.head).not.toBe(judged.head);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.current.basis).toBe("carried");
  expect(result.carry).toEqual({
    rule: "rebase",
    since: judged.head as string,
    files: [],
  });
  expect(carryLabel(result.carry as NonNullable<typeof result.carry>)).toBe(
    "carried (rebase: patch unchanged)",
  );
});

test("Given a rebase whose conflict in a branch file was resolved to the judged text, When checked, Then the verdict is stale (the patch changed)", () => {
  const { root } = sharedFileRepo();
  expect(moveMainAndRebase(root, 2)).not.toBe(0);
  // The resolved file is byte-identical to the judged one; the patch is not.
  write(root, "src/shared.ts", NUMBERED({ 2: "line 2 branch" }));
  git(root, "add", "src/shared.ts");
  git(root, "-c", "core.editor=true", "rebase", "--continue");
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  expect(result.carry).toBeNull();
});

test("Given a clean rebase followed by an amend of a branch line, When checked, Then the verdict is stale", () => {
  const { root } = sharedFileRepo();
  expect(moveMainAndRebase(root, 35)).toBe(0);
  write(root, "src/shared.ts", NUMBERED({ 2: "line 2 branch!", 35: "line 35 main" }));
  git(root, "add", "src/shared.ts");
  git(root, "commit", "-q", "--amend", "--no-edit");
  const result = check(root);
  expect(result.accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
  expect(result.carry).toBeNull();
});

test("Given an author's --self verdict, When the branch is rebased cleanly, Then it carries only as self, never as an accepted verdict", () => {
  const { root } = sharedFileRepo(true);
  expect(moveMainAndRebase(root, 35)).toBe(0);
  const result = check(root);
  expect(result.verdicts[0]).toMatchObject({
    basis: "carried",
    accepted: false,
  });
  expect(result.verdicts[0].reasons).toContain("self");
  expect(result.accepted.accepted).toBe(false);
  expect(result.review).toBe("self-reviewed");
});

test("Given a verified head, When the branch's files stay byte-identical (a rebase over another file, or a re-commit of the same tree), Then the verdict carries with no rebase note", () => {
  const rebased = featureRepo();
  verdict(rebased);
  git(rebased, "checkout", "-q", "main");
  commit(rebased, { "src/other.ts": "export const other = 1;\n" }, "unrelated");
  git(rebased, "checkout", "-q", "feature/x");
  git(rebased, "rebase", "-q", "main");
  const recommitted = featureRepo();
  verdict(recommitted);
  git(recommitted, "commit", "-q", "--amend", "-m", "feature, reworded");
  for (const root of [rebased, recommitted]) {
    const result = check(root);
    expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
    expect(result.current.basis).toBe("carried");
    expect(result.carry).toBeNull();
  }
});

const BIG = Array.from({ length: 60 }, (_, index) => `line ${index + 1}\n`).join("");

/**
 * big.txt on main; feature/x edits line 35 and is judged. Main then edits line
 * 33 (near enough to change the hunk's context, so the exact keys read stale),
 * and the branch is rebased onto it. `own` is the branch's edit after the rebase.
 */
const restackOverSharedEdit = (own: string) => {
  const root = featureRepo();
  git(root, "checkout", "-q", "main");
  commit(root, { "big.txt": BIG }, "big");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const fromBase = git(root, "rev-parse", "main");
  const fromHead = commit(
    root,
    { "big.txt": BIG.replace("line 35\n", "line 35 changed\n") },
    "edit 35",
  );
  verdict(root);
  git(root, "checkout", "-q", "main");
  const toBase = commit(root, { "big.txt": BIG.replace("line 33\n", "line 33 near\n") }, "near");
  git(root, "checkout", "-q", "feature/x");
  git(root, "reset", "-q", "--hard", "HEAD~1");
  git(root, "rebase", "-q", "main");
  const head = commit(
    root,
    {
      "big.txt": BIG.replace("line 33\n", "line 33 near\n").replace("line 35\n", own),
    },
    "edit 35 again",
  );
  value(
    appendObserved(root, {
      type: "stack.restacked",
      actor: { host: "cli", session: "author", agentId: null },
      stack: "s",
      branch: "feature/x",
      head,
      fromHead,
      fromBase,
      toBase,
      patchEqual: true,
      forced: false,
    }),
  );
  return root;
};

test("Given a restack row whose base also edited a file the branch touches, When the head is the judged head cleanly rebased, Then the verdict carries", () => {
  const root = restackOverSharedEdit("line 35 changed\n");
  expect(check(root).accepted.accepted).toBe(true);
});

test("Given the same restack row but the branch's patch also changed, When checked, Then it does not carry", () => {
  const root = restackOverSharedEdit("line 35 changed differently\n");
  expect(check(root).accepted).toMatchObject({
    accepted: false,
    reasons: ["stale"],
  });
});
