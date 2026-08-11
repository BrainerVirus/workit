import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorQuestionEvidence } from "../../packages/workit-cursor/mcp/flow-evidence";
import {
  COORDINATOR_RECOVERY_TEXT,
  assertHostEvidence,
  transitionSpec,
  createFlowEvidence,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-enforce-"));
  const slug = "cf-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  return { root, slug };
};

test("the cursor native-question adapter produces host-bound evidence", () => {
  const recorded = cursorQuestionEvidence("q-spec-approve", "Approve spec");
  expect(recorded.ok).toBe(true);
  if (recorded.ok) {
    expect(recorded.evidence).toMatchObject({
      host: "cursor",
      questionId: "q-spec-approve",
      selectedLabel: "Approve spec",
    });
    expect(typeof recorded.evidence.recordedAt).toBe("number");
  }
  const forged = cursorQuestionEvidence("q", "");
  expect(forged.ok).toBe(false);
});

test("cursor evidence is accepted by the shared core transitions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-core-"));
  try {
    const slug = "cf-core";
    mkdirSync(path.join(root, "docs", slug), { recursive: true });
    writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
    const ev = cursorQuestionEvidence("q-approve", "Approve");
    expect(ev.ok).toBe(true);
    if (!ev.ok) throw new Error(ev.error);
    expect(transitionSpec(root, slug, `docs/${slug}/spec.md`, ev.evidence).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host binding is strict and identical on both sides of the core", () => {
  const cursor = createFlowEvidence("cursor", "q", "Approve");
  const opencode = createFlowEvidence("opencode", "q", "Approve");
  if (!cursor.ok || !opencode.ok) throw new Error("evidence creation failed");
  expect(assertHostEvidence("cursor", cursor.evidence).ok).toBe(true);
  expect(assertHostEvidence("cursor", opencode.evidence).ok).toBe(false);
  expect(assertHostEvidence("opencode", cursor.evidence).ok).toBe(false);
  expect(assertHostEvidence("opencode", opencode.evidence).ok).toBe(true);
});

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

const cursorEvidenceFor = (label: string) => {
  const ev = cursorQuestionEvidence(`q-${label}`, label);
  if (!ev.ok) throw new Error(ev.error);
  return ev.evidence;
};

test("cursor MCP threads MutationContext: coordinator product edits blocked after subagent-driven", async () => {
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

    await call("workflow_flow_status", {
      plan_path: "docs/cf-flow/plan.md",
      workspace_root: root,
    });
    const spec = "docs/cf-flow/spec.md";
    const plan = "docs/cf-flow/plan.md";
    await call("workflow_spec_approve", {
      spec_path: spec,
      workspace_root: root,
      evidence: cursorEvidenceFor("Approve"),
    });
    await call("workflow_spec_approve", {
      spec_path: spec,
      workspace_root: root,
      evidence: cursorEvidenceFor("Approve"),
    });
    await call("workflow_plan_approve", {
      plan_path: plan,
      workspace_root: root,
      evidence: cursorEvidenceFor("Approve plan"),
    });
    await call("workflow_plan_approve", {
      plan_path: plan,
      workspace_root: root,
      evidence: cursorEvidenceFor("Approve plan"),
    });
    const menu = await call("workflow_plan_menu", {
      choice: "subagent-driven",
      plan_path: plan,
      workspace_root: root,
      evidence: cursorEvidenceFor("subagent-driven"),
    });
    expect((menu as any).result.isError).not.toBe(true);

    const blocked = await call("workflow_sdd_append_progress", {
      confirmed: true,
      progress_path: "docs/cf-flow/sdd/progress.md",
      line: "Task 1: work (commits abcdef0..1234567, tests pass)",
      workspace_root: root,
    });
    expect((blocked as any).result.isError).toBe(true);
    const blockedText = JSON.parse((blocked as any).result.content?.[0]?.text ?? "{}");
    expect(blockedText.code).toBe("coordinator_blocked");
    expect(JSON.stringify(blockedText)).toContain(COORDINATOR_RECOVERY_TEXT);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor MCP enforces the same evidence gates as opencode over stdio", async () => {
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

    // Flow status prepares activation and canonical paths (FG-01).
    const status = await call("workflow_flow_status", {
      plan_path: "docs/cf-flow/plan.md",
      workspace_root: root,
    });
    expect((status as any).result.isError).not.toBe(true);
    const statusText = JSON.parse((status as any).result.content?.[0]?.text ?? "{}");
    expect(statusText.spec.path).toBe("docs/cf-flow/spec.md");
    expect(statusText.plan.path).toBe("docs/cf-flow/plan.md");

    // A bare confirmed boolean is rejected (CA-19, FG-04).
    const bare = await call("workflow_spec_approve", {
      confirmed: true,
      spec_path: "docs/cf-flow/spec.md",
      workspace_root: root,
    });
    expect((bare as any).result.isError).toBe(true);

    // Evidence recorded on another host is rejected as forged.
    const forged = await call("workflow_spec_approve", {
      spec_path: "docs/cf-flow/spec.md",
      workspace_root: root,
      evidence: {
        host: "opencode",
        questionId: "q-forged",
        selectedLabel: "Approve",
        recordedAt: Date.now(),
      },
    });
    expect((forged as any).result.isError).toBe(true);
    const forgedText = JSON.parse((forged as any).result.content?.[0]?.text ?? "{}");
    expect(JSON.stringify(forgedText)).toMatch(/host|forged|opencode/i);

    // Exact cursor question evidence advances the flow.
    const approved = await call("workflow_spec_approve", {
      spec_path: "docs/cf-flow/spec.md",
      workspace_root: root,
      evidence: cursorEvidenceFor("Approve"),
    });
    expect((approved as any).result.isError).not.toBe(true);
    const approvedText = JSON.parse((approved as any).result.content?.[0]?.text ?? "{}");
    expect(approvedText.status).toBe("self_reviewed");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
