import { expect, test, mock } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

const realFs = { ...nodeFs };
import {
  COORDINATOR_RECOVERY_TEXT,
  assertProductGates,
  prepareFlowState,
  readFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
  writeFlowStateIfCurrent,
  type MutationContext,
} from "../../packages/workit-core/src/core/flow-state";
import { findActiveSubagentDrivenPlans } from "../../packages/workit-core/src/core/detector";
import { COMPLIANT_PLAN, COMPLIANT_SPEC, evidence } from "./flow-fixtures";

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
    transitionSpec(root, slug, spec, evidence("opencode", "Approve spec")),
    transitionSpec(root, slug, spec, evidence("opencode", "Approve spec")),
    transitionPlan(root, slug, plan, evidence("opencode", "Approve plan")),
    transitionPlan(root, slug, plan, evidence("opencode", "Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
};

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
    evidence("opencode", "subagent-driven"),
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
    const recorded = recordMenuChoice(root, slug, plan, "handoff", evidence("opencode", "handoff"));
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
    if (!unauthenticated.ok) expect(unauthenticated.code).toBe("delegated_unauthenticated");
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
    const result = transitionSpec(
      root,
      slug,
      `docs/${slug}/spec.md`,
      evidence("opencode", "Approve spec"),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(stale, "utf8")).toBe("stale-writer-buffer");
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");
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

    const result = transitionSpec(
      root,
      slug,
      `docs/${slug}/spec.md`,
      evidence("opencode", "Approve spec"),
    );
    expect(result.ok).toBe(true);
    const finalState = readFlowState(root, slug);
    expect(finalState.spec.status).toBe("self_reviewed");
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

    const transition = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
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
    // buffer, A's content is already on disk, so B must lose the race.
    let injected = false;
    mock.module("node:fs", () => ({
      ...realFs,
      writeFileSync: (p: unknown, data: unknown, enc?: unknown) => {
        const result = realFs.writeFileSync(p as string, data as string, enc as BufferEncoding);
        if (!injected && typeof p === "string" && p.endsWith(".tmp")) {
          injected = true;
          realFs.writeFileSync(
            flowFile(root, slug),
            JSON.stringify(writerA, null, 2) + "\n",
            "utf8",
          );
        }
        return result;
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
    const result = transitionSpec(
      root,
      slug,
      `docs/${slug}/spec.md`,
      evidence("opencode", "Approve spec"),
    );
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
