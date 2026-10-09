// `recordPrStatus`: an open PR's checks summary becomes a CLI-observed
// pr.status row only when it changed, never for a closed PR or a PR without
// gating checks, and a failure never reaches the verb.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPrStatus, type PrStatusDoc } from "@/packages/workit-core/src/forge/report";
import { readLedger } from "@/packages/workit-core/src/ledger";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-pr-status-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

const actor = { host: "workit_cli", session: "s-lead", agentId: null };

const doc = (state: string, checks: string, sha = "a".repeat(40)) =>
  ({
    forge: "github",
    repo: "o/r",
    number: 12,
    state,
    head: { branch: "feature/x", sha },
    checks: { state: checks },
  }) as unknown as PrStatusDoc;

const rows = (root: string) => {
  const ledger = readLedger(root);
  return ledger.ok ? ledger.value.rows.filter((row) => row.type === "pr.status") : [];
};

test("an open PR's checks are recorded once per change, per head", () => {
  const root = repo();
  recordPrStatus(root, doc("open", "pending"), actor);
  recordPrStatus(root, doc("open", "pending"), actor);
  recordPrStatus(root, doc("open", "failing"), actor);
  recordPrStatus(root, doc("open", "failing", "b".repeat(40)), actor);
  expect(rows(root).map((row) => [row.checks, row.head, row.observer, row.pr])).toEqual([
    ["pending", "a".repeat(40), "workit_cli", 12],
    ["failing", "a".repeat(40), "workit_cli", 12],
    ["failing", "b".repeat(40), "workit_cli", 12],
  ]);
});

test("a closed or merged PR, or one without gating checks, is not recorded", () => {
  const root = repo();
  recordPrStatus(root, doc("closed", "failing"), actor);
  recordPrStatus(root, doc("merged", "pending"), actor);
  recordPrStatus(root, doc("open", "none"), actor);
  expect(rows(root)).toEqual([]);
});

test("a failure while recording stays inside: the verb's answer stands", () => {
  const root = repo();
  const broken = {
    ...doc("open", "pending"),
    get head(): never {
      throw new Error("boom");
    },
  } as unknown as PrStatusDoc;
  expect(() => recordPrStatus(root, broken, actor)).not.toThrow();
  expect(rows(root)).toEqual([]);
});
