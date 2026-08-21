import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
} from "../shared/helpers/packages";

// C1: the packaged Cursor MCP server must initialize and list every registered
// tool over stdio, and representative handlers must run without a
// `workspace_root` fault (RR-04: undeclared `workspace_root` in init_apply).
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const REQUIRED_TOOLS = [
  "workit_verify",
  "workit_pr_context",
  "workit_pr_create",
  "workit_changelog_context",
  "workit_changelog_apply",
  "workit_release_notes_context",
  "workit_docs_context",
  "workit_git_context",
  "workit_resolve_branch",
  "workit_branch_setup",
  "workit_sdd_context",
  "workit_sdd_task_brief",
  "workit_sdd_review_package",
  "workit_sdd_append_progress",
  "workit_docs_branch",
  "workit_docs_validate",
  "workit_plan_tasks",
  "workit_handoff_prompt",
  "workit_init_status",
  "workit_status",
  "workit_init_apply",
  "workit_youtrack_verify_token",
  "workit_youtrack_parse_issue",
  "workit_youtrack_context",
  "workit_youtrack_parse_duration",
  "workit_youtrack_log_time",
  "workit_youtrack_draft",
  "workit_youtrack_post",
  "workit_present_ascii",
  "workit_present_flow",
  "workit_flow_status",
  "workit_spec_approve",
  "workit_plan_approve",
  "workit_plan_menu",
  "workit_plan_pause",
  "workit_plan_resume",
  "workit_plan_complete",
  "workit_docs_repo_link",
  "workit_docs_list",
  "workit_docs_promote",
  "workit_template_list",
  "workit_template_edit",
  "workit_rule_list",
  "workit_rule_edit",
];

function startServer(
  options: {
    cwd?: string;
    env?: Record<string, string>;
    entry?: string;
    args?: string[];
    bin?: string;
  } = {},
) {
  const child = spawn(
    options.bin ?? "bun",
    [options.entry ?? "packages/workit-cursor/mcp/server.ts", ...(options.args ?? [])],
    {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
    // No Cursor registration may expose a legacy `workflow_*` name.
    expect(names.filter((n) => n.startsWith("workflow_"))).toEqual([]);
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
      name: "workit_git_context",
      arguments: { workspace_root: tmp },
    });
    expect((git as any).result.isError).not.toBe(true);
    expect((git as any).result.content?.[0]?.text).toBeDefined();

    const initApply = await request("tools/call", {
      name: "workit_init_apply",
      arguments: { action: "gitignore", confirmed: false, workspace_root: tmp },
    });
    const text = (initApply as any).result.content?.[0]?.text ?? "";
    expect(text).toContain("confirmed");
    expect(text).not.toContain("workspace_root is not defined");

    const parseDuration = await request("tools/call", {
      name: "workit_youtrack_parse_duration",
      arguments: { text: "1h 30m", workspace_root: tmp },
    });
    expect((parseDuration as any).result.isError).not.toBe(true);

    // D6: omitting workspace_root exercises the schema `.default()` (process.cwd()
    // in the spawned server) instead of an explicit root — the handler must work.
    const gitDefault = await request("tools/call", {
      name: "workit_git_context",
      arguments: {},
    });
    expect((gitDefault as any).result.isError).not.toBe(true);
    expect((gitDefault as any).result.content?.[0]?.text).toBeDefined();
  } finally {
    child.kill();
  }
});

// AR-05: the launcher-provided workspace (mcp/run-server.ts <workspace>) is the
// default root for omitted workspace_root, never the launcher's own cwd.
test("run-server <workspace> from an unrelated cwd defaults omitted roots to the launcher workspace", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-launcher-ws-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-launcher-cwd-"));
  try {
    const { child, request } = startServer({
      cwd: elsewhere,
      env: isolatedEnv(elsewhere),
      entry: path.join(REPO_ROOT, "packages/workit-cursor/mcp/run-server.ts"),
      args: [ws],
    });
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
        name: "workit_git_context",
        arguments: {},
      });
      expect((git as any).result.isError).not.toBe(true);
      const text = (git as any).result.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.workspace_root).toBe(ws);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// AR-05: WORKFLOW_WORKSPACE_ROOT beats the spawned process cwd.
test("WORKFLOW_WORKSPACE_ROOT env beats the process cwd for omitted tool roots", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-env-ws-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "workit-mcp-env-cwd-"));
  try {
    const { child, request } = startServer({
      cwd: elsewhere,
      env: isolatedEnv(elsewhere, { WORKFLOW_WORKSPACE_ROOT: ws }),
      entry: path.join(REPO_ROOT, "packages/workit-cursor/mcp/server.ts"),
    });
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
        name: "workit_git_context",
        arguments: {},
      });
      expect((git as any).result.isError).not.toBe(true);
      const text = (git as any).result.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.workspace_root).toBe(ws);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// CA-16/CA-17: the committed launcher configs point at the published package via
// npx, and the npm bin those commands invoke resolves to a working MCP server.
test("marketplace npx command shape resolves to a working npm bin (local install)", async () => {
  const mcp = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/workit-cursor/mcp.json"), "utf8"),
  );
  expect(mcp.mcpServers.workit.command).toBe("npx");
  expect(mcp.mcpServers.workit.args).toEqual([
    "-y",
    "--prefer-online",
    "--package=@brainervirus/workit-cursor@latest",
    "workit-cursor-mcp",
    "${workspaceFolder}",
  ]);
  const hooks = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/workit-cursor/hooks/hooks-cursor.json"), "utf8"),
  );
  expect(hooks.hooks.sessionStart).toEqual([
    {
      command:
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
    },
  ]);

  // Prep-mode: the public `npx @latest` registry smoke is blocked until the
  // package is published, so prove the bin the npx command would exec
  // (package.json bin -> ./dist/mcp-server.js) is a working server from a local
  // pack install, driven under node over stdio.
  const packs = packWorkspacePackages();
  const cursor = packs.find((p) => p.packageName === "@brainervirus/workit-cursor")!;
  const nm = mkdtempSync(path.join(os.tmpdir(), "wk-mcp-bin-"));
  try {
    const pkg = installPackedPackage(nm, cursor);
    const pkgJson = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
    expect(pkgJson.bin["workit-cursor-mcp"]).toBe("./dist/mcp-server.js");

    const { child, request } = startServer({
      bin: "node",
      entry: path.join(pkg, "dist", "mcp-server.js"),
      env: isolatedEnv(nm),
    });
    try {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "npm-bin", version: "1.0" },
      });
      expect((init as any).result.serverInfo.name).toBe("workit");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const listed = await request("tools/list", {});
      const names = ((listed as any).result.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("workit_verify");
      expect(names).toContain("workit_pr_context");
      expect(names.filter((n: string) => n.startsWith("workflow_"))).toEqual([]);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(nm, { recursive: true, force: true });
  }
});
