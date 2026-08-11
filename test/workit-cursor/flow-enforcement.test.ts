import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorQuestionEvidence } from "../../packages/workit-cursor/mcp/flow-evidence";
import {
  CURSOR_SUBAGENT_UNSUPPORTED_TEXT,
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

test("the cursor adapter produces exactly the policy-only constant, never a fabricated attestation", () => {
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
  expect(assertEvidenceShape({ host: "cursor", attested: true, confirmation: "contract" }).ok).toBe(
    false,
  );
  expect(
    assertEvidenceShape({
      host: "cursor",
      attested: false,
      confirmation: "contract",
      questionId: "q",
    }).ok,
  ).toBe(false);
});

test("cursor evidence is accepted by the shared core transitions", () => {
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
});

test("host binding is strict and identical on both sides of the core", () => {
  const cursor = cursorEvidenceFor();
  const shaped = assertEvidenceShape(cursor);
  expect(shaped.ok).toBe(true);
  expect(assertHostEvidence("cursor", cursor).ok).toBe(true);
  expect(assertHostEvidence("opencode", cursor).ok).toBe(false);
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

const callText = (msg: any): { isError: boolean; text: any } => {
  const result = msg.result as any;
  return {
    isError: Boolean(result.isError),
    text: JSON.parse(result.content?.[0]?.text ?? "{}"),
  };
};

test("cursor MCP: no evidence argument exists — caller-supplied evidence is inert", async () => {
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

    // Caller-supplied forged evidence (even a fake host-observed answer) is
    // inert: no evidence argument exists on the Cursor MCP.
    const forged = await call("workflow_spec_approve", {
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
    expect(callText(forged).text.status).toBe("self_reviewed");

    // The stored evidence is the policy-only constant, never caller data.
    const status = await call("workflow_flow_status", {
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
});

test("cursor MCP: subagent-driven menu is rejected as unsupported with recovery guidance", async () => {
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
    await call("workflow_spec_approve", { spec_path: spec, workspace_root: root });
    await call("workflow_spec_approve", { spec_path: spec, workspace_root: root });
    await call("workflow_plan_approve", { plan_path: plan, workspace_root: root });
    await call("workflow_plan_approve", { plan_path: plan, workspace_root: root });

    const menu = await call("workflow_plan_menu", {
      choice: "subagent-driven",
      plan_path: plan,
      workspace_root: root,
    });
    expect(callText(menu).isError).toBe(true);
    expect(callText(menu).text.code).toBe("unsupported_mode");
    expect(JSON.stringify(callText(menu).text)).toContain(CURSOR_SUBAGENT_UNSUPPORTED_TEXT);

    // The menu was not recorded: the flow cannot enter subagent-driven on Cursor.
    const status = await call("workflow_flow_status", {
      plan_path: plan,
      workspace_root: root,
    });
    expect(callText(status).text.menu.presented).toBe(false);

    // A supported choice records the menu with the policy-only confirmation.
    const inline = await call("workflow_plan_menu", {
      choice: "inline",
      plan_path: plan,
      workspace_root: root,
    });
    expect(callText(inline).isError).toBe(false);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor MCP: no delegated role input exists — a client-supplied role is inert", async () => {
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
    await call("workflow_spec_approve", { spec_path: spec, workspace_root: root });
    await call("workflow_spec_approve", { spec_path: spec, workspace_root: root });
    await call("workflow_plan_approve", { plan_path: plan, workspace_root: root });
    await call("workflow_plan_approve", { plan_path: plan, workspace_root: root });
    await call("workflow_plan_menu", { choice: "inline", plan_path: plan, workspace_root: root });

    // A caller-supplied role/taskIdentity cannot self-certify delegation: every
    // Cursor mutation stays the deterministic coordinator session.
    const brief = await call("workflow_sdd_task_brief", {
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
});

test("cursor MCP enforces the same domain gates as opencode over stdio", async () => {
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

    const status = await call("workflow_flow_status", {
      plan_path: "docs/cf-flow/plan.md",
      workspace_root: root,
    });
    expect(callText(status).isError).toBe(false);
    expect(callText(status).text.spec.path).toBe("docs/cf-flow/spec.md");
    expect(callText(status).text.plan.path).toBe("docs/cf-flow/plan.md");

    // No evidence argument: approvals succeed with the policy-only constant.
    const approved = await call("workflow_spec_approve", {
      spec_path: "docs/cf-flow/spec.md",
      workspace_root: root,
    });
    expect(callText(approved).isError).toBe(false);
    expect(callText(approved).text.status).toBe("self_reviewed");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
