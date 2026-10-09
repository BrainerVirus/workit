import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs, {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE_BYTES,
  appendObserved,
  appendRow,
  branchForPr,
  buildHandoff,
  checkVerdicts,
  isNetworkFsType,
  ledgerLock,
  ledgerPath,
  readLedger,
  recordDecision,
  recordRuling,
  recordVerdict,
  storeRoot,
  verdictBasis,
  withLedgerLock,
  type DecisionRow,
  type LedgerActor,
  type LedgerRead,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";

// S13 run ledger (design §2.1, §2.2; D13, D17, D18): append-only, shared across
// worktrees, safe for concurrent appenders, SHA-keyed verdicts with exact
// patch carry-over, a current/accepted split, and a tolerant reader.

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
});

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};
const read = (cwd: string): LedgerRead => value(readLedger(cwd, { integrity: true }));

const BASE_FILE = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";

/** main with one commit, feature/x with one commit on top of it, checked out. */
const featureRepo = (): string => {
  const root = repo();
  commit(root, "a.txt", BASE_FILE, "base");
  git(root, "checkout", "-qb", "feature/x");
  commit(root, "feature.txt", "feature\n", "feature work");
  return root;
};

const reviewer =
  (session = "s-reviewer") =>
  (cwd: string) => ({ cwd, actor: actor(session) });

const seedAuthor = (root: string, type: "commit.recorded" | "task.opened", session: string) =>
  value(
    appendObserved(root, {
      type,
      session,
      actor: actor(session),
      branch: "feature/x",
      head: git(root, "rev-parse", "HEAD"),
    }),
  );

// ---------------------------------------------------------------------------
// store root and sharing (D13, M1)

test("given a git repo, the store root is <git common dir>/workit and non-git dirs keep <cwd>/.workit", () => {
  const root = repo();
  expect(value(storeRoot(root))).toEqual({
    root: path.join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "workit"),
    shared: true,
  });
  const plain = tmp("wk-ledger-plain-");
  expect(value(storeRoot(plain))).toEqual({ root: path.join(plain, ".workit"), shared: false });
  value(recordDecision({ cwd: plain, actor: actor() }, { what: "x", why: "y" }));
  expect(readFileSync(path.join(plain, ".workit", "ledger", "ledger.jsonl"), "utf8")).toContain(
    '"type":"decision"',
  );
});

test("given a git failure other than 'not a git repository', the store is unavailable and no .workit fallback is created", () => {
  const broken = tmp("wk-ledger-broken-");
  // A worktree whose gitdir is gone: git fails, but it is still a repository.
  writeFileSync(path.join(broken, ".git"), `gitdir: ${path.join(broken, "missing", "gitdir")}\n`);
  const root = storeRoot(broken);
  expect(root.ok).toBe(false);
  if (!root.ok) expect(root.code).toBe("unavailable");
  const appended = recordDecision({ cwd: broken, actor: actor() }, { what: "x", why: "y" });
  expect(appended.ok).toBe(false);
  expect(readLedger(broken).ok).toBe(false);
  expect(existsSync(path.join(broken, ".workit"))).toBe(false);
});

test("given two worktrees of the same repo, the ledger is shared between them", () => {
  const root = featureRepo();
  const second = path.join(tmp("wk-ledger-wt-"), "second");
  git(root, "worktree", "add", "-q", "-b", "feature/y", second, "main");
  expect(value(ledgerPath(second))).toBe(value(ledgerPath(root)));
  value(recordDecision({ cwd: root, actor: actor() }, { what: "from first", why: "w" }));
  value(recordDecision({ cwd: second, actor: actor() }, { what: "from second", why: "w" }));
  for (const cwd of [root, second])
    expect(read(cwd).rows.map((row) => [row.what, row.branch])).toEqual([
      ["from first", "feature/x"],
      ["from second", "feature/y"],
    ]);
  git(root, "worktree", "remove", "--force", second);
  expect(read(root).rows).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// appends (concurrency, size, short writes, network FS)

test("given N concurrent appenders of near-4096-byte rows, some killed with SIGKILL mid-run, no row is lost, torn or reordered", async () => {
  const root = repo();
  const writers = 8;
  const perWriter = 200;
  const killed = new Set([1, 4, 6]);
  const script = `
    const { appendRow } = await import(${JSON.stringify(ledgerModule)});
    const [cwd, writer, count] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i++) {
      const what = \`w\${writer}-\${i}\`;
      const row = appendRow(cwd, { type: "decision", what, why: "x".repeat(3500),
        refs: [], actor: { host: "test", session: null, agentId: null },
        branch: null, head: null, base: null, baseSha: null, patchId: null, diffHash: null, tree: null, dirty: null });
      if (!row.ok) { console.error(row.error); process.exit(1); }
      process.stdout.write(".");
    }
  `;
  const exits = await Promise.all(
    Array.from(
      { length: writers },
      (_, writer) =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          const child = spawn(
            process.execPath,
            ["-e", script, root, String(writer), String(perWriter)],
            { stdio: ["ignore", "pipe", "inherit"] },
          );
          // Kill a doomed writer mid-run: after it reports 20 + writer rows.
          let rows = 0;
          child.stdout.on("data", (chunk: Buffer) => {
            rows += chunk.length;
            if (killed.has(writer) && rows >= 20 + writer && child.exitCode === null)
              child.kill("SIGKILL");
          });
          child.on("close", (code, signal) => resolve({ code, signal }));
        }),
    ),
  );
  for (const [writer, exit] of exits.entries())
    if (!killed.has(writer)) expect(exit, `writer ${writer}`).toEqual({ code: 0, signal: null });
  const lines = readFileSync(value(ledgerPath(root)), "utf8")
    .split("\n")
    .filter(Boolean);
  for (const line of lines) expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(MAX_LINE_BYTES);
  // A SIGKILL can cut a writer's own unacknowledged append short; the fence
  // isolates it on its own line and the reader skips it. At most one per
  // killed writer, and never a row any writer reported as written.
  const torn = lines.filter((line) => Buffer.byteLength(line) + 1 <= 3500);
  expect(torn.length).toBeLessThanOrEqual(killed.size);
  const ledger = read(root);
  expect(ledger.skipped).toBe(torn.length);
  expect(ledger.rows).toHaveLength(lines.length - torn.length);
  // Racing appenders may chain onto the same line; the chain still verifies.
  expect(ledger.integrity?.unverified).toEqual([]);
  for (let writer = 0; writer < writers; writer++) {
    const mine = ledger.rows.filter((row) => String(row.what).startsWith(`w${writer}-`));
    // A writer's rows are a gap-free prefix in its own order.
    expect(mine.map((row) => row.what)).toEqual(
      Array.from({ length: mine.length }, (_, i) => `w${writer}-${i}`),
    );
    if (!killed.has(writer)) expect(mine).toHaveLength(perWriter);
  }
  const killedRows = ledger.rows.filter((row) =>
    [...killed].some((writer) => String(row.what).startsWith(`w${writer}-`)),
  );
  expect(killedRows.length).toBeLessThan(killed.size * perWriter);
}, 120_000);

test("a row of exactly MAX_LINE_BYTES is accepted and one byte more is refused", () => {
  const root = repo();
  // A row chained onto a previous one (not the file's first) is the size to probe.
  value(recordDecision({ cwd: root, actor: actor() }, { what: "first", why: "w" }));
  const probe = value(
    recordDecision({ cwd: root, actor: actor() }, { what: "p", why: "y".repeat(100) }),
  );
  const probeBytes = Buffer.byteLength(`${JSON.stringify(probe)}\n`);
  const fit = 100 + (MAX_LINE_BYTES - probeBytes);
  const exact = recordDecision({ cwd: root, actor: actor() }, { what: "p", why: "y".repeat(fit) });
  expect(exact.ok).toBe(true);
  const lines = readFileSync(value(ledgerPath(root)), "utf8")
    .split("\n")
    .filter(Boolean);
  expect(Buffer.byteLength(lines.at(-1)!) + 1).toBe(MAX_LINE_BYTES);
  const over = recordDecision(
    { cwd: root, actor: actor() },
    { what: "p", why: "y".repeat(fit + 1) },
  );
  expect(over.ok).toBe(false);
  if (!over.ok) {
    expect(over.code).toBe("invalid_input");
    expect(over.error).toContain(`${MAX_LINE_BYTES + 1} bytes`);
  }
  expect(read(root).rows).toHaveLength(3);
});

test("a short write is reported as unavailable", () => {
  const root = repo();
  const spy = spyOn(fs, "writeSync").mockImplementation(() => 1);
  try {
    const result = recordDecision({ cwd: root, actor: actor() }, { what: "x", why: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unavailable");
      expect(result.error).toContain("short write");
    }
  } finally {
    spy.mockRestore();
  }
});

test("network filesystems are detected by statfs type, and the advisory lock serializes and recovers", () => {
  expect(isNetworkFsType(0x6969)).toBe(true); // NFS
  expect(isNetworkFsType(0xff534d42)).toBe(true); // CIFS
  expect(isNetworkFsType(0x65735546)).toBe(true); // FUSE
  expect(isNetworkFsType(0xef53)).toBe(false); // ext4
  expect(isNetworkFsType(0x01021994)).toBe(false); // tmpfs

  const root = repo();
  const file = value(ledgerPath(root));
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  expect(withLedgerLock(file, () => "ran")).toBe("ran");
  expect(existsSync(lock)).toBe(false);
  // Held and fresh: a waiter gives up.
  const held = ledgerLock.acquire(lock)!;
  expect(withLedgerLock(file, () => "ran", 50)).toBeNull();
  // Release removes only a lock carrying the caller's own token.
  expect(ledgerLock.release(lock, "someone-else")).toBe(false);
  expect(ledgerLock.token(lock)).toBe(held);
  // Stale: taken over.
  const old = new Date(Date.now() - 60_000);
  utimesSync(path.join(lock, "owner"), old, old);
  utimesSync(lock, old, old);
  expect(withLedgerLock(file, () => "taken over", 50)).toBe("taken over");
  expect(existsSync(lock)).toBe(false);
  // The original holder's late release must not remove anyone's lock.
  const mine = ledgerLock.acquire(lock)!;
  expect(ledgerLock.release(lock, held)).toBe(false);
  expect(ledgerLock.token(lock)).toBe(mine);
  expect(ledgerLock.release(lock, mine)).toBe(true);

  // Two takers judge the same stale lock (token T). B reaps it and acquires;
  // A's reap, still keyed to T, must leave B's lock alone.
  const stale = ledgerLock.acquire(lock)!;
  const observedByA = ledgerLock.token(lock);
  const observedByB = ledgerLock.token(lock);
  expect(observedByA).toBe(stale);
  expect(ledgerLock.reap(lock, observedByB)).toBe(true);
  const b = ledgerLock.acquire(lock)!;
  expect(ledgerLock.reap(lock, observedByA)).toBe(false);
  expect(ledgerLock.token(lock)).toBe(b);
  // A second reap of the same stale state after B released finds nothing.
  expect(ledgerLock.release(lock, b)).toBe(true);
  expect(ledgerLock.reap(lock, observedByA)).toBe(false);
  expect(existsSync(lock)).toBe(false);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".lock."));
  expect(leftovers).toEqual([]);
  // The locked append path writes the same row.
  const locked = appendRow<DecisionRow>(
    root,
    {
      type: "decision",
      what: "locked",
      why: "w",
      refs: [],
      actor: actor(),
      branch: null,
      head: null,
      base: null,
      baseSha: null,
      patchId: null,
      diffHash: null,
      tree: null,
      dirty: null,
    },
    { forceLock: true },
  );
  expect(locked.ok).toBe(true);
  expect(read(root).rows.map((row) => row.what)).toEqual(["locked"]);
});

test("appendRow refuses the observer reserved for observing verbs; appendObserved stamps it", () => {
  const root = repo();
  const forged = appendRow(root, {
    type: "verdict",
    observer: "workit_cli",
    actor: actor(),
  } as never);
  expect(forged.ok).toBe(false);
  const observed = value(appendObserved(root, { type: "check", name: "test", actor: actor() }));
  expect(observed.observer).toBe("workit_cli");
});

// ---------------------------------------------------------------------------
// reader (D17)

test("given unknown fields, garbage lines and a torn tail, the reader keeps valid rows and later appends survive", () => {
  const root = repo();
  value(recordDecision({ cwd: root, actor: actor() }, { what: "first", why: "w" }));
  const file = value(ledgerPath(root));
  appendFileSync(
    file,
    `${JSON.stringify({ v: 9, id: "future-1", at: "2030-01-01T00:00:00.000Z", type: "verdict", result: "verified", kind: "review", head: "abc", futureField: { nested: true }, actor: { host: "x", attested: true, extra: 1 } })}\n`,
  );
  appendFileSync(file, "not json at all\n");
  appendFileSync(file, `${JSON.stringify({ id: "no-type" })}\n`);
  appendFileSync(file, '{"v":1,"id":"torn","type":"deci'); // crashed writer: no newline
  value(recordDecision({ cwd: root, actor: actor() }, { what: "after torn", why: "w" }));
  const ledger = read(root);
  expect(ledger.rows.map((row) => row.what ?? row.id)).toEqual(["first", "future-1", "after torn"]);
  expect(ledger.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  expect(ledger.rows[1].futureField).toEqual({ nested: true });
  // `attested` is never trusted: the normalized actor does not carry it.
  expect(ledger.rows[1].actor).toEqual({ host: "x", session: null, agentId: null });
  expect(ledger.skipped).toBe(3);
});

// ---------------------------------------------------------------------------
// supersede (H4)

test("a row may supersede only a row of its own type from its own session", () => {
  const root = featureRepo();
  const ctx = { cwd: root, actor: actor("s1") };
  const decision = value(recordDecision(ctx, { what: "a", why: "w" }));
  const crossType = recordRuling(
    { ...ctx, supersedes: decision.id },
    { what: "r", why: "w", costIfWrong: "c" },
  );
  expect(crossType.ok).toBe(false);
  if (!crossType.ok) expect(crossType.error).toContain("cannot supersede a decision");
  const crossSession = recordDecision(
    { cwd: root, actor: actor("s2"), supersedes: decision.id },
    { what: "b", why: "w" },
  );
  expect(crossSession.ok).toBe(false);
  const noSession = recordDecision(
    { cwd: root, actor: actor(null), supersedes: decision.id },
    { what: "b", why: "w" },
  );
  expect(noSession.ok).toBe(false);
  expect(recordDecision({ ...ctx, supersedes: "nope" }, { what: "b", why: "w" }).ok).toBe(false);
  value(recordDecision({ ...ctx, supersedes: decision.id }, { what: "b", why: "w" }));
  expect(read(root).rows.map((row) => [row.what, row.superseded])).toEqual([
    ["a", true],
    ["b", false],
  ]);

  // The reader ignores a link the writer would refuse (hand-appended rows).
  const ruling = value(recordRuling(ctx, { what: "keep", why: "w", costIfWrong: "c" }));
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "x1", at: "2030-01-01T00:00:00.000Z", type: "decision", supersedes: ruling.id, actor: { session: "s1" } })}\n${JSON.stringify({ v: 1, id: "x2", at: "2030-01-01T00:00:00.000Z", type: "ruling", supersedes: ruling.id, actor: { session: "s2" } })}\n`,
  );
  expect(read(root).rows.find((row) => row.id === ruling.id)?.superseded).toBe(false);
});

test("a self verdict cannot supersede an independent one", () => {
  const root = featureRepo();
  const ctx = { cwd: root, actor: actor("s1") };
  const independent = value(recordVerdict(ctx, { result: "failed", how: "found a bug" }));
  const self = recordVerdict(
    { ...ctx, supersedes: independent.id },
    { result: "verified", how: "x", self: true },
  );
  expect(self.ok).toBe(false);
  if (!self.ok) expect(self.error).toContain("self verdict cannot replace");
});

// ---------------------------------------------------------------------------
// carry-over (H1, §2.2)

test("given a verdict at SHA A, a base-only rebase carries it, and a content change makes it stale", () => {
  const root = featureRepo();
  const verdict = value(
    recordVerdict(reviewer()(root), {
      result: "verified",
      how: "bun test, 120 pass",
      kind: "unit",
    }),
  );
  const shaA = verdict.head;
  expect(verdict).toMatchObject({
    branch: "feature/x",
    base: "main",
    observer: "agent_asserted",
    self: false,
    selfReason: null,
    dirty: false,
  });
  expect(verdict.patchId).toMatch(/^[0-9a-f]{40}$/u);
  expect(verdict.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(checkVerdicts(root, "feature/x", read(root).rows)).toMatchObject({
    head: shaA,
    current: { basis: "fresh" },
    accepted: { accepted: true },
  });

  git(root, "checkout", "-q", "main");
  commit(root, "other.txt", "other\n", "unrelated");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const rebased = checkVerdicts(root, "feature/x", read(root).rows);
  expect(rebased.head).not.toBe(shaA);
  expect(rebased).toMatchObject({
    current: { basis: "carried" },
    accepted: { accepted: true },
    patchId: verdict.patchId,
  });

  commit(root, "feature.txt", "feature changed\n", "change the feature");
  const changed = checkVerdicts(root, "feature/x", read(root).rows);
  expect(changed).toMatchObject({
    current: { basis: "stale" },
    accepted: { accepted: false, reasons: ["stale"] },
  });
  expect(
    verdictBasis(
      { head: "a", patchId: "p", diffHash: null },
      { head: "b", patchId: "p", diffHash: null },
    ),
  ).toBe("stale");
});

test("a base change elsewhere in the same file still carries the verdict", () => {
  const root = repo();
  commit(root, "a.py", BASE_FILE, "base");
  git(root, "checkout", "-qb", "feature/x");
  commit(root, "a.py", BASE_FILE.replace("line 35", "line 35 changed"), "feature");
  value(recordVerdict(reviewer()(root), { result: "verified", how: "ran it" }));
  git(root, "checkout", "-q", "main");
  commit(root, "a.py", BASE_FILE.replace("line 2\n", "line 2 base edit\n"), "far edit");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  expect(checkVerdicts(root, "feature/x", read(root).rows).current.basis).toBe("carried");
});

test("given a Python re-indent after the verdict, patch-id is unchanged but the verdict reads stale", () => {
  const root = repo();
  commit(root, "app.py", "def f(x):\n    return x\n", "base");
  git(root, "checkout", "-qb", "feature/x");
  const loop = (inner: string) =>
    `def f(x):\n    for i in x:\n        log(i)\n${inner}save(i)\n    return x\n`;
  commit(root, "app.py", loop("        "), "feature");
  const verdict = value(recordVerdict(reviewer()(root), { result: "verified", how: "pytest" }));
  // Same tokens, one line dedented: save(i) now runs once, after the loop.
  git(root, "reset", "-q", "--hard", "main");
  commit(root, "app.py", loop("    "), "feature");
  const check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.patchId).toBe(verdict.patchId);
  expect(check.current.basis).toBe("stale");
  expect(check.accepted.accepted).toBe(false);
});

test("a verdict on a dirty worktree is refused", () => {
  const root = featureRepo();
  writeFileSync(path.join(root, "feature.txt"), "uncommitted\n");
  const result = recordVerdict(reviewer()(root), { result: "verified", how: "x" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("blocked");
    expect(result.error).toContain("dirty_worktree");
  }
});

test("a verdict from a clean detached worktree at the head is recorded though the branch's own checkout is dirty", () => {
  const root = featureRepo();
  const detached = path.join(root, "..", `${path.basename(root)}-detached`);
  git(root, "worktree", "add", "-q", "--detach", detached, "feature/x");
  writeFileSync(path.join(root, "feature.txt"), "uncommitted\n");
  const verdict = value(
    recordVerdict(
      { cwd: detached, actor: actor("s-reviewer"), branch: "feature/x" },
      { result: "verified", how: "ran it" },
    ),
  );
  expect(verdict.head).toBe(git(root, "rev-parse", "feature/x").trim());
  const refused = recordVerdict(reviewer()(root), { result: "verified", how: "x" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("dirty_worktree");
});

test("a detached worktree at the head that is itself dirty (untracked or staged) still refuses the verdict", () => {
  for (const change of ["untracked", "staged"] as const) {
    const root = featureRepo();
    const detached = path.join(root, "..", `${path.basename(root)}-detached-${change}`);
    git(root, "worktree", "add", "-q", "--detach", detached, "feature/x");
    writeFileSync(path.join(detached, "extra.txt"), "not judged\n");
    if (change === "staged") git(detached, "add", "extra.txt");
    const refused = recordVerdict(
      { cwd: detached, actor: actor("s-reviewer"), branch: "feature/x" },
      { result: "verified", how: "x" },
    );
    expect(refused.ok, change).toBe(false);
    if (!refused.ok) expect(refused.error, change).toContain("dirty_worktree");
  }
});

// ---------------------------------------------------------------------------
// trust: authors, self, accepted (H3, H5, H6)

test("given a verdict recorded by the session that authored the commits, it is refused unless --self", () => {
  for (const type of ["commit.recorded", "task.opened"] as const) {
    const root = featureRepo();
    seedAuthor(root, type, "s-author");
    const author = { cwd: root, actor: actor("s-author") };
    const refused = recordVerdict(author, { result: "verified", how: "looked" });
    expect(refused.ok, type).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("blocked");
      expect(refused.error).toContain("author_verdict");
      expect(refused.unblock).toContain("WORKIT_SESSION_ID");
    }
    const self = value(recordVerdict(author, { result: "verified", how: "looked", self: true }));
    expect(self).toMatchObject({ self: true, selfReason: "flag" });
    const check = checkVerdicts(root, "feature/x", read(root).rows);
    expect(check.accepted.accepted).toBe(false);
    expect(check.accepted.reasons).toEqual(expect.arrayContaining(["author_session", "self"]));
    expect(check.authors).toEqual(["s-author"]);
    value(recordVerdict(reviewer()(root), { result: "verified", how: "ran it" }));
    expect(checkVerdicts(root, "feature/x", read(root).rows).accepted.accepted).toBe(true);
  }
});

test("without WORKIT_SESSION_ID a verdict is recorded as self and never accepted", () => {
  const root = featureRepo();
  const row = value(
    recordVerdict({ cwd: root, actor: actor(null) }, { result: "verified", how: "x" }),
  );
  expect(row).toMatchObject({ self: true, selfReason: "no_session" });
  expect(checkVerdicts(root, "feature/x", read(root).rows)).toMatchObject({
    current: { basis: "fresh" },
    accepted: { accepted: false, reasons: ["no_session"] },
  });
});

test("authors are the union of session rows and Workit-Session commit trailers", () => {
  const root = repo();
  commit(root, "a.txt", "a\n", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "f.txt"), "f\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature\n\nWorkit-Session: s-trailer");
  seedAuthor(root, "commit.recorded", "s-row");
  for (const session of ["s-trailer", "s-row"]) {
    const refused = recordVerdict(
      { cwd: root, actor: actor(session) },
      { result: "verified", how: "x" },
    );
    expect(refused.ok, session).toBe(false);
  }
  value(recordVerdict(reviewer()(root), { result: "verified", how: "x" }));
  expect(checkVerdicts(root, "feature/x", read(root).rows).authors).toEqual(["s-row", "s-trailer"]);
});

test("failed and blocked verdicts are current but never accepted, and a current independent failure vetoes other kinds", () => {
  for (const result of ["failed", "blocked"]) {
    const root = featureRepo();
    value(recordVerdict(reviewer("s1")(root), { result, how: "x", kind: "review" }));
    let check = checkVerdicts(root, "feature/x", read(root).rows);
    expect(check.current.basis).toBe("fresh");
    expect(check.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
    value(recordVerdict(reviewer("s2")(root), { result: "verified", how: "tests", kind: "unit" }));
    check = checkVerdicts(root, "feature/x", read(root).rows);
    expect(check.verdicts.find((entry) => entry.kind === "unit")?.accepted).toBe(true);
    expect(check.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  }
});

test("an independent failure sticks until a different non-author session records a newer verdict of that kind", () => {
  const root = featureRepo();
  seedAuthor(root, "commit.recorded", "s-author");
  value(recordVerdict(reviewer("s1")(root), { result: "failed", how: "bug" }));
  const effective = () =>
    checkVerdicts(root, "feature/x", read(root).rows).verdicts.find(
      (entry) => entry.kind === "review",
    )?.verdict.result;
  value(
    recordVerdict(
      { cwd: root, actor: actor("s-author") },
      { result: "verified", how: "x", self: true },
    ),
  );
  expect(effective()).toBe("failed");
  value(recordVerdict({ cwd: root, actor: actor(null) }, { result: "verified", how: "x" }));
  expect(effective()).toBe("failed");
  value(recordVerdict(reviewer("s1")(root), { result: "verified", how: "changed my mind" }));
  expect(effective()).toBe("failed");
  value(recordVerdict(reviewer("s2")(root), { result: "verified", how: "fixed and re-verified" }));
  expect(effective()).toBe("verified");
  expect(checkVerdicts(root, "feature/x", read(root).rows).accepted.accepted).toBe(true);
});

test("a session's own supersede replaces its failing verdict", () => {
  const root = featureRepo();
  const failing = value(recordVerdict(reviewer("s1")(root), { result: "failed", how: "bug" }));
  value(
    recordVerdict(
      { ...reviewer("s1")(root), supersedes: failing.id },
      { result: "verified", how: "my mistake" },
    ),
  );
  expect(checkVerdicts(root, "feature/x", read(root).rows).accepted.accepted).toBe(true);
});

test("given a session's failed verdict on head A and a fix commit B, when that same non-author session verifies B, then B is current and accepted", () => {
  const root = featureRepo();
  seedAuthor(root, "commit.recorded", "lead");
  const reviewerSession = "lead:agent-1";
  value(recordVerdict(reviewer(reviewerSession)(root), { result: "failed", how: "bug" }));
  const fixed = commit(root, "feature.txt", "feature, fixed\n", "fix review finding");
  value(recordVerdict(reviewer(reviewerSession)(root), { result: "verified", how: "re-reviewed" }));
  const check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.head).toBe(fixed);
  expect(check.current).toMatchObject({
    basis: "fresh",
    verdict: { result: "verified", head: fixed },
  });
  expect(check.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(check.review).toBe("verified");
});

test("given a session's failed verdict on A and a fix commit B, when that same session records only type-check-only on B, then nothing is accepted for merge (type_check_only) until a strong verdict", () => {
  const root = featureRepo();
  seedAuthor(root, "commit.recorded", "lead");
  const session = reviewer("lead:agent-1");
  value(recordVerdict(session(root), { result: "failed", how: "bug" }));
  const fixed = commit(root, "feature.txt", "feature, fixed\n", "fix review finding");
  value(recordVerdict(session(root), { result: "type-check-only", how: "tsc only" }));
  let check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.current.verdict).toMatchObject({ result: "type-check-only", head: fixed });
  expect(check.accepted).toMatchObject({ accepted: false, reasons: ["type_check_only"] });
  expect(check.review).not.toBe("verified");
  value(recordVerdict(session(root), { result: "tests-verified", how: "ran the suite" }));
  check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.accepted).toMatchObject({ accepted: true, reasons: [] });
});

/** A failed verdict on head A, then `move` changes the head without changing the code. */
const failThenReverify = (
  move: (root: string) => void,
  base?: string,
): ReturnType<typeof checkVerdicts> => {
  const root = featureRepo();
  seedAuthor(root, "commit.recorded", "lead");
  const session = reviewer("lead:agent-1");
  value(recordVerdict(session(root), { result: "failed", how: "bug" }));
  move(root);
  value(recordVerdict({ ...session(root), base }, { result: "verified", how: "looks fine now" }));
  return checkVerdicts(root, "feature/x", read(root).rows);
};

test("given a session's failed verdict on A, when the head moves without a code change (empty commit, amend, or a verdict recorded with --base HEAD~1), then the same session's verified does not release it", () => {
  const cases: [string, (root: string) => void, string | undefined][] = [
    [
      "empty commit",
      (root) => git(root, "commit", "-q", "--allow-empty", "-m", "nothing"),
      undefined,
    ],
    ["amend", (root) => git(root, "commit", "-q", "--amend", "-m", "reworded"), undefined],
    [
      "--base HEAD~1",
      (root) => git(root, "commit", "-q", "--allow-empty", "-m", "nothing"),
      "HEAD~1",
    ],
  ];
  for (const [name, move, base] of cases) {
    const check = failThenReverify(move, base);
    expect(check.verdicts.find((entry) => entry.kind === "review")?.verdict.result, name).toBe(
      "failed",
    );
    expect(check.accepted, name).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  }
});

test("given a session's failed verdict on A, when a workit-observed restack carries A to B, then the same session's verified on B does not release it", () => {
  const check = failThenReverify((root) => {
    const failedHead = git(root, "rev-parse", "HEAD");
    const restacked = commit(root, "feature.txt", "feature, restacked\n", "restack");
    value(
      appendObserved(root, {
        type: "stack.restacked",
        actor: actor("lead"),
        branch: "feature/x",
        fromHead: failedHead,
        head: restacked,
        patchEqual: true,
      }),
    );
  });
  expect(check.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
});

// ---------------------------------------------------------------------------
// PR → branch (H2)

test("a PR resolves to a branch only through observed pr rows or a fetched forge ref", () => {
  const root = featureRepo();
  const resolve = (pr: number) => branchForPr(root, read(root).rows, pr);
  // An arbitrary row claiming pr 7 is not a mapping.
  value(recordDecision({ cwd: root, actor: actor("s1"), pr: 7 }, { what: "x", why: "y" }));
  // Nor is a pr.created row that no observing verb wrote.
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "forged-pr", at: "2030-01-01T00:00:00.000Z", type: "pr.created", pr: 7, branch: "main", observer: "agent_asserted", actor: { session: "s1" } })}\n`,
  );
  expect(resolve(7)).toEqual({ ok: false, reason: "unknown", candidates: [] });
  // A fetched forge ref pointing at exactly one local branch tip is.
  git(root, "update-ref", "refs/pull/7/head", git(root, "rev-parse", "feature/x"));
  expect(resolve(7)).toEqual({ ok: true, branch: "feature/x", source: "forge_ref" });
  // A row the CLI's PR verbs observed wins.
  value(appendObserved(root, { type: "pr.created", pr: 9, branch: "feature/y", actor: actor() }));
  expect(resolve(9)).toEqual({ ok: true, branch: "feature/y", source: "pr_row" });
  expect(resolve(10)).toEqual({ ok: false, reason: "unknown", candidates: [] });
});

test("a forge ref whose tip several branches share, or forge refs that disagree, are ambiguous", () => {
  const root = featureRepo();
  const tip = git(root, "rev-parse", "feature/x");
  git(root, "branch", "feature/copy", tip);
  git(root, "update-ref", "refs/pull/7/head", tip);
  expect(branchForPr(root, read(root).rows, 7)).toEqual({
    ok: false,
    reason: "ambiguous",
    candidates: ["feature/copy", "feature/x"],
  });
  // Each ref alone would resolve (main's tip is only main); together they disagree.
  git(root, "update-ref", "refs/pull/8/head", git(root, "rev-parse", "main"));
  expect(branchForPr(root, read(root).rows, 8)).toMatchObject({ ok: true, branch: "main" });
  git(root, "update-ref", "refs/remotes/origin/pull/8/head", tip);
  expect(branchForPr(root, read(root).rows, 8)).toMatchObject({ ok: false, reason: "ambiguous" });
});

// ---------------------------------------------------------------------------
// handoff

test("given workit handoff, the brief includes the next command and the check freshness", () => {
  const root = featureRepo();
  value(
    appendObserved(root, {
      type: "check",
      name: "test",
      result: "passed",
      actor: actor(),
      branch: "feature/x",
      head: git(root, "rev-parse", "HEAD"),
      tree: git(root, "rev-parse", "HEAD^{tree}"),
    }),
  );
  // An agent-written "check" row is not evidence.
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "fake", at: "2030-01-01T00:00:00.000Z", type: "check", name: "lint", branch: "feature/x", actor: {} })}\n`,
  );
  let brief = value(buildHandoff(root));
  expect(brief.checks).toEqual([expect.objectContaining({ name: "test", fresh: true })]);
  expect(brief.verdict).toMatchObject({ current: "none", accepted: false });
  expect(brief.nextCommand).toContain("workit ledger verdict verified --branch feature/x");
  expect(brief).toMatchObject({ branch: "feature/x", base: "main", ahead: 1, behind: 0, pr: null });

  writeFileSync(path.join(root, "feature.txt"), "edited\n");
  brief = value(buildHandoff(root, { note: "halfway", next: "finish the parser" }));
  expect(brief.checks).toEqual([expect.objectContaining({ name: "test", fresh: false })]);
  expect(brief.dirty).toEqual({ dirty: true, files: 1, paths: ["feature.txt"] });
  expect(brief.nextCommand).toContain("commit or stash the 1 changed file(s)");
  expect(brief.next).toBe("finish the parser");
  expect(brief.note).toBe("halfway");
});

test("handoff never suggests pr create on self-only or failed-only verdicts", () => {
  const root = featureRepo();
  value(recordVerdict({ cwd: root, actor: actor(null) }, { result: "verified", how: "x" }));
  let brief = value(buildHandoff(root));
  expect(brief.nextCommand).not.toContain("pr create");
  expect(brief.nextCommand).toContain("workit ledger verdict verified");
  value(recordVerdict(reviewer("s1")(root), { result: "failed", how: "bug" }));
  brief = value(buildHandoff(root));
  expect(brief.nextCommand).not.toContain("pr create");
  expect(brief.nextCommand).toContain("fix what the failing verdict found");
  value(recordVerdict(reviewer("s2")(root), { result: "verified", how: "fixed" }));
  expect(value(buildHandoff(root)).nextCommand).toBe("workit pr create");
});

test("handoff and list label superseded, ignored and self rows", () => {
  const root = featureRepo();
  const first = value(recordDecision({ cwd: root, actor: actor("s1") }, { what: "old", why: "w" }));
  value(
    recordDecision(
      { cwd: root, actor: actor("s1"), supersedes: first.id },
      { what: "new", why: "w" },
    ),
  );
  value(recordVerdict({ cwd: root, actor: actor(null) }, { result: "verified", how: "x" }));
  appendFileSync(
    value(ledgerPath(root)),
    [
      {
        id: "bad-link",
        type: "decision",
        what: "hijack",
        supersedes: first.id,
        actor: { session: "s2" },
      },
      { id: "fake-check", type: "check", name: "lint", actor: {} },
    ]
      .map((row) => `${JSON.stringify({ v: 1, at: "2030-01-01T00:00:00.000Z", ...row })}\n`)
      .join(""),
  );
  const labels = Object.fromEntries(
    value(buildHandoff(root)).recent.map((row) => [
      row.id === first.id ? "old" : row.id,
      row.labels,
    ]),
  );
  expect(labels.old).toEqual(["superseded"]);
  expect(labels["bad-link"]).toEqual(["ignored"]);
  expect(labels["fake-check"]).toEqual(["ignored"]);
  const verdictLabels = value(buildHandoff(root)).recent.find(
    (row) => row.type === "verdict",
  )?.labels;
  expect(verdictLabels).toEqual(["self"]);
});

test("lock release never moves a lock it does not own, even when the token changes under it", () => {
  const root = repo();
  const file = value(ledgerPath(root));
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const rename = fs.renameSync;
  const mine = ledgerLock.acquire(lock)!;

  // Wrong token: refused before touching the lock (no rename window).
  const spy = spyOn(fs, "renameSync");
  try {
    expect(ledgerLock.release(lock, "someone-else")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }

  // Our token passes the first read, but a takeover lands before the rename:
  // the renamed lock is someone else's, so it goes back untouched.
  const race = spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === lock) writeFileSync(path.join(lock, "owner"), "other-holder");
    rename(from, to);
  });
  try {
    expect(ledgerLock.release(lock, mine)).toBe(false);
  } finally {
    race.mockRestore();
  }
  expect(ledgerLock.token(lock)).toBe("other-holder");
});
