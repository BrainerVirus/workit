// #771: a configured check already red on the merge base refused every
// `tests-verified`, so verifiers recorded `blocked` for candidates they judged
// good. A check red on the head and on the merge base is pre-existing: the
// verdict is recorded with the note; red only on the head still refuses.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { ledgerDeps } from "@/packages/workit-cli/src/verbs/ledger";
import {
  checkEvidence,
  evidenceLines,
} from "@/packages/workit-core/src/core/policy/check-evidence";
import { evidenceFor } from "@/packages/workit-core/src/forge/report";
import type { ForgePrStatus } from "@/packages/workit-core/src/forge/types";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { tempRoot } from "./hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let state: string | undefined;
beforeEach(() => {
  state = process.env.WORKIT_STATE_DIR;
  const dir = tempRoot("workit-verdict-preexisting-state-");
  roots.push(dir);
  process.env.WORKIT_STATE_DIR = dir;
  ledgerDeps.headCi = () => ({ green: false, state: "unreadable", pr: null });
});
const realHeadCi = ledgerDeps.headCi;
afterEach(() => {
  ledgerDeps.headCi = realHeadCi;
  if (state === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = state;
});

const git = (cwd: string, ...args: string[]): string =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();

/** feature/x off main with a change that needs a verdict; configured checks test and lint. */
const repo = (): { root: string; base: string; head: string } => {
  const root = tempRoot("workit-verdict-preexisting-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "x", lint: "y" } }),
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feature/x");
  writeFileSync(
    path.join(root, "big.ts"),
    Array.from({ length: 150 }, (_, index) => `export const v${index} = ${index};`).join("\n"),
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "behavior change");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
};

/** A CLI-observed `workit check <name>` run on `sha`; ad-hoc is `workit check --name <name> -- <cmd>`. */
const ran = (
  root: string,
  name: string,
  sha: string,
  result: "passed" | "failed",
  configured = true,
) =>
  appendObserved(root, {
    type: "check",
    actor: { host: "cli", session: "claude-session-1", agentId: null },
    branch: "feature/x",
    head: sha,
    name,
    configured,
    result,
  });

const testsVerified = async (root: string, json: boolean) => {
  let stdout = "";
  const code = await main(
    [
      "ledger",
      "verdict",
      "tests-verified",
      "--kind",
      "live",
      "--how",
      "ran it",
      ...(json ? ["--json"] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "claude-session-2" },
      stdout: (out) => void (stdout += out),
      stderr: () => undefined,
    },
  );
  return { code, stdout };
};

test("Given lint red on the merge base and on the head with a recorded run on both, When a non-author records tests-verified, Then it is recorded and the row says pre-existing red: lint (base <sha>)", async () => {
  const { root, base, head } = repo();
  ran(root, "lint", base, "failed");
  ran(root, "test", head, "passed");
  ran(root, "lint", head, "failed");
  const recorded = await testsVerified(root, true);
  expect(recorded.code).toBe(0);
  const row = JSON.parse(recorded.stdout).data;
  expect(row.result).toBe("tests-verified");
  expect(row.checkEvidence).toEqual([
    { name: "test", status: "fresh", via: "local" },
    { name: "lint", status: "pre-existing", via: "local", base },
  ]);
  const text = await testsVerified(root, false);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(
    `pre-existing red: lint (base ${base.slice(0, 12)}; failures not compared)`,
  );
});

test("Given lint green on the merge base and red on the head, When tests-verified is recorded, Then check_failing refuses it as before", async () => {
  const { root, base, head } = repo();
  ran(root, "lint", base, "passed");
  ran(root, "test", head, "passed");
  ran(root, "lint", head, "failed");
  const refused = await testsVerified(root, true);
  expect(refused.code).not.toBe(0);
  const out = JSON.parse(refused.stdout);
  expect(out.error).toBe(
    `check_failing: the configured check "lint" is failing on ${head.slice(0, 12)} (local run); a tests-verified verdict cannot be recorded`,
  );
  expect(out.unblock).toBe("fix it, then workit check lint on this head, or record failed/blocked");
});

test("Given lint red on the head and no run on the merge base, When tests-verified is recorded, Then the refusal names the commands that record a base run", async () => {
  const { root, base, head } = repo();
  ran(root, "test", head, "passed");
  ran(root, "lint", head, "failed");
  const refused = await testsVerified(root, true);
  expect(refused.code).not.toBe(0);
  const out = JSON.parse(refused.stdout);
  expect(out.error).toContain(`no run on the merge base ${base.slice(0, 12)}`);
  expect(out.unblock).toStartWith(
    `run it on the merge base: git worktree add --detach <new dir> ${base.slice(0, 12)}; workit check --cwd <new dir> lint;`,
  );
});

test("Given an ad-hoc red run named lint on the merge base and a configured red lint on the head, When tests-verified is recorded, Then check_failing still refuses it", async () => {
  const { root, base, head } = repo();
  ran(root, "lint", base, "failed", false);
  ran(root, "test", head, "passed");
  ran(root, "lint", head, "failed");
  const refused = await testsVerified(root, true);
  expect(refused.code).not.toBe(0);
  const out = JSON.parse(refused.stdout);
  expect(out.error).toStartWith(`check_failing: the configured check "lint" is failing on`);
  expect(out.error).toContain(`no run on the merge base ${base.slice(0, 12)}`);
});

test("Given a later green run on the merge base after a red one, When the evidence is read, Then the last base run decides and the head's red is failing", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const run = (sha: string, passed: boolean) => ({
    name: "lint",
    head: sha,
    dirty: false,
    passed,
    configured: true,
  });
  const doc = checkEvidence({
    lane: "focused",
    head,
    base,
    configured: ["lint"],
    local: [run(base, false), run(base, true), run(head, false)],
    ci: [],
  });
  expect(doc.needed[0]).toMatchObject({
    status: "failing",
    base: { sha: base, result: "passed" },
  });
  expect(doc.satisfied).toBe(false);
});

test("Given a head that is its own merge base, When lint is red there, Then it stays failing", () => {
  const head = "a".repeat(40);
  const doc = checkEvidence({
    lane: "focused",
    head,
    base: head,
    configured: ["lint"],
    local: [{ name: "lint", head, dirty: false, passed: false }],
    ci: [],
  });
  expect(doc.needed[0]?.status).toBe("failing");
});

test("Given lint red on the merge base and on the PR head, When pr status reads the evidence, Then it shows lint as pre-existing red, not failing", () => {
  const { root, base, head } = repo();
  ran(root, "lint", base, "failed");
  ran(root, "test", head, "passed");
  ran(root, "lint", head, "failed");
  const status: ForgePrStatus = {
    number: 7,
    url: "https://example.test/pr/7",
    state: "open",
    draft: false,
    base: "main",
    baseSha: base,
    head: { branch: "feature/x", sha: head },
    mergeable: "yes",
    conflicts: false,
    rebaseRequired: false,
    reviewDecision: null,
    mergeState: null,
    inMergeQueue: false,
    checks: [],
    requiredContexts: [],
    threads: [],
    truncated: false,
  };
  const doc = evidenceFor(root, status);
  expect(doc.needed.find((item) => item.name === "lint")?.status).toBe("pre-existing");
  expect(doc.satisfied).toBe(true);
  expect(evidenceLines(doc)).toContain(
    `  ~ lint: pre-existing red, also failed on the merge base ${base.slice(0, 12)} (local)`,
  );
});
