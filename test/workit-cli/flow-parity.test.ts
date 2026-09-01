import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { assertOpencodeWorkitNamespace } from "../shared/helpers/opencode-namespace";

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

test(
  "flow status prints effective flow JSON with slug/spec/plan/menu/execution/drift",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "flow status on a non-activated flow exits 1 with flow_not_activated on stderr",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "mutation in non-TTY mode without --confirm exits 2 with the exact message and does not mutate",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "--confirm supplies the exact CLI flag evidence and the transition succeeds",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "CLI evidence is label-free: the opencode-only menu label gate cannot apply to the policy-only confirmation",
  async () => {
    const { root, slug, writeFlow, readFlow } = fixture();
    writeFlow();
    const ev = spyEvidence();
    try {
      const r = await runFlow(["pause", "--plan", `docs/${slug}/plan.md`, "--confirm"], {
        cwd: root,
      });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      // The CLI confirmation carries no selected label (and no slot to attach a
      // host-observed one), so qualifier decoration never reaches this path and
      // the sameChoiceLabel gate — scoped to opencode receipts — cannot change
      // the outcome here (CA-42 parity).
      expect(ev.captured()).toEqual({ host: "cli", attested: false, confirmation: "flag" });
      expect(Object.keys(ev.captured() as object).sort()).toEqual([
        "attested",
        "confirmation",
        "host",
      ]);
      expect(readFlow().execution.status).toBe("paused");
    } finally {
      ev.restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "positive TTY prompt supplies the tty confirmation and the transition succeeds",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "negative TTY answer exits 2 without mutation",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "pause/resume success transitions and structured failure codes",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "complete fails with execution_incomplete details when the ledger is not complete",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "complete fails with verification_failed details when repository verification fails",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "complete succeeds when the ledger is complete and verification passes",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "handoff emits the core prompt with the marker and four-choice allow-list, then marks",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "handoff validation failure exits 1 and does not mark the destination",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "a second handoff on an already-marked destination exits 1 with recursive_handoff",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "flow status reports handoff_destination after the destination is marked",
  async () => {
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
  },
  { timeout: 60_000 },
);

test(
  "flow review-package parity: same-sha range rejected, real range writes the diff",
  async () => {
    const { root, slug } = fixture();
    const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    try {
      expect(git(["init", "-q", "-b", `feature/${slug}`]).status).toBe(0);
      git(["config", "user.name", "Workflow Test"]);
      git(["config", "user.email", "workflow@example.test"]);
      writeFileSync(path.join(root, "file.txt"), "one\n");
      git(["add", "file.txt"]);
      git(["commit", "-q", "-m", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();

      const same = await runFlow(
        [
          "review-package",
          "--plan",
          `docs/${slug}/plan.md`,
          "--base",
          base,
          "--head",
          base,
          "--confirm",
        ],
        { cwd: root },
      );
      expect(same.code, same.stdout + same.stderr).toBe(1);
      expect(same.stdout).toBe("");
      const sameData = JSON.parse(same.stderr);
      expect(sameData.ok).toBe(false);
      expect(sameData.code).toBe("empty_commit_range");
      expect(JSON.stringify(sameData)).toContain("empty commit range");
      const base7 = base.slice(0, 7);
      expect(existsSync(path.join(root, `docs/${slug}/sdd/review-${base7}..${base7}.diff`))).toBe(
        false,
      );

      writeFileSync(path.join(root, "file.txt"), "one\ntwo\n");
      git(["commit", "-q", "-am", "head"]);
      const head = git(["rev-parse", "HEAD"]).stdout.trim();
      const ok = await runFlow(
        [
          "review-package",
          "--plan",
          `docs/${slug}/plan.md`,
          "--base",
          base,
          "--head",
          head,
          "--confirm",
        ],
        { cwd: root },
      );
      expect(ok.code, ok.stdout + ok.stderr).toBe(0);
      expect(ok.stderr).toBe("");
      const okData = JSON.parse(ok.stdout);
      expect(okData.ok).toBe(true);
      expect(okData.diff_path).toBe(`docs/${slug}/sdd/review-${base7}..${head.slice(0, 7)}.diff`);
      expect(readFileSync(path.join(root, okData.diff_path), "utf8")).toContain("+two");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "flow review-package in non-TTY mode without --confirm exits 2 and writes nothing",
  async () => {
    const { root, slug } = fixture();
    try {
      const r = await runFlow(
        [
          "review-package",
          "--plan",
          `docs/${slug}/plan.md`,
          "--base",
          "abc1234",
          "--head",
          "def5678",
        ],
        { cwd: root },
      );
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("--confirm required when stdin is not a TTY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "flow append-advisory parity: valid appends normalize, invalid input exits 1 with core codes",
  async () => {
    const { root, slug, writeFlow } = fixture();
    const advisories = path.join(root, "docs", slug, "sdd", "advisories.md");
    try {
      writeFlow();
      // Valid append: tabs/repeated spaces collapse to one space.
      const ok = await runFlow(
        [
          "append-advisory",
          "--plan",
          `docs/${slug}/plan.md`,
          "--task",
          "3",
          "--text",
          "  minor\tstyle   nit  ",
          "--confirm",
        ],
        { cwd: root },
      );
      expect(ok.code, ok.stdout + ok.stderr).toBe(0);
      expect(ok.stderr).toBe("");
      expect(JSON.parse(ok.stdout)).toEqual({
        ok: true,
        advisories_path: `docs/${slug}/sdd/advisories.md`,
        advisory: "minor style nit",
      });
      expect(readFileSync(advisories, "utf8")).toBe("- Task 3: minor style nit\n");

      // Core validation codes surface with exit 1; failures write nothing.
      for (const [flag, value, code] of [
        ["--task", "0", "advisory_task_invalid"],
        ["--task", "-2", "advisory_task_invalid"],
        ["--task", "1.5", "advisory_task_invalid"],
        ["--task", "abc", "advisory_task_invalid"],
        ["--task", `${Number.MAX_SAFE_INTEGER + 1}`, "advisory_task_invalid"],
        // An empty --text value is a CLI usage error (exit 2), so the
        // empty-text advisory_text_invalid case lives in the core tests.
        ["--text", "line1\nline2", "advisory_text_invalid"],
        ["--text", "a".repeat(1001), "advisory_text_invalid"],
      ] as const) {
        const r = await runFlow(
          [
            "append-advisory",
            "--plan",
            `docs/${slug}/plan.md`,
            "--task",
            flag === "--task" ? value : "1",
            "--text",
            flag === "--text" ? value : "ok",
            "--confirm",
          ],
          { cwd: root },
        );
        expect(r.code, `${flag} ${JSON.stringify(value)} -> ${r.stdout}${r.stderr}`).toBe(1);
        expect(r.stdout).toBe("");
        expect(JSON.parse(r.stderr).code).toBe(code);
      }
      expect(readFileSync(advisories, "utf8")).toBe("- Task 3: minor style nit\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "flow append-advisory in non-TTY mode without --confirm exits 2 and writes nothing",
  async () => {
    const { root, slug } = fixture();
    try {
      const r = await runFlow(
        ["append-advisory", "--plan", `docs/${slug}/plan.md`, "--task", "1", "--text", "ok"],
        { cwd: root },
      );
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("--confirm required when stdin is not a TTY");
      expect(existsSync(path.join(root, "docs", slug, "sdd", "advisories.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "usage errors exit 2 with stderr diagnostics",
  async () => {
    const { root, slug } = fixture();
    try {
      const cases: { args: string[]; run: typeof runFlow | typeof runHandoff }[] = [
        { args: [], run: runFlow },
        { args: ["bogus", "--plan", `docs/${slug}/plan.md`], run: runFlow },
        { args: ["status"], run: runFlow },
        { args: ["status", "--plan"], run: runFlow },
        { args: ["status", "--plan", `docs/${slug}/plan.md`, "--confirm"], run: runFlow },
        { args: ["pause", "--plan", `docs/${slug}/plan.md`, "--bogus"], run: runFlow },
        {
          args: ["pause", "--plan", `docs/${slug}/plan.md`, "--plan", `docs/${slug}/plan.md`],
          run: runFlow,
        },
        {
          args: ["pause", "--plan", `docs/${slug}/plan.md`, "--confirm", "--confirm"],
          run: runFlow,
        },
        { args: ["pause", "--plan", "--confirm"], run: runFlow },
        { args: ["review-package", "--plan", `docs/${slug}/plan.md`], run: runFlow },
        {
          args: ["review-package", "--plan", `docs/${slug}/plan.md`, "--base", "abc1234"],
          run: runFlow,
        },
        {
          args: ["review-package", "--base", "abc1234", "--head", "abc1235", "--confirm"],
          run: runFlow,
        },
        {
          args: ["append-advisory", "--plan", `docs/${slug}/plan.md`, "--text", "ok", "--confirm"],
          run: runFlow,
        },
        {
          args: ["append-advisory", "--plan", `docs/${slug}/plan.md`, "--task", "1", "--confirm"],
          run: runFlow,
        },
        {
          args: [
            "append-advisory",
            "--plan",
            `docs/${slug}/plan.md`,
            "--task",
            "1",
            "--text",
            "ok",
            "--base",
            "abc1234",
            "--confirm",
          ],
          run: runFlow,
        },
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
  },
  { timeout: 60_000 },
);

// Tool-rename parity (workit-tool-rename Task 5): both hosts expose one common
// workit_* namespace and the documented host-only tools stay host-only —
// OpenCode has workit_commit/workit_handoff_session; Cursor has
// workit_handoff_prompt.
test(
  "host tool surfaces share the common workit_* namespace with documented host-only tools",
  () => {
    const opencode = assertOpencodeWorkitNamespace();

    const repoRoot = path.resolve(import.meta.dir, "..", "..");
    const server = readFileSync(
      path.join(repoRoot, "packages/workit-cursor/mcp/server.ts"),
      "utf8",
    );
    const registered = [...server.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    const lifecycle = [...server.matchAll(/lifecycleTool\(\s*\n?\s*"([a-z]+)"/g)].map(
      (m) => `workit_plan_${m[1]}`,
    );
    const cursor = [...registered, ...lifecycle].sort();
    expect(cursor.length).toBeGreaterThan(0);
    for (const name of cursor) {
      expect(name).toMatch(/^workit_[a-z0-9_]+$/);
    }
    expect(cursor).toContain("workit_handoff_prompt");
    expect(cursor).not.toContain("workit_commit");
    expect(cursor).not.toContain("workit_handoff_session");

    for (const shared of [
      "workit_verify",
      "workit_spec_approve",
      "workit_plan_approve",
      "workit_plan_complete",
      "workit_sdd_context",
    ]) {
      expect(opencode, shared).toContain(shared);
      expect(cursor, shared).toContain(shared);
    }
  },
  { timeout: 60_000 },
);

// --- Task 4: host parity — CLI execution-mode behavior is unchanged ---

test(
  "CLI flow commands are unchanged and carry no delegation surface",
  async () => {
    const { root, slug, writeFlow } = fixture();
    try {
      // The CLI execution-mode surface stays exactly: status/pause/resume/
      // complete/review-package/append-advisory + handoff. No workit_delegate,
      // no lease/token flags, no execution-menu command.
      writeFlow();
      const status = await runFlow(["status", "--plan", `docs/${slug}/plan.md`], { cwd: root });
      expect(status.code).toBe(0);
      expect(status.stderr).toBe("");
      const data = JSON.parse(status.stdout);
      expect(data.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
      expect(JSON.stringify(data)).not.toContain("delegation_token");
      expect(JSON.stringify(data)).not.toContain("coordinator_lease");

      const unknown = await runFlow(["delegate", "--plan", `docs/${slug}/plan.md`], { cwd: root });
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("usage: workit flow <");
      const tokenFlag = await runFlow(
        ["pause", "--plan", `docs/${slug}/plan.md`, "--confirm", "--delegation-token", "x"],
        { cwd: root },
      );
      expect(tokenFlag.code).toBe(2);
      expect(tokenFlag.stderr).toContain("unknown flag");

      const repoRoot = path.resolve(import.meta.dir, "..", "..");
      const flowSource = readFileSync(
        path.join(repoRoot, "packages/workit-cli/src/flow.ts"),
        "utf8",
      );
      expect(flowSource).not.toContain("workit_delegate");
      expect(flowSource).not.toContain("delegation_token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
