import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE_BYTES,
  appendRow,
  buildHandoff,
  checkVerdicts,
  ledgerPath,
  readLedger,
  recordDecision,
  recordVerdict,
  storeRoot,
  verdictBasis,
  type LedgerActor,
} from "@/packages/workit-core/src/ledger";

// S13 run ledger (design §2.1, §2.2; D13, D17): append-only, shared across
// worktrees, safe for concurrent appenders, SHA-keyed verdicts with patch-id
// carry-over, and a tolerant reader.

const ledgerModule = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/workit-core/src/ledger.ts",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const repo = (): string => {
  const root = tmp("wk-ledger-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  return root;
};

const commit = (root: string, file: string, content: string, message: string): string => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
  git(root, "add", "--", file);
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
};

const actor = (session: string | null = null): LedgerActor => ({
  host: "cli",
  session,
  agentId: null,
  attested: false,
});

/** main with one commit, feature/x with one commit on top of it, checked out. */
const featureRepo = (): string => {
  const root = repo();
  commit(root, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n", "base");
  git(root, "checkout", "-qb", "feature/x");
  commit(root, "feature.txt", "feature\n", "feature work");
  return root;
};

test("given a git repo, the store root is <git common dir>/workit and non-git dirs keep <cwd>/.workit", () => {
  const root = repo();
  expect(storeRoot(root)).toEqual({
    root: path.join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "workit"),
    shared: true,
  });
  const plain = tmp("wk-ledger-plain-");
  expect(storeRoot(plain)).toEqual({ root: path.join(plain, ".workit"), shared: false });
  const written = recordDecision({ cwd: plain, actor: actor() }, { what: "x", why: "y" });
  expect(written.ok).toBe(true);
  expect(readFileSync(path.join(plain, ".workit", "ledger", "ledger.jsonl"), "utf8")).toContain(
    '"type":"decision"',
  );
});

test("given two worktrees of the same repo, the ledger is shared between them", () => {
  const root = featureRepo();
  const second = path.join(tmp("wk-ledger-wt-"), "second");
  git(root, "worktree", "add", "-q", "-b", "feature/y", second, "main");
  expect(ledgerPath(second)).toBe(ledgerPath(root));
  expect(recordDecision({ cwd: root, actor: actor() }, { what: "from first", why: "w" }).ok).toBe(
    true,
  );
  expect(
    recordDecision({ cwd: second, actor: actor() }, { what: "from second", why: "w" }).ok,
  ).toBe(true);
  for (const cwd of [root, second]) {
    const rows = readLedger(cwd).rows;
    expect(rows.map((row) => [row.what, row.branch])).toEqual([
      ["from first", "feature/x"],
      ["from second", "feature/y"],
    ]);
  }
  // It outlives the worktree that wrote to it.
  git(root, "worktree", "remove", "--force", second);
  expect(readLedger(root).rows).toHaveLength(2);
});

test("given N concurrent appending processes, no row is lost or torn", async () => {
  const root = repo();
  const writers = 8;
  const perWriter = 60;
  const script = `
    const { appendRow } = await import(${JSON.stringify(ledgerModule)});
    const [cwd, writer, count] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i++) {
      const row = appendRow(cwd, { type: "decision", what: \`w\${writer}-\${i}\`, why: "x".repeat(1500),
        refs: [], actor: { host: "test", session: null, agentId: null, attested: false },
        branch: null, head: null, base: null, baseSha: null, patchId: null, tree: null, dirty: null });
      if (!row.ok) { console.error(row.error); process.exit(1); }
    }
  `;
  const codes = await Promise.all(
    Array.from(
      { length: writers },
      (_, writer) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(
            process.execPath,
            ["-e", script, root, String(writer), String(perWriter)],
            { stdio: ["ignore", "ignore", "inherit"] },
          );
          child.on("close", resolve);
        }),
    ),
  );
  expect(codes).toEqual(Array.from({ length: writers }, () => 0));
  const ledger = readLedger(root);
  expect(ledger.skipped).toBe(0);
  expect(ledger.rows).toHaveLength(writers * perWriter);
  expect(new Set(ledger.rows.map((row) => row.id)).size).toBe(writers * perWriter);
  for (let writer = 0; writer < writers; writer++) {
    const mine = ledger.rows.filter((row) => String(row.what).startsWith(`w${writer}-`));
    // Each writer's rows stay in its own order.
    expect(mine.map((row) => row.what)).toEqual(
      Array.from({ length: perWriter }, (_, i) => `w${writer}-${i}`),
    );
  }
}, 60_000);

test("given unknown fields, garbage lines and a torn tail, the reader keeps valid rows and later appends survive", () => {
  const root = repo();
  expect(recordDecision({ cwd: root, actor: actor() }, { what: "first", why: "w" }).ok).toBe(true);
  const file = ledgerPath(root);
  appendFileSync(
    file,
    `${JSON.stringify({ v: 9, id: "future-1", at: "2030-01-01T00:00:00.000Z", type: "verdict", result: "verified", kind: "review", head: "abc", futureField: { nested: true }, actor: { host: "x", extra: 1 } })}\n`,
  );
  appendFileSync(file, "not json at all\n");
  appendFileSync(file, `${JSON.stringify({ id: "no-type" })}\n`);
  appendFileSync(file, '{"v":1,"id":"torn","type":"deci'); // crashed writer: no newline
  expect(recordDecision({ cwd: root, actor: actor() }, { what: "after torn", why: "w" }).ok).toBe(
    true,
  );
  const ledger = readLedger(root);
  expect(ledger.rows.map((row) => row.id).slice(1, 2)).toEqual(["future-1"]);
  expect(ledger.rows.map((row) => row.what ?? row.type)).toEqual([
    "first",
    "verdict",
    "after torn",
  ]);
  expect(ledger.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  expect(ledger.rows[1].futureField).toEqual({ nested: true });
  expect(ledger.rows[1].actor).toEqual({
    host: "x",
    session: null,
    agentId: null,
    attested: false,
  });
  expect(ledger.skipped).toBe(3);
});

test("a row larger than one atomic append is refused", () => {
  const root = repo();
  const result = recordDecision(
    { cwd: root, actor: actor() },
    { what: "big", why: "x".repeat(MAX_LINE_BYTES) },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe("invalid_input");
  expect(readLedger(root).rows).toHaveLength(0);
});

test("given a verdict at SHA A, a base-only rebase carries it, and a content change makes it stale", () => {
  const root = featureRepo();
  const verdict = recordVerdict(
    { cwd: root, actor: actor("verifier") },
    { result: "verified", how: "bun test, 120 pass", kind: "unit" },
  );
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  const shaA = verdict.value.head;
  expect(verdict.value).toMatchObject({
    branch: "feature/x",
    base: "main",
    observer: "workit_cli",
    attestation: null,
    self: false,
    dirty: false,
  });
  expect(verdict.value.patchId).toMatch(/^[0-9a-f]{40}$/u);
  expect(checkVerdicts(root, "feature/x")).toMatchObject({
    valid: true,
    basis: "fresh",
    head: shaA,
  });

  // main advances far from the feature's hunk; rebase moves only the base.
  git(root, "checkout", "-q", "main");
  commit(root, "other.txt", "other\n", "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const rebased = checkVerdicts(root, "feature/x");
  expect(rebased.head).not.toBe(shaA);
  expect(rebased).toMatchObject({ valid: true, basis: "carried", patchId: verdict.value.patchId });

  commit(root, "feature.txt", "feature changed\n", "change the feature");
  const changed = checkVerdicts(root, "feature/x");
  expect(changed).toMatchObject({ valid: false, basis: "stale" });
  expect(changed.patchId).not.toBe(verdict.value.patchId);

  expect(verdictBasis({ head: "a", patchId: null }, { head: "b", patchId: null })).toBe("stale");
});

test("given a verdict recorded by the session that authored the commits, it is refused unless --self", () => {
  const root = featureRepo();
  const author = actor("session-author");
  expect(
    appendRow(root, {
      type: "commit.recorded",
      session: "session-author",
      actor: author,
      branch: "feature/x",
      head: git(root, "rev-parse", "HEAD"),
      base: null,
      baseSha: null,
      patchId: null,
      tree: null,
      dirty: null,
    } as never).ok,
  ).toBe(true);
  const refused = recordVerdict(
    { cwd: root, actor: author },
    { result: "verified", how: "looked" },
  );
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.code).toBe("blocked");
    expect(refused.error).toContain("author_verdict");
    expect(refused.unblock).toContain("--self");
  }
  const self = recordVerdict(
    { cwd: root, actor: author },
    { result: "verified", how: "looked", self: true },
  );
  expect(self.ok && self.value.self).toBe(true);
  const other = recordVerdict(
    { cwd: root, actor: actor("session-reviewer") },
    { result: "verified", how: "ran it" },
  );
  expect(other.ok && other.value.self).toBe(false);
});

test("a superseded verdict no longer counts, and the newest verdict per kind wins", () => {
  const root = featureRepo();
  const first = recordVerdict(
    { cwd: root, actor: actor() },
    { result: "verified", how: "a", kind: "review" },
  );
  if (!first.ok) throw new Error(first.error);
  recordVerdict(
    { cwd: root, actor: actor() },
    { result: "tests-verified", how: "b", kind: "unit" },
  );
  recordVerdict(
    { cwd: root, actor: actor(), supersedes: first.value.id },
    { result: "failed", how: "found a bug", kind: "review" },
  );
  const check = checkVerdicts(root, "feature/x");
  expect(check.verdicts.map((entry) => [entry.kind, entry.verdict.result])).toEqual([
    ["unit", "tests-verified"],
    ["review", "failed"],
  ]);
  expect(readLedger(root).rows[0].superseded).toBe(true);
});

test("given workit handoff, the brief includes the next command and the check freshness", () => {
  const root = featureRepo();
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const row = {
    type: "check",
    name: "test",
    result: "passed",
    actor: actor(),
    branch: "feature/x",
    head: git(root, "rev-parse", "HEAD"),
    base: null,
    baseSha: null,
    patchId: null,
    tree,
    dirty: false,
  };
  appendRow(root, row as never);
  let brief = buildHandoff(root);
  expect(brief.checks).toEqual([expect.objectContaining({ name: "test", fresh: true })]);
  expect(brief.verdict).toMatchObject({ valid: false, basis: "none" });
  expect(brief.nextCommand).toContain("workit ledger verdict verified --branch feature/x");
  expect(brief).toMatchObject({ branch: "feature/x", base: "main", ahead: 1, behind: 0, pr: null });

  writeFileSync(path.join(root, "feature.txt"), "edited\n");
  brief = buildHandoff(root, { note: "halfway", next: "finish the parser" });
  expect(brief.checks).toEqual([expect.objectContaining({ name: "test", fresh: false })]);
  expect(brief.dirty).toEqual({ dirty: true, files: 1, paths: ["feature.txt"] });
  expect(brief.nextCommand).toContain("commit or stash the 1 changed file(s)");
  expect(brief.next).toBe("finish the parser");
  expect(brief.note).toBe("halfway");
});
