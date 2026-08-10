import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// C1: the packaged Cursor MCP server must initialize and list every registered
// tool over stdio, and representative handlers must run without a
// `workspace_root` fault (RR-04: undeclared `workspace_root` in init_apply).
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const REQUIRED_TOOLS = [
  "workflow_verify",
  "workflow_pr_context",
  "workflow_pr_create",
  "workflow_changelog_context",
  "workflow_changelog_apply",
  "workflow_release_notes_context",
  "workflow_docs_context",
  "workflow_git_context",
  "workflow_resolve_branch",
  "workflow_branch_setup",
  "workflow_sdd_context",
  "workflow_sdd_task_brief",
  "workflow_sdd_review_package",
  "workflow_sdd_append_progress",
  "workflow_docs_branch",
  "workflow_docs_validate",
  "workflow_plan_tasks",
  "workflow_handoff_prompt",
  "workflow_toolkit_init_status",
  "workflow_toolkit_status",
  "workflow_toolkit_init_apply",
  "workflow_youtrack_verify_token",
  "workflow_youtrack_parse_issue",
  "workflow_youtrack_context",
  "workflow_youtrack_parse_duration",
  "workflow_youtrack_log_time",
  "workflow_youtrack_draft",
  "workflow_youtrack_post",
  "workflow_present_ascii",
  "workflow_present_flow",
  "workflow_flow_status",
  "workflow_spec_approve",
  "workflow_plan_approve",
  "workflow_plan_menu",
  "workflow_docs_repo_link",
  "workflow_docs_list",
  "workflow_docs_promote",
  "workflow_template_list",
  "workflow_template_edit",
  "workflow_rule_list",
  "workflow_rule_edit",
];

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

test("cursor MCP server initializes and lists every registered handler over stdio", async () => {
  const { child, request } = startServer();
  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    expect((init as any).result.serverInfo.name).toBe("workit");

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    const names = ((listed as any).result.tools as { name: string }[]).map((t) => t.name);
    for (const tool of REQUIRED_TOOLS) {
      expect(names).toContain(tool);
    }
  } finally {
    child.kill();
  }
});

test("cursor MCP representative handlers run without workspace_root faults", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-ws-"));
  const { child, request } = startServer();
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const git = await request("tools/call", {
      name: "workflow_git_context",
      arguments: { workspace_root: tmp },
    });
    expect((git as any).result.isError).not.toBe(true);
    expect((git as any).result.content?.[0]?.text).toBeDefined();

    const initApply = await request("tools/call", {
      name: "workflow_toolkit_init_apply",
      arguments: { action: "gitignore", confirmed: false, workspace_root: tmp },
    });
    const text = (initApply as any).result.content?.[0]?.text ?? "";
    expect(text).toContain("confirmed");
    expect(text).not.toContain("workspace_root is not defined");

    const parseDuration = await request("tools/call", {
      name: "workflow_youtrack_parse_duration",
      arguments: { text: "1h 30m", workspace_root: tmp },
    });
    expect((parseDuration as any).result.isError).not.toBe(true);
  } finally {
    child.kill();
  }
});
