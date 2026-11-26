// #891: a set or stack verdict, or the sealed additiveRiskPaths, can meet a
// PR's merge gate without a verdict of its own. The Stop hook cannot carry
// those readers, so it trusts the `pr.gate` row `pr status` records once it
// read the gate as met for the head, and never asks for a verdict then.
import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import {
  appendHookObserved,
  appendLine,
  appendObserved,
  readLedger,
  recordVerdict,
  sealed,
  type LedgerResult,
  type ReadRow,
} from "@/packages/workit-core/src/ledger";
import { gateStands, setStorePath, SET_TTL_MS } from "@/packages/workit-core/src/core/verdict-set";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { fixture, tempRoot } from "./hook-fixtures";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

let savedState: string | undefined;
let home: ConfigHome;
beforeEach(() => {
  savedState = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = tempRoot("workit-hook-state-");
  home = useConfigHome("workit-stop-set-home-");
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterEach(() => {
  home.restore();
  if (savedState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = savedState;
});

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const SESSION = "s-lead";
const actor = (session: string, host = "claude_code") => ({ host, session, agentId: null });

/** Workspace "w" over every test root: endpoint green, plus `entry`. */
const workspace = (entry: Record<string, unknown> = {}) =>
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${path.dirname(roots[0] ?? "").replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { push: true, pr: true, merge: "verified" },
          defaultEndpoint: "green",
          ...entry,
        },
      ],
    }),
  );

/**
 * A checkout on feature/x whose main holds `base` and whose one commit, by
 * this session, writes `change`; pushed, with a PR this session opened.
 */
const delivered = (base: Record<string, string>, change: Record<string, string>) => {
  const parent = tempRoot("workit-stop-set-");
  roots.push(parent);
  const root = path.join(parent, "work");
  const origin = path.join(parent, "origin.git");
  git(parent, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    git(root, "add", "-A");
  };
  write({ "README.md": "# app\n", ...base });
  git(root, "commit", "-q", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  write(change);
  git(root, "commit", "-q", "-m", "feat: change");
  const sha = git(root, "rev-parse", "HEAD");
  appendHookObserved(root, {
    type: "commit.recorded",
    actor: actor(SESSION),
    branch: "feature/x",
    head: sha,
    sha,
    session: SESSION,
    agentId: null,
    subject: "feat: change",
    files: Object.keys(change),
    fileCount: Object.keys(change).length,
  });
  git(root, "push", "-q", "origin", "feature/x");
  appendObserved(root, {
    type: "pr.created",
    actor: actor(SESSION),
    branch: "feature/x",
    head: sha,
    pr: 8,
    base: "main",
    url: "https://github.com/o/r/pull/8",
    forge: "github",
    repo: "o/r",
    created: true,
  });
  return root;
};

const claudeStop = (cwd: string) =>
  dispatchHook(claudeCodeAdapter, fixture("claude-code", "stop", cwd, { session_id: SESSION }))
    .json as { decision?: string; reason?: string };

const RISKY = { "src/hooks/guard.ts": "export const guard = true;\n" };

const gateRow = (root: string, head: string, extra: Record<string, unknown> = {}) =>
  value(
    appendObserved(root, {
      type: "pr.gate",
      actor: actor(SESSION),
      branch: "feature/x",
      head,
      pr: 8,
      lane: "full",
      need: "non-author",
      verdictId: "set-1",
      via: "set",
      ...extra,
    }),
  );

/** A chained `verdict.set.voided` row for `target` in the set store, as `workit ledger void` appends it. */
const storeVoid = (target: string) => {
  mkdirSync(path.dirname(setStorePath()), { recursive: true });
  value(
    appendLine(
      setStorePath(),
      (previous) => ({
        ok: true,
        value: sealed(
          { type: "verdict.set.voided", target, reason: "wrong", actor: actor("s-user", "cli") },
          `${target}-void`,
          new Date().toISOString(),
          previous,
        ).line,
      }),
      {},
    ),
  );
};

test("G a PR on a risk path with no verdict of its own, W the session stops, T it asks for one until pr status recorded the gate met for that head (a set verdict, a sealed override)", () => {
  const root = delivered({}, RISKY);
  workspace();
  const before = claudeStop(root);
  expect(before.decision).toBe("block");
  expect(before.reason).toContain("an independent verdict");
  const forget = () =>
    rmSync(path.join(root, ".git", "workit", "hooks"), { recursive: true, force: true });
  forget();
  // A gate met for another head, or a row appended by hand outside the chain, counts for nothing.
  gateRow(root, "0".repeat(40));
  appendFileSync(
    path.join(root, ".git", "workit", "ledger", "ledger.jsonl"),
    `\n${JSON.stringify({ v: 1, id: "forged", at: new Date().toISOString(), type: "pr.gate", branch: "feature/x", head: git(root, "rev-parse", "HEAD"), observer: "workit_cli", actor: actor(SESSION) })}\n`,
  );
  expect(claudeStop(root).decision).toBe("block");
  forget();
  gateRow(root, git(root, "rev-parse", "HEAD"));
  expect(claudeStop(root)).toEqual({});
});

test("G a pr.gate row for the head, W its set verdict is voided in the store, voided here, or expired, T the Stop hook asks for a verdict again", () => {
  const root = delivered({}, RISKY);
  workspace();
  const head = git(root, "rev-parse", "HEAD");
  const forget = () =>
    rmSync(path.join(root, ".git", "workit", "hooks"), { recursive: true, force: true });
  gateRow(root, head);
  expect(claudeStop(root)).toEqual({});
  storeVoid("set-1");
  forget();
  expect(claudeStop(root).decision).toBe("block");
  // A later gate met for the head by another set verdict stands again.
  gateRow(root, head, { verdictId: "set-2" });
  forget();
  expect(claudeStop(root)).toEqual({});
  // Voided in this checkout's own ledger (a stack or own verdict).
  value(
    appendObserved(root, {
      type: "verdict.voided",
      actor: actor("s-user", "cli"),
      target: "set-2",
      reason: "wrong",
    }),
  );
  forget();
  expect(claudeStop(root).decision).toBe("block");
  gateRow(root, head, { verdictId: "set-3", expires: new Date(Date.now() - 1000).toISOString() });
  forget();
  expect(claudeStop(root).decision).toBe("block");
});

test("G a pr.gate row, W read with no expires, T a set cover stops at SET_TTL_MS after the row; an own or stack gate has no TTL", () => {
  const root = tempRoot("workit-gate-stands-");
  roots.push(root);
  const at = "2026-01-01T00:00:00.000Z";
  const row = (via: string) =>
    ({ type: "pr.gate", at, verdictId: "v-1", via }) as unknown as ReadRow;
  const start = Date.parse(at);
  expect(gateStands(root, row("set"), [], start + SET_TTL_MS - 1)).toBe(true);
  expect(gateStands(root, row("set"), [], start + SET_TTL_MS)).toBe(false);
  expect(gateStands(root, row("stack"), [], start + 10 * SET_TTL_MS)).toBe(true);
});

test("G a pr.gate row citing a verdict recorded under an issued id without its token, W the session stops, T the gate row no longer silences the hook; a bound one still does (#975)", () => {
  const root = delivered({}, RISKY);
  workspace();
  const head = git(root, "rev-parse", "HEAD");
  const forget = () =>
    rmSync(path.join(root, ".git", "workit", "hooks"), { recursive: true, force: true });
  recordIssuedSession(root, "lead-H", "lead-H:rev-1");
  const verdict = (bound: boolean) =>
    value(
      recordVerdict(
        {
          cwd: root,
          actor: actor("lead-H:rev-1", "cli"),
          sessionSource: "flag",
          branch: "feature/x",
          ...(bound ? { sessionBound: true } : {}),
        },
        { result: "verified", how: "host variables cleared" },
      ),
    );
  // Written while the forged verdict was accepted (an older CLI).
  const forged = verdict(false);
  gateRow(root, head, { via: "own", verdictId: forged.id });
  const rows = (): readonly ReadRow[] => value(readLedger(root, { integrity: true })).rows;
  expect(gateStands(root, rows().at(-1) as ReadRow, rows())).toBe(false);
  forget();
  expect(claudeStop(root).decision).toBe("block");
  // The same gate citing a verdict that presented its token stands.
  const bound = verdict(true);
  gateRow(root, head, { via: "own", verdictId: bound.id });
  expect(gateStands(root, rows().at(-1) as ReadRow, rows())).toBe(true);
});

test("G a set pr.gate whose store row was recorded under an issued id without its token, W gateStands reads it, T it does not stand (#975)", () => {
  const root = tempRoot("workit-gate-stands-");
  roots.push(root);
  recordIssuedSession(root, "lead-H", "lead-H:rev-2");
  mkdirSync(path.dirname(setStorePath()), { recursive: true });
  const storeRow = (id: string, bound: boolean) =>
    value(
      appendLine(
        setStorePath(),
        (previous) => ({
          ok: true,
          value: sealed(
            {
              type: "verdict.set",
              set: "s",
              result: "verified",
              sessionSource: "flag",
              ...(bound ? { sessionBound: true } : {}),
              actor: actor("lead-H:rev-2", "cli"),
            },
            id,
            new Date().toISOString(),
            previous,
          ).line,
        }),
        {},
      ),
    );
  storeRow("set-forged", false);
  storeRow("set-bound", true);
  const gate = (verdictId: string) =>
    ({
      type: "pr.gate",
      at: new Date().toISOString(),
      verdictId,
      via: "set",
    }) as unknown as ReadRow;
  expect(gateStands(root, gate("set-forged"), [])).toBe(false);
  expect(gateStands(root, gate("set-bound"), [])).toBe(true);
});
