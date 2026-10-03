import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { extractTarball, packWorkspacePackages } from "@/test/shared/helpers/packages";

// Packaging tier: starts the MCP launcher shipped in the packed Codex tarball.
const CODEX = "@brainervirus/workit-codex";

const initializedRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-codex-packed-"));
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host: "codex_cli", actor: "launcher-test" },
    callerAttested: false,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const started = new WorkitCore(store, context).task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  return root;
};

// Packs from a fresh sandbox build of the current source (shared, cached
// helper), so the launcher under test never comes from a stale local dist/.
const packCodex = () => {
  const pack = packWorkspacePackages().find((entry) => entry.packageName === CODEX);
  if (!pack) throw new Error(`${CODEX} missing from the workspace pack`);
  const extracted = extractTarball(pack.tarball);
  return {
    root: extracted.packageDir,
    cleanup: () => rmSync(extracted.root, { recursive: true, force: true }),
  };
};

const startPackedMcp = (workspaceRoot: string) => {
  const packed = packCodex();
  const config = JSON.parse(readFileSync(path.join(packed.root, ".mcp.json"), "utf8"));
  const server = config.mcpServers.workit;
  if (server.command !== "node") throw new Error(`unexpected MCP command: ${server.command}`);
  const child = spawn(server.command, server.args, {
    cwd: path.resolve(packed.root, server.cwd),
    env: {
      ...process.env,
      WORKFLOW_WORKSPACE_ROOT: workspaceRoot,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
      CODEX_ELECTRON_RESOURCES_PATH: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const responses: Record<number, any> = {};
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf("\n");
      if (end < 0) break;
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") responses[message.id] = message;
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const request = (id: number, method: string, params: unknown) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout ${method}; stderr=${stderr}`)),
        15_000,
      );
      const check = () => {
        if (responses[id]) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(check, 10);
      };
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      check();
    });
  return { child, packed, responses, request, getStderr: () => stderr };
};

test("packed Codex launcher uses the shipped node command and lists read-only families once", async () => {
  const launcher = startPackedMcp(initializedRoot());
  try {
    await launcher.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-packed-test", version: "1.0.0" },
    });
    launcher.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await launcher.request(2, "tools/list", {});
    expect(launcher.responses[1].result.serverInfo.name).toBe("workit");
    expect(launcher.responses[2].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "workit_task",
      "workit_policy",
      "workit_state",
    ]);
    expect(Object.keys(launcher.responses)).toEqual(["1", "2"]);
    expect(launcher.getStderr()).toBe("");
  } finally {
    launcher.child.kill();
    launcher.packed.cleanup();
  }
}, 30_000);

test("packed Codex launcher lists empty on fresh checkouts without leaking paths", async () => {
  const freshRoot = mkdtempSync(path.join(tmpdir(), "workit-codex-fresh-"));
  const launcher = startPackedMcp(freshRoot);
  try {
    await launcher.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-packed-unavailable-test", version: "1.0.0" },
    });
    launcher.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await launcher.request(2, "tools/call", {
      name: "workit_task",
      arguments: { schemaVersion: 1, action: "list" },
    });
    expect(launcher.responses[2].result.structuredContent).toEqual({
      ok: true,
      schemaVersion: 1,
      revision: null,
      workspaceRevision: null,
      data: [],
    });
    expect(JSON.stringify(launcher.responses[2])).not.toContain(freshRoot);
    expect(launcher.getStderr()).not.toContain(freshRoot);
  } finally {
    launcher.child.kill();
    launcher.packed.cleanup();
    rmSync(freshRoot, { recursive: true, force: true });
  }
});
