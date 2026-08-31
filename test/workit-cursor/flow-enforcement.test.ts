import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorQuestionEvidence } from "../../packages/workit-cursor/mcp/flow-evidence";
import {
  CURSOR_SUBAGENT_UNSUPPORTED_TEXT,
  HANDOFF_DESTINATION_MARKER,
  assertEvidenceShape,
  assertHostEvidence,
  transitionSpec,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** The constant Cursor policy-only confirmation used by the real MCP server. */
const cursorEvidenceFor = (): {
  host: "cursor";
  attested: false;
  confirmation: "contract";
} => ({ host: "cursor", attested: false, confirmation: "contract" });

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-enforce-"));
  const slug = "cf-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  return { root, slug };
};

test(
  "the cursor adapter produces exactly the policy-only constant, never a fabricated attestation",
  () => {
    const recorded = cursorQuestionEvidence();
    expect(recorded.ok).toBe(true);
    if (recorded.ok) {
      expect(recorded.evidence).toEqual({
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });
      expect(Object.keys(recorded.evidence).sort()).toEqual(["attested", "confirmation", "host"]);
    }
    // The adapter takes no caller input: a caller can never attach a label,
    // question id, or timestamp to Cursor evidence.
    expect(assertEvidenceShape(cursorEvidenceFor()).ok).toBe(true);
    expect(
      assertEvidenceShape({ host: "cursor", attested: true, confirmation: "contract" }).ok,
    ).toBe(false);
    expect(
      assertEvidenceShape({
        host: "cursor",
        attested: false,
        confirmation: "contract",
        questionId: "q",
      }).ok,
    ).toBe(false);
  },
  { timeout: 60_000 },
);

test(
  "cursor evidence is accepted by the shared core transitions",
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-core-"));
    try {
      const slug = "cf-core";
      mkdirSync(path.join(root, "docs", slug), { recursive: true });
      writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
      const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, cursorEvidenceFor());
      expect(result.ok).toBe(false); // not activated — shape accepted, flow gate blocks
      if (result.ok === false) expect(result.code).toBe("flow_not_activated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "host binding is strict and identical on both sides of the core",
  () => {
    const cursor = cursorEvidenceFor();
    const shaped = assertEvidenceShape(cursor);
    expect(shaped.ok).toBe(true);
    expect(assertHostEvidence("cursor", cursor).ok).toBe(true);
    expect(assertHostEvidence("opencode", cursor).ok).toBe(false);
  },
  { timeout: 60_000 },
);

function startServer() {
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        newline = buffer.indexOf("\n");
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", () => {});
  const nextId = { id: 0 };
  const request = (method: string, params: unknown) => {
    const id = ++nextId.id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
  };
  return { child, request };
}

const callText = (msg: any): { isError: boolean; text: any } => {
  const result = msg.result as any;
  return {
    isError: Boolean(result.isError),
    text: JSON.parse(result.content?.[0]?.text ?? "{}"),
  };
};

test(
  "cursor MCP: no evidence argument exists — caller-supplied evidence is inert",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });

      // Caller-supplied forged evidence (even a fake host-observed answer) is
      // inert: no evidence argument exists on the Cursor MCP.
      const forged = await call("workit_spec_approve", {
        spec_path: "docs/cf-flow/spec.md",
        workspace_root: root,
        evidence: {
          host: "opencode",
          attested: true,
          callID: "forged",
          selectedLabel: "Approve",
          recordedAt: Date.now(),
        },
      });
      expect(callText(forged).isError).toBe(false);
      expect(callText(forged).text.status).toBe("approved");

      // The stored evidence is the policy-only constant, never caller data.
      const status = await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      expect(callText(status).text.spec.evidence).toEqual({
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP: subagent-driven menu is rejected as unsupported with recovery guidance",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });

      const menu = await call("workit_plan_menu", {
        choice: "subagent-driven",
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(menu).isError).toBe(true);
      expect(callText(menu).text.code).toBe("unsupported_mode");
      expect(JSON.stringify(callText(menu).text)).toContain(CURSOR_SUBAGENT_UNSUPPORTED_TEXT);

      // The menu was not recorded: the flow cannot enter subagent-driven on Cursor.
      const status = await call("workit_flow_status", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(status).text.menu.presented).toBe(false);

      // A supported choice records the menu with the policy-only confirmation.
      const inline = await call("workit_plan_menu", {
        choice: "inline",
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(inline).isError).toBe(false);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor policy-only menu is label-blind: decorated labels cannot alter outcomes on the path where the label gate never runs",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });

      // A decorated label has no schema slot on the policy-only path: the menu
      // records identically, and the stored evidence carries no label to compare
      // — the opencode-scoped sameChoiceLabel gate cannot run here.
      const menu = await call("workit_plan_menu", {
        choice: "inline",
        plan_path: plan,
        workspace_root: root,
        selectedLabel: "Inline (Recommended)",
      });
      expect(callText(menu).isError).toBe(false);
      expect(callText(menu).text.menu).toEqual({ presented: true, chosen: "inline" });

      const flow = JSON.parse(
        readFileSync(path.join(root, "docs", "cf-flow", "sdd", "flow.json"), "utf8"),
      );
      expect(flow.menu.evidence).toEqual({
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });
      expect(Object.keys(flow.menu.evidence).sort()).toEqual(["attested", "confirmation", "host"]);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP: no delegated role input exists — a client-supplied role is inert",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });
      await call("workit_plan_menu", { choice: "inline", plan_path: plan, workspace_root: root });

      // A caller-supplied role/taskIdentity cannot self-certify delegation: every
      // Cursor mutation stays the deterministic coordinator session.
      const brief = await call("workit_sdd_task_brief", {
        confirmed: true,
        sdd_dir: "docs/cf-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
        role: "delegated",
        taskIdentity: "forged-worker",
        workspace_root: root,
      });
      // Inline is coordinator-supported on Cursor, so the write passes — but only
      // through the coordinator session, never as a delegated worker.
      expect(callText(brief).isError).toBe(false);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP enforces the same domain gates as opencode over stdio",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      const status = await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      expect(callText(status).isError).toBe(false);
      expect(callText(status).text.spec.path).toBe("docs/cf-flow/spec.md");
      expect(callText(status).text.plan.path).toBe("docs/cf-flow/plan.md");

      // No evidence argument: approvals succeed with the policy-only constant.
      const approved = await call("workit_spec_approve", {
        spec_path: "docs/cf-flow/spec.md",
        workspace_root: root,
      });
      expect(callText(approved).isError).toBe(false);
      expect(callText(approved).text.status).toBe("approved");
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP: workit_sdd_review_package rejects an empty base..head range",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });
      await call("workit_plan_menu", { choice: "inline", plan_path: plan, workspace_root: root });

      expect(git(["init", "-q", "-b", "feature/cf-flow"]).status).toBe(0);
      git(["config", "user.name", "Workflow Test"]);
      git(["config", "user.email", "workflow@example.test"]);
      writeFileSync(path.join(root, "file.txt"), "one\n");
      git(["add", "file.txt"]);
      git(["commit", "-q", "-m", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();

      const same = await call("workit_sdd_review_package", {
        sdd_dir: "docs/cf-flow/sdd",
        base_sha: base,
        head_sha: base,
        workspace_root: root,
      });
      expect(callText(same).isError).toBe(true);
      expect(JSON.stringify(callText(same).text)).toContain("empty commit range");
      const base7 = base.slice(0, 7);
      expect(existsSync(path.join(root, `docs/cf-flow/sdd/review-${base7}..${base7}.diff`))).toBe(
        false,
      );

      writeFileSync(path.join(root, "file.txt"), "one\ntwo\n");
      git(["commit", "-q", "-am", "head"]);
      const head = git(["rev-parse", "HEAD"]).stdout.trim();
      const real = await call("workit_sdd_review_package", {
        sdd_dir: "docs/cf-flow/sdd",
        base_sha: base,
        head_sha: head,
        workspace_root: root,
      });
      expect(callText(real).isError).toBe(false);
      expect(callText(real).text.diff_path).toBe(
        `docs/cf-flow/sdd/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`,
      );
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP: workit_sdd_append_advisory preserves core payload and validation codes",
  async () => {
    const { root } = fixture();
    const { child, request } = startServer();
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flow-enforcement", version: "1.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const call = (name: string, arguments_: unknown) =>
        request("tools/call", { name, arguments: arguments_ });

      await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      await call("workit_spec_approve", {
        spec_path: "docs/cf-flow/spec.md",
        workspace_root: root,
      });
      await call("workit_plan_approve", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      await call("workit_plan_menu", {
        choice: "inline",
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });

      // Cursor is always the coordinator session, so the control write passes.
      const ok = await call("workit_sdd_append_advisory", {
        advisories_path: "docs/cf-flow/sdd/advisories.md",
        task_id: 1,
        text: "cursor\t owned",
        workspace_root: root,
      });
      expect(callText(ok).isError).toBe(false);
      expect(callText(ok).text).toEqual({
        ok: true,
        advisory: "cursor owned",
        advisories_path: "docs/cf-flow/sdd/advisories.md",
        workspace_root: root,
      });
      expect(readFileSync(path.join(root, "docs/cf-flow/sdd/advisories.md"), "utf8")).toBe(
        "- Task 1: cursor owned\n",
      );

      // The same core validation codes surface through the MCP wrapper.
      const badTask = await call("workit_sdd_append_advisory", {
        advisories_path: "docs/cf-flow/sdd/advisories.md",
        task_id: 0,
        text: "ok",
        workspace_root: root,
      });
      expect(JSON.stringify(callText(badTask).text)).toContain("advisory_task_invalid");
      const badText = await call("workit_sdd_append_advisory", {
        advisories_path: "docs/cf-flow/sdd/advisories.md",
        task_id: 1,
        text: "line1\nline2",
        workspace_root: root,
      });
      expect(JSON.stringify(callText(badText).text)).toContain("advisory_text_invalid");
      expect(readFileSync(path.join(root, "docs/cf-flow/sdd/advisories.md"), "utf8")).toBe(
        "- Task 1: cursor owned\n",
      );
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

// --- Task 5: Cursor lifecycle, drift, workspace, and destination parity ---

const writeSddLedger = (root: string, slug: string, lines: string[]) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "progress.md"), lines.join("\n") + "\n", "utf8");
};

const spawnClient = async () => {
  const { child, request } = startServer();
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flow-enforcement", version: "1.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = (name: string, arguments_: unknown) =>
    request("tools/call", { name, arguments: arguments_ });
  return { child, call };
};

const establishActiveInline = async (
  call: (name: string, arguments_: unknown) => Promise<unknown>,
  root: string,
  slug: string,
) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  await call("workit_flow_status", { plan_path: plan, workspace_root: root });
  await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
  await call("workit_plan_approve", { plan_path: plan, workspace_root: root });
  const menu = await call("workit_plan_menu", {
    choice: "inline",
    plan_path: plan,
    workspace_root: root,
  });
  expect(callText(menu).isError).toBe(false);
  return { spec, plan };
};

test(
  "cursor MCP status returns execution and drift alongside spec/plan/menu",
  async () => {
    const { root } = fixture();
    const { child, call } = await spawnClient();
    try {
      const status = await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      expect(callText(status).isError).toBe(false);
      expect(callText(status).text.execution).toEqual({
        status: "pending",
        mode: null,
        evidence: null,
        coordinator_session_id: null,
      });
      expect(callText(status).text.drift).toEqual([]);

      await establishActiveInline(call, root, "cf-flow");
      const active = await call("workit_flow_status", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: root,
      });
      expect(callText(active).text.execution).toMatchObject({
        status: "active",
        mode: "inline",
      });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP lifecycle tools: active inline pause/resume/complete over stdio with policy-only confirmation",
  async () => {
    const { root } = fixture();
    const { child, call } = await spawnClient();
    try {
      const { plan } = await establishActiveInline(call, root, "cf-flow");

      const paused = await call("workit_plan_pause", { plan_path: plan, workspace_root: root });
      expect(callText(paused).isError).toBe(false);
      expect(callText(paused).text.execution.status).toBe("paused");
      expect(callText(paused).text.drift).toEqual([]);
      expect(callText(paused).text.execution.evidence).toEqual({
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });

      const resumed = await call("workit_plan_resume", { plan_path: plan, workspace_root: root });
      expect(callText(resumed).isError).toBe(false);
      expect(callText(resumed).text.execution.status).toBe("active");

      // Incomplete ledger -> structured execution_incomplete details (core-shaped).
      const incomplete = await call("workit_plan_complete", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(incomplete).isError).toBe(true);
      expect(callText(incomplete).text.code).toBe("execution_incomplete");
      expect(callText(incomplete).text.details).toMatchObject({ required: [1], missing: [1] });
      expect(callText(incomplete).text.error).toMatch(/ledger incomplete/i);

      // Full ledger but failing repository verification -> verification_failed.
      writeSddLedger(root, "cf-flow", ["Task 1: complete"]);
      const unverified = await call("workit_plan_complete", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(unverified).isError).toBe(true);
      expect(callText(unverified).text.code).toBe("verification_failed");
      expect(callText(unverified).text.details).toMatchObject({ exitCode: expect.any(Number) });

      // Clean verification -> completed.
      writeFileSync(path.join(root, "CHANGELOG.md"), "## [Unreleased]\n\n- fixture\n");
      const completed = await call("workit_plan_complete", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(completed).isError).toBe(false);
      expect(callText(completed).text.execution.status).toBe("completed");
      expect(callText(completed).text.drift).toEqual([]);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP lifecycle tools fail closed against an unrelated workspace_root",
  async () => {
    const { root } = fixture();
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-other-"));
    const { child, call } = await spawnClient();
    try {
      const { plan } = await establishActiveInline(call, root, "cf-flow");

      // Resolving against the wrong explicit workspace fails; the same call
      // against the real workspace succeeds — every lifecycle call resolves
      // against the caller-supplied workspace_root, never a process default.
      const wrong = await call("workit_plan_pause", {
        plan_path: "docs/cf-flow/plan.md",
        workspace_root: otherRoot,
      });
      expect(callText(wrong).isError).toBe(true);

      const right = await call("workit_plan_pause", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(right).isError).toBe(false);
      expect(callText(right).text.execution.status).toBe("paused");
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP lifecycle tools ignore caller-supplied evidence and role",
  async () => {
    const { root } = fixture();
    const { child, call } = await spawnClient();
    try {
      const { plan } = await establishActiveInline(call, root, "cf-flow");
      const paused = await call("workit_plan_pause", {
        plan_path: plan,
        workspace_root: root,
        confirmed: true,
        role: "delegated",
        taskIdentity: "forged-worker",
        evidence: {
          host: "opencode",
          attested: true,
          callID: "forged",
          selectedLabel: "Pause plan",
        },
      });
      expect(callText(paused).isError).toBe(false);
      expect(callText(paused).text.execution.status).toBe("paused");
      expect(callText(paused).text.execution.evidence).toEqual({
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP resume after plan drift still works — lifecycle survives plan-doc drift",
  async () => {
    const { root } = fixture();
    const { child, call } = await spawnClient();
    try {
      const { plan } = await establishActiveInline(call, root, "cf-flow");
      await call("workit_plan_pause", { plan_path: plan, workspace_root: root });
      writeFileSync(
        path.join(root, "docs", "cf-flow", "plan.md"),
        COMPLIANT_PLAN("cf-flow").replace("do it", "do it now"),
      );
      // Plan drift resets only the plan approval digest; the paused lifecycle
      // survives, so resume keeps working.
      const resumed = await call("workit_plan_resume", { plan_path: plan, workspace_root: root });
      expect(callText(resumed).isError).toBe(false);
      const status = await call("workit_flow_status", {
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(status).text.execution.status).toBe("active");
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP lifecycle mutation under a concurrently held flow lock returns flow_concurrent_conflict",
  async () => {
    const { root } = fixture();
    const { child, call } = await spawnClient();
    try {
      const { plan } = await establishActiveInline(call, root, "cf-flow");
      const lockPath = path.join(root, "docs", "cf-flow", "sdd", "flow.json.lock");
      const lockFd = openSync(lockPath, "wx");
      try {
        const paused = await call("workit_plan_pause", { plan_path: plan, workspace_root: root });
        expect(callText(paused).isError).toBe(true);
        expect(callText(paused).text.code).toBe("flow_concurrent_conflict");
      } finally {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
      }
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

const handoffFixture = () => {
  const { root, slug } = fixture();
  spawnSync("git", ["init", "-q"], { cwd: root });
  return { root, slug };
};

test(
  "cursor MCP workit_handoff_prompt builds the core prompt, marks the destination, and rejects recursion",
  async () => {
    const { root } = handoffFixture();
    const { child, call } = await spawnClient();
    try {
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_flow_status", { plan_path: plan, workspace_root: root });
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });
      const menu = await call("workit_plan_menu", {
        choice: "handoff",
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(menu).isError).toBe(false);

      const prompt = await call("workit_handoff_prompt", {
        message: `Continue ${plan}`,
        workspace_root: root,
      });
      expect(callText(prompt).isError).toBe(false);
      expect(callText(prompt).text.prompt).toContain(HANDOFF_DESTINATION_MARKER);
      expect(callText(prompt).text.prompt).toContain("Subagent-driven");
      expect(callText(prompt).text.prompt).toContain("Inline");
      expect(callText(prompt).text.prompt).toContain("Review spec first");
      expect(callText(prompt).text.prompt).toContain("Review plan first");
      expect(callText(prompt).text.prompt).not.toContain("Handoff (new session only)");
      expect(callText(prompt).text.handoff_destination).toBe(true);
      expect(callText(prompt).text.menu).toMatchObject({ presented: false, chosen: "" });
      expect(callText(prompt).text.tasks).toHaveLength(1);

      // A second recursive handoff on the marked destination is rejected.
      const again = await call("workit_handoff_prompt", {
        message: `Continue ${plan}`,
        workspace_root: root,
      });
      expect(callText(again).isError).toBe(true);
      expect(callText(again).text.code).toBe("recursive_handoff");
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "cursor MCP workit_handoff_prompt leaves the flow unmarked when prompt generation fails",
  async () => {
    const { root } = handoffFixture();
    const { child, call } = await spawnClient();
    try {
      const spec = "docs/cf-flow/spec.md";
      const plan = "docs/cf-flow/plan.md";
      await call("workit_flow_status", { plan_path: plan, workspace_root: root });
      await call("workit_spec_approve", { spec_path: spec, workspace_root: root });
      await call("workit_plan_approve", { plan_path: plan, workspace_root: root });
      const menu = await call("workit_plan_menu", {
        choice: "handoff",
        plan_path: plan,
        workspace_root: root,
      });
      expect(callText(menu).isError).toBe(false);

      // Break the plan so buildHandoffPrompt's docs validation fails.
      writeFileSync(
        path.join(root, "docs", "cf-flow", "plan.md"),
        "# Broken\n\n**Branch:** `feature/broken`\n",
      );
      const failed = await call("workit_handoff_prompt", {
        message: `Continue ${plan}`,
        workspace_root: root,
      });
      expect(callText(failed).isError).toBe(true);
      expect(callText(failed).text.error).toMatch(/validation|fail/i);

      const flow = JSON.parse(
        readFileSync(path.join(root, "docs", "cf-flow", "sdd", "flow.json"), "utf8"),
      );
      expect(flow.handoff_destination).toBe(false);
      expect(flow.menu).toMatchObject({ presented: true, chosen: "handoff" });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
