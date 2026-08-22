import { expect, test, mock } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

const realFs = { ...nodeFs };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
import {
  COORDINATOR_RECOVERY_TEXT,
  assertProductGates,
  assertSddControlGates,
  prepareFlowState,
  readEffectiveFlowState,
  readFlowState,
  recordMenuChoice,
  transitionExecution,
  transitionPlan,
  transitionSpec,
  writeFlowStateIfCurrent,
  type FlowReadResult,
  type MutationContext,
} from "../../packages/workit-core/src/core/flow-state";
import { resolveBranch } from "../../packages/workit-core/src/core/branch";
import {
  sddAppendProgress,
  sddReviewPackage,
  sddTaskBrief,
} from "../../packages/workit-core/src/core/sdd";
import type { runVerifyProject } from "../../packages/workit-core/src/core/verify-project";
import {
  findActiveSubagentDrivenPlans,
  scanActiveSubagentDrivenPlans,
} from "../../packages/workit-core/src/core/detector";
import {
  roleFromParentage,
  subagentDrivenInterception,
} from "../../packages/workit-core/src/core/flow-state";
import { COMPLIANT_PLAN, COMPLIANT_SPEC, evidence, openEvidence } from "./flow-fixtures";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-concurrency-"));
  const slug = "conc-flow";
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const coordinator = (root: string, sessionId = "coordinator-session"): MutationContext => ({
  hostWorkspace: root,
  role: "coordinator",
  sessionId,
});

const delegated = (root: string, taskIdentity = "workit-worker"): MutationContext => ({
  hostWorkspace: root,
  role: "delegated",
  sessionId: `task-${taskIdentity}`,
  parentSessionId: COORDINATOR_SESSION,
  taskIdentity,
});

const writeDocs = (root: string, slug: string) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
};

const approveSpecAndPlan = (root: string, slug: string) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  for (const step of [
    transitionSpec(root, slug, spec, evidence("Approve spec")),
    transitionPlan(root, slug, plan, evidence("Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
};

const COORDINATOR_SESSION = "coord-root";

const establishSubagentDriven = (root: string, slug: string) => {
  writeDocs(root, slug);
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, {
    spec_path: `docs/${slug}/spec.md`,
    plan_path: plan,
  });
  if (!prep.ok) throw new Error(prep.error);
  approveSpecAndPlan(root, slug);
  const recorded = recordMenuChoice(
    root,
    slug,
    plan,
    "subagent-driven",
    evidence("subagent-driven"),
    { hostWorkspace: root, role: "coordinator", sessionId: COORDINATOR_SESSION },
  );
  if (!recorded.ok) throw new Error(recorded.error);
};

const flowFile = (root: string, slug: string) => path.join(root, "docs", slug, "sdd", "flow.json");

test("CA-20: coordinator product edits are blocked after subagent-driven selection", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("coordinator_blocked");
      expect(gate.error).toContain(COORDINATOR_RECOVERY_TEXT);
    }
  } finally {
    cleanup(root);
  }
});

test("CA-20: coordinator stays allowed when the menu was not subagent-driven", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    const recorded = recordMenuChoice(root, slug, plan, "handoff", evidence("handoff"));
    expect(recorded.ok).toBe(true);
    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-20: authenticated delegated workers are allowed; unauthenticated ones are not", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const allowed = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      delegated(root),
    );
    expect(allowed.ok).toBe(true);
    const unauthenticated = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      { hostWorkspace: root, role: "delegated", sessionId: "worker-without-identity" },
    );
    expect(unauthenticated.ok).toBe(false);
    if (!unauthenticated.ok) expect(unauthenticated.code).toBe("delegation_lineage_denied");
    // A properly-lineaged child lacking a task identity stays unauthenticated.
    const lineagedNoIdentity = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      {
        hostWorkspace: root,
        role: "delegated",
        sessionId: "w2",
        parentSessionId: COORDINATOR_SESSION,
      },
    );
    expect(lineagedNoIdentity.ok).toBe(false);
    if (!lineagedNoIdentity.ok) expect(lineagedNoIdentity.code).toBe("delegated_unauthenticated");
  } finally {
    cleanup(root);
  }
});

test("CA-21: active discovery uses the host workspace, not process.cwd()", () => {
  const { root, slug } = fixture();
  const other = mkdtempSync(path.join(os.tmpdir(), "wf-unrelated-cwd-"));
  const previous = process.cwd();
  try {
    establishSubagentDriven(root, slug);
    process.chdir(other);
    try {
      expect(findActiveSubagentDrivenPlans(root)).toEqual([slug]);
      expect(findActiveSubagentDrivenPlans(other)).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup(root);
  }
});

test("FG-08/CA-21: unique per-write temp names never reuse a shared <file>.tmp", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const stale = `${flowFile(root, slug)}.tmp`;
    writeFileSync(stale, "stale-writer-buffer", "utf8");
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence("Approve spec"));
    expect(result.ok).toBe(true);
    expect(readFileSync(stale, "utf8")).toBe("stale-writer-buffer");
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("FG-08: stale concurrent writers are preserved via compare/retry, never clobbered", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);

    const stale = readFlowState(root, slug);
    expect(stale.menu.presented).toBe(false);

    const newerNext = {
      ...stale,
      menu: { presented: true, chosen: "subagent-driven", evidence: null },
      updated_at: Date.now(),
    };
    const freshCommit = writeFlowStateIfCurrent(root, stale, newerNext);
    expect(freshCommit.ok).toBe(true);

    const clobbering = writeFlowStateIfCurrent(root, stale, {
      ...stale,
      menu: { presented: true, chosen: "handoff", evidence: null },
      updated_at: Date.now(),
    });
    expect(clobbering.ok).toBe(false);
    if (!clobbering.ok && "conflict" in clobbering) expect(clobbering.conflict).toBe(true);
    expect(readFlowState(root, slug).menu.chosen).toBe("subagent-driven");
  } finally {
    cleanup(root);
  }
});

test("FG-08: a transition re-reads and retries on the fresh state after a concurrent commit", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const concurrent = readFlowState(root, slug);
    const committed = writeFlowStateIfCurrent(root, concurrent, {
      ...concurrent,
      menu: { presented: true, chosen: "inline", evidence: null },
      updated_at: Date.now(),
    });
    expect(committed.ok).toBe(true);

    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence("Approve spec"));
    expect(result.ok).toBe(true);
    const finalState = readFlowState(root, slug);
    expect(finalState.spec.status).toBe("approved");
    expect(finalState.menu.chosen).toBe("inline");
  } finally {
    cleanup(root);
  }
});

test("CA-28: a failed-session fixture cannot be skipped and keeps flow state isolated", () => {
  const { root, slug } = fixture();
  try {
    const dir = path.join(root, "docs", slug, "sdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "flow.json.tmp"), '{"partial":', "utf8");

    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("flow_not_activated");

    const transition = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence("Approve"));
    expect(transition.ok).toBe(false);
    if (!transition.ok) expect(transition.code).toBe("flow_not_activated");

    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
    expect(existsSync(flowFile(root, slug))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("FG-08: two writers with the same expected text — only one wins", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const expected = readFlowState(root, slug);

    const writerA = {
      ...expected,
      menu: { presented: true, chosen: "subagent-driven", evidence: null },
      updated_at: Date.now(),
    };
    const writerB = {
      ...expected,
      menu: { presented: true, chosen: "handoff", evidence: null },
      updated_at: Date.now(),
    };

    // Writer B holds the same expected text as writer A. Simulate A committing
    // in the window between B's compare and B's rename: when B stages its temp
    // buffer (opened with openSync), A's content is already on disk, so B must
    // lose the race.
    let injected = false;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (p: unknown, flags?: unknown) => {
        const fd = realFs.openSync(p as string, flags as string);
        if (!injected && typeof p === "string" && p.endsWith(".tmp")) {
          injected = true;
          realFs.writeFileSync(
            flowFile(root, slug),
            JSON.stringify(writerA, null, 2) + "\n",
            "utf8",
          );
        }
        return fd;
      },
    }));

    const commit = writeFlowStateIfCurrent(root, expected, writerB);
    expect(commit.ok).toBe(false);
    if (!commit.ok && "conflict" in commit) expect(commit.conflict).toBe(true);
    const finalState = readFlowState(root, slug);
    expect(finalState.menu.chosen).toBe("subagent-driven");
    expect(injected).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("A4: an EACCES flow write surfaces io_error (never conflict) and leaves no .tmp behind", () => {
  // win32 chmod is not advisory — an 0555 dir stays writable, so the EACCES
  // path cannot be exercised there (mirrors the workit-cli EACCES skips).
  if (process.platform === "win32") return;
  const { root, slug } = fixture();
  const sddDir = path.join(root, "docs", slug, "sdd");
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    const expected = readFlowState(root, slug);

    chmodSync(sddDir, 0o555);
    const result = writeFlowStateIfCurrent(root, expected, {
      ...expected,
      menu: { presented: true, chosen: "inline", evidence: null },
      updated_at: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect("conflict" in result).toBe(false);
      expect("io_error" in result).toBe(true);
      if ("io_error" in result) expect(result.io_error).toMatch(/EACCES|permission/i);
    }
    chmodSync(sddDir, 0o755);
    expect(readdirSync(sddDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  } finally {
    chmodSync(sddDir, 0o755);
    cleanup(root);
  }
});

test("A4: a transition with an unwritable flow store returns flow_io_error, not a conflict retry", () => {
  const { root, slug } = fixture();
  const sddDir = path.join(root, "docs", slug, "sdd");
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    chmodSync(sddDir, 0o555);
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence("Approve spec"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_io_error");
  } finally {
    chmodSync(sddDir, 0o755);
    cleanup(root);
  }
});

test("A5: a mutation context for another workspace is rejected with workspace_mismatch", () => {
  const { root, slug } = fixture();
  const other = mkdtempSync(path.join(os.tmpdir(), "wf-other-ws-"));
  try {
    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      { hostWorkspace: other, role: "coordinator", sessionId: "other-session" },
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("workspace_mismatch");
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup(root);
  }
});

test("CA-20/AR-12: delegation derives from host parentage, and delegated contexts pass the product gate", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const child = roleFromParentage("coordinator-session", "coordinator-session");
    expect(child).toBe("delegated");
    const allowed = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      {
        hostWorkspace: root,
        role: child,
        sessionId: "child-session",
        taskIdentity: "child-session",
      },
    );
    expect(allowed.ok).toBe(true);
    const rootSession = roleFromParentage(undefined);
    expect(rootSession).toBe("coordinator");
    const blocked = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      { hostWorkspace: root, role: rootSession, sessionId: "root-session" },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("coordinator_blocked");
  } finally {
    cleanup(root);
  }
});

test("CA-18/AR-13: root-session interception blocks write tools and mutating shell once subagent-driven is active", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const active = findActiveSubagentDrivenPlans(root).length > 0;
    expect(active).toBe(true);
    // SDD control tools are coordinator-owned via assertSddControlGates
    // (Task 3) and are no longer product-write interceptions.
    for (const tool of ["write", "edit", "apply_patch", "patch", "workit_commit"]) {
      const decision = subagentDrivenInterception({
        tool,
        parentID: undefined,
        activeCoordinatorIds: [COORDINATOR_SESSION],
      });
      expect(decision.ok, tool).toBe(false);
    }
    const shell = subagentDrivenInterception({
      tool: "bash",
      command: "git push origin main",
      parentID: undefined,
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(shell.ok).toBe(false);
    if (!shell.ok) expect(shell.code).toBe("coordinator_shell_denied");
    const read = subagentDrivenInterception({
      tool: "bash",
      command: "bun run check",
      parentID: undefined,
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(read.ok).toBe(true);
    // The authorized direct child of the recorded coordinator is not intercepted.
    const child = subagentDrivenInterception({
      tool: "write",
      command: undefined,
      parentID: COORDINATOR_SESSION,
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(child.ok).toBe(true);
    // An unrelated child fails closed with the structured lineage error.
    const unrelated = subagentDrivenInterception({
      tool: "write",
      command: undefined,
      parentID: "unrelated-root",
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(unrelated.ok).toBe(false);
    if (!unrelated.ok) expect(unrelated.code).toBe("delegation_lineage_denied");
  } finally {
    cleanup(root);
  }
});

test("CA-19: a held flow.json.lock yields flow_concurrent_conflict, then recovers", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const lock = `${flowFile(root, slug)}.lock`;
    const fd = openSync(lock, "wx");
    try {
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(false);
      if (!effective.ok) expect(effective.code).toBe("flow_concurrent_conflict");
      const transition = transitionSpec(
        root,
        slug,
        `docs/${slug}/spec.md`,
        evidence("Approve spec"),
      );
      expect(transition.ok).toBe(false);
      if (!transition.ok) expect(transition.code).toBe("flow_concurrent_conflict");
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
    const recovered = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence("Approve spec"));
    expect(recovered.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
    const leftovers = readdirSync(path.dirname(flowFile(root, slug))).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock") || f.endsWith(".stale"),
    );
    expect(leftovers).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("CA-19: a stale flow.json.lock (older than STALE_LOCK_MS) is recovered instead of a permanent conflict", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const lock = `${flowFile(root, slug)}.lock`;
    writeFileSync(lock, "", "utf8");
    const past = Date.now() - 5_000;
    utimesSync(lock, new Date(past), new Date(past));
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
    const leftovers = readdirSync(path.dirname(flowFile(root, slug))).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock") || f.endsWith(".stale"),
    );
    expect(leftovers).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("CA-19: a leftover .lock.stale from a crashed recovery is removed on the next acquisition", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const stale = `${flowFile(root, slug)}.lock.stale`;
    writeFileSync(stale, "", "utf8");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("CA-19: activation is a locked critical section: prepareFlowState under a held lock conflicts", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(prep.ok).toBe(true);
    const lock = `${flowFile(root, slug)}.lock`;
    const fd = openSync(lock, "wx");
    try {
      const result = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("flow_concurrent_conflict");
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
    // Once the lock clears, activation runs again without contention.
    const recovered = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(recovered.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-19: a fresh flow.json.lock is NOT reclaimed as stale and still yields flow_concurrent_conflict", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const lock = `${flowFile(root, slug)}.lock`;
    const fd = openSync(lock, "wx");
    try {
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(false);
      if (!effective.ok) expect(effective.code).toBe("flow_concurrent_conflict");
      // The fresh lock survives the bounded retries: stale recovery never
      // deletes a lock a live writer may still hold.
      expect(existsSync(lock)).toBe(true);
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  } finally {
    cleanup(root);
  }
});

test("CA-19: an unremovable stale lock returns flow_concurrent_conflict and never runs the critical section", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    // Drift the plan so the critical section WOULD persist a reset if it ran.
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it now"),
    );
    const before = readFileSync(flowFile(root, slug), "utf8");
    const lock = `${flowFile(root, slug)}.lock`;
    writeFileSync(lock, "", "utf8");
    const past = Date.now() - 5_000;
    utimesSync(lock, new Date(past), new Date(past));
    // The stale lock cannot be reclaimed: recovery's rename is injected to fail
    // on every attempt (mirrors an unremovable lock), so each acquisition
    // attempt hits EEXIST and the critical section must never run.
    let rejections = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      renameSync: (src: unknown, dest?: unknown) => {
        if (typeof src === "string" && src.endsWith(".lock")) {
          rejections += 1;
          throw new Error("EACCES: stale lock is not reclaimable (injected)");
        }
        return realFs.renameSync(src as string, dest as string);
      },
    }));
    const effective = readEffectiveFlowState(root, slug);
    expect(rejections).toBeGreaterThan(0);
    expect(effective.ok).toBe(false);
    if (!effective.ok) expect(effective.code).toBe("flow_concurrent_conflict");
    // The critical section never ran: no drift reset was persisted and the
    // unreclaimed lock is left in place for the next writer.
    expect(readFileSync(flowFile(root, slug), "utf8")).toBe(before);
    expect(existsSync(lock)).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-19: releasing a lock never deletes a successor's lock at the same path", () => {
  const { root, slug } = fixture();
  let successor: number | null = null;
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    const lock = `${flowFile(root, slug)}.lock`;
    // A stale crashed-writer lock: recovery below reclaims it and opens a fresh
    // lock while a successor replaces it at the same path mid-critical-section.
    writeFileSync(lock, "", "utf8");
    const past = Date.now() - 5_000;
    utimesSync(lock, new Date(past), new Date(past));
    let injected = false;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (p: unknown, flags?: unknown) => {
        const fd = realFs.openSync(p as string, flags as string);
        if (!injected && typeof p === "string" && p.endsWith(".lock") && flags === "wx") {
          injected = true;
          // A successor unlinks our fresh lock and creates its own at the same
          // path while we still hold our descriptor (now an orphaned inode).
          // Release must NOT unlink the successor's lock. The original fd is
          // intentionally left open so it is not reused by the successor open.
          realFs.rmSync(p, { force: true });
          successor = realFs.openSync(p, "wx");
        }
        return fd;
      },
    }));
    const effective = readEffectiveFlowState(root, slug);
    expect(injected).toBe(true);
    expect(effective.ok).toBe(true);
    // The successor's lock survives the original writer's release.
    expect(successor).not.toBeNull();
    expect(existsSync(lock)).toBe(true);
  } finally {
    if (successor !== null) {
      try {
        closeSync(successor);
      } catch {
        // already closed
      }
    }
    cleanup(root);
  }
});

test("A4: a read-path reconcile persist failure returns flow_io_error, never throws through the lock", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    // Drift the plan so the effective read must persist a reset.
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it now"),
    );
    let injected = false;
    mock.module("node:fs", () => ({
      ...realFs,
      renameSync: (src: unknown, dest?: unknown) => {
        if (!injected && typeof src === "string" && src.endsWith(".tmp")) {
          injected = true;
          throw new Error("EACCES: permission denied (injected)");
        }
        return realFs.renameSync(src as string, dest as string);
      },
    }));
    let result: ReturnType<typeof readEffectiveFlowState> | null = null;
    expect(() => {
      result = readEffectiveFlowState(root, slug);
    }).not.toThrow();
    expect(injected).toBe(true);
    expect(result).not.toBeNull();
    const read = result as unknown as FlowReadResult;
    if (read.ok) throw new Error("expected flow_io_error");
    expect(read.code).toBe("flow_io_error");
    expect(read.error).toContain("EACCES");
    expect(read.details).toEqual({
      path: `docs/${slug}/sdd/flow.json`,
      original_bytes_preserved: true,
    });
    // The original flow.json bytes were untouched: the pre-drift approval state.
    const persisted = JSON.parse(readFileSync(flowFile(root, slug), "utf8"));
    expect(persisted.plan.status).toBe("approved");
    expect(persisted.plan.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    const leftovers = readdirSync(path.dirname(flowFile(root, slug))).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock") || f.endsWith(".stale"),
    );
    expect(leftovers).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("CA-19: reconciliation and a reapproval serialize into one winning state with the new digest", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    // Drift the plan, then reapprove: the transition's reconcile resets first
    // and the fresh approval binds the new bytes in the same locked mutation.
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it again"),
    );
    const store = new HostReceiptStore();
    const reapproved = transitionPlan(root, slug, plan, openEvidence(store, "s1", "Approve plan"));
    expect(reapproved.ok).toBe(true);
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.plan).toMatchObject({ status: "approved" });
    const planBytes = readFileSync(path.join(root, "docs", slug, "plan.md"));
    expect(effective.state.plan.approved_digest).toBe(sha256(planBytes));
    // One winning state: valid JSON, no shared temp, no lock leftover.
    const persisted = JSON.parse(readFileSync(flowFile(root, slug), "utf8"));
    expect(persisted.plan.status).toBe("approved");
    const leftovers = readdirSync(path.dirname(flowFile(root, slug))).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock") || f.endsWith(".stale"),
    );
    expect(leftovers).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("CA-19: a reconcile reset persists atomically and a later reapproval wins", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it differently"),
    );
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.state.plan.status).toBe("draft");
    // The reset was persisted, not just returned.
    const persisted = readFlowState(root, slug);
    expect(persisted.plan.status).toBe("draft");
    expect(persisted.plan.approved_digest).toBe(null);
    expect(persisted.spec.status).toBe("approved");
    expect(persisted.spec.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    // A fresh approval then lands on top without losing the spec approval.
    const store = new HostReceiptStore();
    expect(transitionPlan(root, slug, plan, openEvidence(store, "s1", "Approve plan")).ok).toBe(
      true,
    );
    const after = JSON.parse(readFileSync(flowFile(root, slug), "utf8"));
    expect(after.spec.status).toBe("approved");
    expect(after.plan.status).toBe("approved");
    expect(() => JSON.parse(readFileSync(flowFile(root, slug), "utf8"))).not.toThrow();
  } finally {
    cleanup(root);
  }
});

test("CA-18/CA-19: malformed flow.json stays byte-identical through effective reads", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    writeFileSync(flowFile(root, slug), "{not-json", "utf8");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(false);
    if (!effective.ok) {
      expect(effective.code).toBe("flow_state_invalid");
      expect(effective.details).toEqual({
        path: `docs/${slug}/sdd/flow.json`,
        original_bytes_preserved: true,
      });
    }
    expect(readFileSync(flowFile(root, slug), "utf8")).toBe("{not-json");
    const lockLeftovers = readdirSync(path.dirname(flowFile(root, slug))).filter(
      (f) => f.endsWith(".lock") || f.endsWith(".stale"),
    );
    expect(lockLeftovers).toEqual([]);
  } finally {
    cleanup(root);
  }
});

const writeConcurrentLedger = (root: string, slug: string) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\n", "utf8");
};

test("CA-19/CA-23: completion runs the verifier outside the lock and rejects a concurrent state change", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    writeConcurrentLedger(root, slug);
    const plan = `docs/${slug}/plan.md`;
    let lockFreeRead = false;
    const verifier: typeof runVerifyProject = (r) => {
      // The effective read must succeed while the verifier runs: if the flow
      // lock were still held this same-process read would return
      // flow_concurrent_conflict. Succeeding here proves the verifier runs
      // OUTSIDE the locked phase-1 critical section.
      const current = readEffectiveFlowState(r, slug);
      lockFreeRead = current.ok === true;
      if (current.ok) {
        const newer = {
          ...current.state,
          execution: { ...current.state.execution, status: "paused" as const },
          updated_at: Date.now(),
        };
        const commit = writeFlowStateIfCurrent(r, current.state, newer);
        expect(commit.ok).toBe(true);
      }
      return { stdout: "", stderr: "", exitCode: 0, cwd: r };
    };
    const result = transitionExecution(
      root,
      slug,
      plan,
      "complete",
      evidence("complete"),
      undefined,
      { verifyProject: verifier },
    );
    expect(lockFreeRead).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_concurrent_conflict");
    // The newer concurrent state is preserved — completion never overwrites it.
    expect(readFlowState(root, slug).execution.status).toBe("paused");
  } finally {
    cleanup(root);
  }
});

test("CA-18/AR-13: only active subagent-driven flows are discovered and intercepted", () => {
  // Non-active lifecycle/malformed/drift-reset states: nothing is found and
  // the root-session write tools are never blocked.
  const builders: { name: string; build: (root: string, slug: string) => void }[] = [
    {
      name: "pending-handoff",
      build: (r, slug) => {
        writeDocs(r, slug);
        const plan = `docs/${slug}/plan.md`;
        const prep = prepareFlowState(r, slug, {
          spec_path: `docs/${slug}/spec.md`,
          plan_path: plan,
        });
        expect(prep.ok).toBe(true);
        approveSpecAndPlan(r, slug);
        const recorded = recordMenuChoice(r, slug, plan, "handoff", evidence("handoff"));
        expect(recorded.ok).toBe(true);
      },
    },
    {
      name: "paused",
      build: (r, slug) => {
        establishSubagentDriven(r, slug);
        const paused = transitionExecution(
          r,
          slug,
          `docs/${slug}/plan.md`,
          "pause",
          evidence("pause"),
        );
        expect(paused.ok).toBe(true);
      },
    },
    {
      name: "completed",
      build: (r, slug) => {
        establishSubagentDriven(r, slug);
        writeConcurrentLedger(r, slug);
        const done = transitionExecution(
          r,
          slug,
          `docs/${slug}/plan.md`,
          "complete",
          evidence("complete"),
          undefined,
          {
            verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: r }),
          },
        );
        expect(done.ok).toBe(true);
      },
    },
    {
      name: "inline",
      build: (r, slug) => {
        writeDocs(r, slug);
        const plan = `docs/${slug}/plan.md`;
        const prep = prepareFlowState(r, slug, {
          spec_path: `docs/${slug}/spec.md`,
          plan_path: plan,
        });
        expect(prep.ok).toBe(true);
        approveSpecAndPlan(r, slug);
        const recorded = recordMenuChoice(r, slug, plan, "inline", evidence("inline"));
        expect(recorded.ok).toBe(true);
      },
    },
    {
      name: "malformed",
      build: (r, slug) => {
        const dir = path.join(r, "docs", slug, "sdd");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "flow.json"), "{ not json");
      },
    },
  ];
  for (const { name, build } of builders) {
    const { root, slug } = fixture();
    try {
      build(root, slug);
      expect(findActiveSubagentDrivenPlans(root), name).toEqual([]);
      const decision = subagentDrivenInterception({
        tool: "write",
        parentID: undefined,
        activeCoordinatorIds: [],
      });
      expect(decision.ok, name).toBe(true);
    } finally {
      cleanup(root);
    }
  }
  // Positive control: a real active subagent-driven flow IS discovered and its
  // root-session coordinator writes ARE blocked.
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    expect(findActiveSubagentDrivenPlans(root)).toEqual([slug]);
    const blocked = subagentDrivenInterception({
      tool: "write",
      parentID: undefined,
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("coordinator_write_denied");
      expect(blocked.error).toContain(COORDINATOR_RECOVERY_TEXT);
    }
  } finally {
    cleanup(root);
  }
  // A plan-doc edit during execution resets only the plan approval digest; the
  // active lifecycle survives, so the flow is still discovered and the
  // coordinator is still blocked (regression: drift used to reset execution).
  const { root: driftRoot, slug: driftSlug } = fixture();
  try {
    establishSubagentDriven(driftRoot, driftSlug);
    writeFileSync(
      path.join(driftRoot, "docs", driftSlug, "plan.md"),
      COMPLIANT_PLAN(driftSlug).replace("do it", "do it now"),
    );
    expect(findActiveSubagentDrivenPlans(driftRoot)).toEqual([driftSlug]);
    const decision = subagentDrivenInterception({
      tool: "write",
      parentID: undefined,
      activeCoordinatorIds: [COORDINATOR_SESSION],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("coordinator_write_denied");
  } finally {
    cleanup(driftRoot);
  }
});

test("fail-closed scan: a locked flow is reported as a read error, not silently inactive", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    expect(findActiveSubagentDrivenPlans(root)).toEqual([slug]);
    const lock = `${flowFile(root, slug)}.lock`;
    const fd = openSync(lock, "wx");
    try {
      const scan = scanActiveSubagentDrivenPlans(root);
      expect(scan.slugs).toEqual([]);
      expect(scan.read_errors).toEqual([
        {
          slug,
          code: "flow_concurrent_conflict",
          error: expect.stringContaining("concurrent flow"),
        },
      ]);
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
    // Once the lock clears the flow is discovered again — no state was lost.
    expect(findActiveSubagentDrivenPlans(root)).toEqual([slug]);
    // The fail-closed signal is scoped: a genuinely inactive flow is excluded
    // silently with an empty read_errors list.
    const { root: other, slug: otherSlug } = fixture();
    try {
      writeDocs(other, otherSlug);
      const prep = prepareFlowState(other, otherSlug, {
        spec_path: `docs/${otherSlug}/spec.md`,
        plan_path: `docs/${otherSlug}/plan.md`,
      });
      expect(prep.ok).toBe(true);
      expect(scanActiveSubagentDrivenPlans(other)).toEqual({
        slugs: [],
        read_errors: [],
      });
    } finally {
      cleanup(other);
    }
  } finally {
    cleanup(root);
  }
});

test("CA-12: subagent-driven activation persists the activating coordinator session id", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    expect(readFlowState(root, slug).execution.coordinator_session_id).toBe(COORDINATOR_SESSION);
    // Pause/resume preserve it.
    expect(
      transitionExecution(root, slug, `docs/${slug}/plan.md`, "pause", {
        host: "cli",
        attested: false,
        confirmation: "flag",
      }).ok,
    ).toBe(true);
    expect(readFlowState(root, slug).execution.coordinator_session_id).toBe(COORDINATOR_SESSION);
  } finally {
    cleanup(root);
  }
});

test("CA-12..CA-17: literal clean-start contract — menu record -> branch setup -> coordinator brief -> direct worker -> coordinator review/progress with no error result", () => {
  const { root, slug } = fixture();
  const plan = `docs/${slug}/plan.md`;
  try {
    // 1. Menu record: the activating coordinator records subagent-driven.
    establishSubagentDriven(root, slug);
    expect(readFlowState(root, slug).execution.coordinator_session_id).toBe(COORDINATOR_SESSION);

    // 2. Branch setup: the declared branch resolves from spec/plan metadata.
    const branch = resolveBranch({
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
      workspace_root: root,
    });
    expect("error" in branch).toBe(false);

    // 3. Coordinator brief: control gates pass for the root session and the
    // brief lands under gitignored docs/<slug>/sdd/.
    const coordCtx = coordinator(root, COORDINATOR_SESSION);
    const briefGate = assertSddControlGates(root, slug, { requireMenu: true }, coordCtx);
    expect(briefGate.ok).toBe(true);
    const brief = sddTaskBrief({
      sdd_dir: `docs/${slug}/sdd`,
      task_id: 1,
      section_text: "Task 1: do the thing",
      workspace_root: root,
    });
    expect(brief.error).toBeUndefined();
    expect(existsSync(path.join(root, "docs", slug, "sdd", "task-1-brief.md"))).toBe(true);

    // 4. Direct worker: the exact direct child passes product gates.
    const workerGate = assertProductGates(root, slug, { requireMenu: true }, delegated(root));
    expect(workerGate.ok).toBe(true);

    // 4b. The same worker is denied coordinator bookkeeping (fail-closed).
    const workerControl = assertSddControlGates(root, slug, { requireMenu: true }, delegated(root));
    expect(workerControl.ok).toBe(false);
    if (!workerControl.ok) expect(workerControl.code).toBe("sdd_control_denied");

    // 5. Coordinator review/progress: control gates pass again and the
    // validated ledger line appends.
    const reviewGate = assertSddControlGates(root, slug, { requireMenu: true }, coordCtx);
    expect(reviewGate.ok).toBe(true);
    const progress = sddAppendProgress({
      progress_path: `docs/${slug}/sdd/progress.md`,
      line: "Task 1: complete (commits abc1234..def5678, review clean)",
      workspace_root: root,
    });
    expect(progress.error).toBeUndefined();
    expect(readFileSync(path.join(root, "docs", slug, "sdd", "progress.md"), "utf8")).toContain(
      "Task 1: complete",
    );
  } finally {
    cleanup(root);
  }
});

test("CA-16: composed opencode-path clean start — receipts to review package with zero failed calls", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-concurrency-"));
  const slug = "conc-flow";
  const plan = `docs/${slug}/plan.md`;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    // Real git repo so sddReviewPackage can diff a non-empty base..head range.
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: root });
    const baseSha = git("rev-parse", "HEAD");

    // Receipts -> approve spec+plan -> workit_plan_menu(subagent-driven).
    establishSubagentDriven(root, slug);
    expect(readFlowState(root, slug).execution.coordinator_session_id).toBe(COORDINATOR_SESSION);

    // Commit docs+flow state so base..HEAD diffs non-empty.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "docs+flow"], { cwd: root });
    const headSha = git("rev-parse", "HEAD");

    // Branch setup resolves from spec/plan metadata without error.
    const branch = resolveBranch({
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
      workspace_root: root,
    });
    expect("error" in branch).toBe(false);

    // Coordinator task brief: control gates pass for the activating session.
    const coordCtx = coordinator(root, COORDINATOR_SESSION);
    expect(assertSddControlGates(root, slug, { requireMenu: true }, coordCtx).ok).toBe(true);
    const brief = sddTaskBrief({
      sdd_dir: `docs/${slug}/sdd`,
      task_id: 1,
      section_text: "Task 1: do the thing",
      workspace_root: root,
    });
    expect(brief.error).toBeUndefined();
    expect(existsSync(path.join(root, "docs", slug, "sdd", "task-1-brief.md"))).toBe(true);

    // Authorized direct-child product write passes product gates.
    expect(assertProductGates(root, slug, { requireMenu: true }, delegated(root)).ok).toBe(true);

    // Coordinator review package over the real commit range.
    const review = sddReviewPackage({
      sdd_dir: `docs/${slug}/sdd`,
      base_sha: baseSha,
      head_sha: headSha,
      workspace_root: root,
    });
    if ("error" in review) throw new Error(review.error);
    expect(review.diff_path).toContain(
      `review-${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}.diff`,
    );

    // Validated ledger line appends.
    const progress = sddAppendProgress({
      progress_path: `docs/${slug}/sdd/progress.md`,
      line: `Task 1: complete (commits ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}, review clean)`,
      workspace_root: root,
    });
    expect(progress.error).toBeUndefined();
    expect(readFileSync(path.join(root, "docs", slug, "sdd", "progress.md"), "utf8")).toContain(
      `${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`,
    );
  } finally {
    cleanup(root);
  }
});
