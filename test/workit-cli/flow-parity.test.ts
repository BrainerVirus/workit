import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runFlowCommand,
  runHandoffCommand,
  type FlowCliDeps,
} from "../../packages/workit-cli/src/flow";
import * as flowState from "../../packages/workit-core/src/core/flow-state";
import {
  DESTINATION_MENU_LABELS,
  HANDOFF_DESTINATION_MARKER,
} from "../../packages/workit-core/src/core/menu";

// Task 6 (CA-19, CA-21): the CLI flow/handoff surface maps argv + a
// TTY/--confirm confirmation seam to the shared core. These tests drive the
// exported runner with injected stdinIsTTY / confirm / verifyProject and assert
// the exact command surface, exit contract (0/1/2), confirmation evidence
// shapes, structured lifecycle failures, and core-generated handoff output.

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const flowJsonPath = (root: string, slug: string) =>
  path.join(root, "docs", slug, "sdd", "flow.json");

type FlowJsonOverrides = {
  menu?: { presented: boolean; chosen: string; evidence: unknown };
  execution?: { status: string; mode: string | null; evidence: unknown };
  handoff_destination?: boolean;
};

function fixture(slug = "cli-flow") {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-flow-cli-"));
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const writeFlow = (over: FlowJsonOverrides = {}) => {
    const sdd = path.join(root, "docs", slug, "sdd");
    mkdirSync(sdd, { recursive: true });
    const state = {
      slug,
      activated: true,
      spec: {
        path: `docs/${slug}/spec.md`,
        status: "approved",
        evidence: null,
        approved_digest: sha256(path.join(root, "docs", slug, "spec.md")),
      },
      plan: {
        path: `docs/${slug}/plan.md`,
        status: "approved",
        evidence: null,
        approved_digest: sha256(path.join(root, "docs", slug, "plan.md")),
      },
      menu: over.menu ?? { presented: true, chosen: "subagent-driven", evidence: null },
      execution: over.execution ?? { status: "active", mode: "subagent-driven", evidence: null },
      handoff_destination: over.handoff_destination ?? false,
      updated_at: Date.now(),
    };
    writeFileSync(flowJsonPath(root, slug), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
  };
  const readFlow = () => JSON.parse(readFileSync(flowJsonPath(root, slug), "utf8"));
  const writeProgress = (lines: string[]) => {
    const sdd = path.join(root, "docs", slug, "sdd");
    mkdirSync(sdd, { recursive: true });
    writeFileSync(path.join(sdd, "progress.md"), `${lines.join("\n")}\n`, "utf8");
  };
  return { root, slug, writeFlow, readFlow, writeProgress };
}

function captureStreams() {
  let stdout = "";
  let stderr = "";
  return {
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: (chunk: string) => void (stderr += chunk) },
    read: () => ({ stdout, stderr }),
  };
}

const VERIFY_OK = (root: string) => ({ stdout: "", stderr: "", exitCode: 0, cwd: root });
const VERIFY_FAIL = (root: string) => ({ stdout: "", stderr: "", exitCode: 1, cwd: root });

async function runFlow(
  args: string[],
  opts: {
    cwd: string;
    stdinIsTTY?: boolean;
    confirm?: () => Promise<boolean>;
    verifyProject?: (
      root: string,
      dryRun?: boolean,
    ) => {
      stdout: string;
      stderr: string;
      exitCode: number;
      cwd: string;
    };
  },
) {
  const c = captureStreams();
  const previous = process.env.WORKFLOW_WORKSPACE_ROOT;
  delete process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    const deps: FlowCliDeps = {
      cwd: opts.cwd,
      stdinIsTTY: () => opts.stdinIsTTY ?? false,
      confirm: opts.confirm,
      verifyProject: opts.verifyProject,
      out: c.out,
      err: c.err,
    };
    const code = await runFlowCommand(args, deps);
    return { code, ...c.read() };
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = previous;
  }
}

async function runHandoff(args: string[], opts: { cwd: string; stdinIsTTY?: boolean }) {
  const c = captureStreams();
  const previous = process.env.WORKFLOW_WORKSPACE_ROOT;
  delete process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    const code = await runHandoffCommand(args, {
      cwd: opts.cwd,
      stdinIsTTY: () => opts.stdinIsTTY ?? false,
      out: c.out,
      err: c.err,
    });
    return { code, ...c.read() };
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = previous;
  }
}

// Capture the evidence argument transitionExecution receives without replacing
// the real mutation: the spy calls through to the original core implementation
// (ESM live bindings make the CLI's imported binding see the mock).
function spyEvidence(): { captured: () => unknown; restore: () => void } {
  const original = flowState.transitionExecution;
  let seen: unknown;
  const spy = spyOn(flowState, "transitionExecution").mockImplementation(((...args: unknown[]) => {
    seen = args[4];
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as never);
  return { captured: () => seen, restore: () => spy.mockRestore() };
}

test("flow status prints effective flow JSON with slug/spec/plan/menu/execution/drift", async () => {
  const { root, slug, writeFlow } = fixture();
  writeFlow();
  try {
    const r = await runFlow(["status", "--plan", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.slug).toBe(slug);
    expect(data.spec.path).toBe(`docs/${slug}/spec.md`);
    expect(data.plan.path).toBe(`docs/${slug}/plan.md`);
    expect(data.menu).toMatchObject({ presented: true, chosen: "subagent-driven" });
    expect(data.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
    expect(data.handoff_destination).toBe(false);
    expect(data.drift).toEqual([]);
    expect(data.flow_path).toBe(`docs/${slug}/sdd/flow.json`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flow status on a non-activated flow exits 1 with flow_not_activated on stderr", async () => {
  const { root, slug } = fixture();
  try {
    const r = await runFlow(["status", "--plan", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const data = JSON.parse(r.stderr);
    expect(data.ok).toBe(false);
    expect(data.code).toBe("flow_not_activated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutation in non-TTY mode without --confirm exits 2 with the exact message and does not mutate", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow();
  try {
    const r = await runFlow(["pause", "--plan", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--confirm required when stdin is not a TTY");
    expect(readFlow().execution.status).toBe("active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--confirm supplies the exact CLI flag evidence and the transition succeeds", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow();
  const ev = spyEvidence();
  try {
    const r = await runFlow(["pause", "--plan", `docs/${slug}/plan.md`, "--confirm"], {
      cwd: root,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(ev.captured()).toEqual({ host: "cli", attested: false, confirmation: "flag" });
    expect(readFlow().execution.status).toBe("paused");
  } finally {
    ev.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("positive TTY prompt supplies the tty confirmation and the transition succeeds", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow();
  const ev = spyEvidence();
  try {
    const r = await runFlow(["pause", "--plan", `docs/${slug}/plan.md`], {
      cwd: root,
      stdinIsTTY: true,
      confirm: async () => true,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(ev.captured()).toEqual({ host: "cli", attested: false, confirmation: "tty" });
    expect(readFlow().execution.status).toBe("paused");
  } finally {
    ev.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("negative TTY answer exits 2 without mutation", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow();
  try {
    const r = await runFlow(["pause", "--plan", `docs/${slug}/plan.md`], {
      cwd: root,
      stdinIsTTY: true,
      confirm: async () => false,
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("cancelled — no confirmation");
    expect(readFlow().execution.status).toBe("active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause/resume success transitions and structured failure codes", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();

  const pauseActive = async () =>
    runFlow(["pause", "--plan", `docs/${slug}/plan.md`, "--confirm"], { cwd: root });
  const resumePaused = async () =>
    runFlow(["resume", "--plan", `docs/${slug}/plan.md`, "--confirm"], { cwd: root });

  try {
    writeFlow();
    const paused = await pauseActive();
    expect(paused.code, paused.stdout + paused.stderr).toBe(0);
    expect(JSON.parse(paused.stdout).execution.status).toBe("paused");
    expect(readFlow().execution.status).toBe("paused");

    const resumed = await resumePaused();
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).execution.status).toBe("active");
    expect(readFlow().execution.status).toBe("active");

    const already = await resumePaused();
    expect(already.code).toBe(1);
    const alreadyData = JSON.parse(already.stderr);
    expect(alreadyData.code).toBe("flow_not_paused");

    writeFlow({ execution: { status: "pending", mode: null, evidence: null } });
    const pending = await pauseActive();
    expect(pending.code).toBe(1);
    expect(JSON.parse(pending.stderr).code).toBe("flow_not_active");

    writeFlow({ execution: { status: "paused", mode: "subagent-driven", evidence: null } });
    const doublePaused = await pauseActive();
    expect(doublePaused.code).toBe(1);
    expect(JSON.parse(doublePaused.stderr).code).toBe("flow_already_paused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete fails with execution_incomplete details when the ledger is not complete", async () => {
  const { root, slug, writeFlow } = fixture();
  writeFlow();
  try {
    const r = await runFlow(["complete", "--plan", `docs/${slug}/plan.md`, "--confirm"], {
      cwd: root,
      verifyProject: VERIFY_OK,
    });
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stderr);
    expect(data.code).toBe("execution_incomplete");
    expect(data.details).toMatchObject({ required: [1], missing: [1] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete fails with verification_failed details when repository verification fails", async () => {
  const { root, slug, writeFlow, writeProgress } = fixture();
  writeFlow();
  writeProgress(["Task 1: complete"]);
  try {
    const r = await runFlow(["complete", "--plan", `docs/${slug}/plan.md`, "--confirm"], {
      cwd: root,
      verifyProject: VERIFY_FAIL,
    });
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stderr);
    expect(data.code).toBe("verification_failed");
    expect(data.details).toMatchObject({ exitCode: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete succeeds when the ledger is complete and verification passes", async () => {
  const { root, slug, writeFlow, writeProgress, readFlow } = fixture();
  writeFlow();
  writeProgress(["Task 1: complete"]);
  try {
    const r = await runFlow(["complete", "--plan", `docs/${slug}/plan.md`, "--confirm"], {
      cwd: root,
      verifyProject: VERIFY_OK,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.execution.status).toBe("completed");
    expect(data.drift).toEqual([]);
    expect(readFlow().execution.status).toBe("completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff emits the core prompt with the marker and four-choice allow-list, then marks", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow({ menu: { presented: true, chosen: "handoff", evidence: null } });
  try {
    const r = await runHandoff(["--message", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(HANDOFF_DESTINATION_MARKER);
    expect(r.stdout.endsWith("\n")).toBe(true);
    for (const label of DESTINATION_MENU_LABELS) {
      expect(r.stdout, label).toContain(`- ${label}`);
    }
    expect(r.stdout).not.toContain("- Handoff");
    expect(readFlow().handoff_destination).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff validation failure exits 1 and does not mark the destination", async () => {
  const { root, slug, writeFlow, readFlow } = fixture();
  writeFlow({ menu: { presented: true, chosen: "handoff", evidence: null } });
  try {
    // Corrupt the plan so the shared docs validation fails inside generation.
    writeFileSync(path.join(root, "docs", slug, "plan.md"), "# broken\n", "utf8");
    const r = await runHandoff(["--message", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const data = JSON.parse(r.stderr);
    expect(data.code).toBe("handoff_build_failed");
    expect(readFlow().handoff_destination).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second handoff on an already-marked destination exits 1 with recursive_handoff", async () => {
  const { root, slug, writeFlow } = fixture();
  writeFlow({
    menu: { presented: true, chosen: "handoff", evidence: null },
    handoff_destination: true,
  });
  try {
    const r = await runHandoff(["--message", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toBe("");
    const data = JSON.parse(r.stderr);
    expect(data.code).toBe("recursive_handoff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flow status reports handoff_destination after the destination is marked", async () => {
  const { root, slug, writeFlow } = fixture();
  writeFlow({
    menu: { presented: true, chosen: "handoff", evidence: null },
    handoff_destination: true,
  });
  try {
    const r = await runFlow(["status", "--plan", `docs/${slug}/plan.md`], { cwd: root });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.handoff_destination).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage errors exit 2 with stderr diagnostics", async () => {
  const { root, slug } = fixture();
  try {
    const cases: { args: string[]; run: typeof runFlow | typeof runHandoff }[] = [
      { args: [], run: runFlow },
      { args: ["bogus", "--plan", `docs/${slug}/plan.md`], run: runFlow },
      { args: ["status"], run: runFlow },
      { args: ["status", "--plan"], run: runFlow },
      { args: ["status", "--plan", `docs/${slug}/plan.md`, "--confirm"], run: runFlow },
      { args: ["pause", "--plan", `docs/${slug}/plan.md`, "--bogus"], run: runFlow },
      { args: ["pause", "--plan", `docs/${slug}/plan.md`, "--plan", `docs/${slug}/plan.md`], run: runFlow },
      { args: ["pause", "--plan", `docs/${slug}/plan.md`, "--confirm", "--confirm"], run: runFlow },
      { args: ["pause", "--plan", "--confirm"], run: runFlow },
      { args: [], run: runHandoff },
      { args: ["--message"], run: runHandoff },
      { args: ["--message", "docs/x/plan.md", "--bogus"], run: runHandoff },
    ];
    for (const c of cases) {
      const r = await c.run(c.args, { cwd: root });
      expect(r.code, `${c.args.join(" ")} -> ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
