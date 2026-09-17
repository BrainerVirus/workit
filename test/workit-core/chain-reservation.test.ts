import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  approvedChainStep,
  approvedPlanCommit,
  chainStepKey,
  externalActionDescriptor,
  normalizeChainSteps,
  success,
  type NativeAuthorityVerifier,
} from "@/packages/workit-core/src/core";
import type { Provenance } from "@/packages/workit-core/src/core/task-contract";
import { actionProposalQuestion } from "@/packages/workit-core/src/core/external-action-effects";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";
import { taskStartRequest } from "./task-fixtures";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-chain-"));
  const remote = mkdtempSync(join(tmpdir(), "workit-chain-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  for (const args of [
    ["init", "-q", "-b", "feature/chain"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "feature/chain"]);
  return { root, remote };
};

const provenance = (actor: string): Provenance => ({
  kind: "host_observed",
  host: "workit_cli",
  session: { kind: "host", host: "workit_cli", handle: actor },
  workerId: null,
  receipts: [{ kind: "host", host: "workit_cli", handle: `receipt:${actor}` }],
});

const verifier = (actor: string): NativeAuthorityVerifier => ({
  verifyDecision: () => success(null, null, provenance(actor)),
  verifyAction: () => success(null, null, provenance(actor)),
  verifyReconciliation: () => success(null, null, provenance(actor)),
});

const setup = (actor = "cli-chain") => {
  const { root, remote } = repo();
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "workit_cli", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeAuthority: verifier(actor),
  });
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  return { root, remote, store, core, actor, taskId: (started.data as { id: string }).id };
};

const resolvePlan = (root: string, steps: unknown[], branch: string) => {
  const resolved = resolveExternalActionRequest(root, {
    operation: "git.commit",
    payload: { plan_steps: steps, plan_branch: branch },
  } as never);
  if (!resolved.ok) throw new Error(resolved.error);
  return externalActionDescriptor("git.commit", resolved.data.descriptorPayload);
};

const recordChain = (
  setupValue: ReturnType<typeof setup>,
  descriptor: string,
  presented = "approve the chain",
) => {
  const { store, core, taskId } = setupValue;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const decision = core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId,
      expectedRevision: task.data.revision,
      purpose: "action",
      binding: {
        taskId,
        workspaceId: workspace.data.id,
        scope: task.data.intent.data.scope,
        presented,
        approvedContent: descriptor,
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    { kind: "decision", actor: setupValue.actor },
  );
  if (!decision.ok) throw new Error(decision.error);
};

test("chain steps normalize strings and typed entries to unambiguous keys", () => {
  expect(normalizeChainSteps(["a", "b"])).toEqual([
    { kind: "commit", message: "a" },
    { kind: "commit", message: "b" },
  ]);
  expect(normalizeChainSteps([{ branch: "feature/x" }, { pr: true }])).toEqual([
    { kind: "branch", target: "feature/x" },
    { kind: "pr" },
  ]);
  expect(chainStepKey({ kind: "commit", message: "a" })).toBe("a");
  expect(chainStepKey({ kind: "branch", target: "feature/x" })).toBe("branch:feature/x");
  expect(chainStepKey({ kind: "pr" })).toBe("pr");
  expect(normalizeChainSteps([])).toBeNull();
  expect(normalizeChainSteps(["a", "a"])).toBeNull();
  expect(normalizeChainSteps(["branch:x", { branch: "x" }])).toBeNull();
  expect(normalizeChainSteps([{ branch: "" }])).toBeNull();
  expect(normalizeChainSteps([{ pr: false }])).toBeNull();
  expect(normalizeChainSteps("nope")).toBeNull();
});

test("mixed chains match branch, commit, and pr steps in order", () => {
  const value = setup();
  try {
    const descriptor = resolvePlan(
      value.root,
      [{ branch: "feature/next" }, "chore(test): one", { pr: true }],
      "feature/next",
    );
    recordChain(value, descriptor);
    expect(
      approvedChainStep(value.store, "workit_cli", value.actor, {
        operation: "git.branch_setup",
        target: "feature/next",
      }).ok,
    ).toBe(true);
    expect(approvedPlanCommit(value.store, "workit_cli", value.actor, "chore(test): one").ok).toBe(
      false,
    );
    expect(
      approvedChainStep(value.store, "workit_cli", value.actor, {
        operation: "git.branch_setup",
        target: "feature/other",
      }).ok,
    ).toBe(false);
    expect(
      approvedChainStep(value.store, "workit_cli", value.actor, {
        operation: "hosting.pull_request",
      }).ok,
    ).toBe(false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

test("pure-string plans keep matching through the plan path with lease", () => {
  const value = setup();
  try {
    const descriptor = resolvePlan(value.root, ["chore(test): one"], "feature/chain");
    recordChain(value, descriptor);
    expect(approvedPlanCommit(value.store, "workit_cli", value.actor, "chore(test): one").ok).toBe(
      true,
    );
    expect(approvedPlanCommit(value.store, "workit_cli", value.actor, "other").ok).toBe(false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

test("history rewrites break the chain lease", () => {
  const value = setup();
  try {
    writeFileSync(join(value.root, "second.txt"), "second\n");
    git(value.root, ["add", "second.txt"]);
    git(value.root, ["commit", "-qm", "second"]);
    const descriptor = resolvePlan(value.root, ["chore(test): one"], "feature/chain");
    recordChain(value, descriptor);
    expect(approvedPlanCommit(value.store, "workit_cli", value.actor, "chore(test): one").ok).toBe(
      true,
    );
    git(value.root, ["reset", "-q", "--hard", "HEAD~1"]);
    expect(approvedPlanCommit(value.store, "workit_cli", value.actor, "chore(test): one").ok).toBe(
      false,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

test("mixed plan validation accepts typed steps and rejects collisions", () => {
  const value = setup();
  try {
    const valid = resolveExternalActionRequest(value.root, {
      operation: "git.commit",
      payload: {
        plan_steps: [{ branch: "feature/next" }, "chore(test): one"],
        plan_branch: "feature/next",
      },
    } as never);
    expect(valid.ok).toBe(true);
    for (const bad of [
      [{ branch: "feature/next" }, "branch:feature/next"],
      [{ branch: "" }],
      [{ pr: false }],
      [],
    ]) {
      const resolved = resolveExternalActionRequest(value.root, {
        operation: "git.commit",
        payload: { plan_steps: bad, plan_branch: "feature/chain" },
      } as never);
      expect(resolved.ok, JSON.stringify(bad)).toBe(false);
    }
    const wrongBranch = resolveExternalActionRequest(value.root, {
      operation: "git.commit",
      payload: { plan_steps: ["chore(test): one"], plan_branch: "feature/other" },
    } as never);
    expect(wrongBranch.ok).toBe(false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

test("mixed chains propose chain text while pure plans keep legacy text", () => {
  const mixed = actionProposalQuestion({ operation: "git.commit", payload: {} } as never, {
    plan_steps: [{ branch: "feature/next" }, "chore(test): one"],
    plan_branch: "feature/next",
  });
  expect(mixed.presented).toContain("chain");
  const pure = actionProposalQuestion({ operation: "git.commit", payload: {} } as never, {
    plan_steps: ["chore(test): one"],
    plan_branch: "feature/chain",
  });
  expect(pure.presented).toContain("listed tasks");
});
