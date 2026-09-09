import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  codexContextProvider,
  codexQualification,
  resolveCodexWorkspaceRoot,
} from "../../packages/workit-codex/scripts/launch-mcp";
import { handleCodexHook } from "../../packages/workit-codex/hooks/workit-hook";
import { TaskStore, WorkitCore, type OperationContext } from "../../packages/workit-core/src/core";
import { taskStartRequest } from "../workit-core/task-fixtures";

const packageRoot = path.resolve(import.meta.dir, "../../packages/workit-codex");
const repoRoot = path.resolve(import.meta.dir, "../..");

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

test("desktop qualification stays separate from CLI qualification", () => {
  expect(codexQualification("codex_cli")).toEqual({ surface: "codex_cli", cli: "0.153.4" });
  expect(codexQualification("codex_desktop")).toEqual({
    surface: "codex_desktop",
    desktopPackage: "26.901.20858",
    bundledCodexCli: "0.153.0-alpha.5",
  });
});

test("desktop hook emits native SessionStart JSON with developer context", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-codex-desktop-"));
  const result = handleCodexHook({
    hook_event_name: "SessionStart",
    session_id: "desktop-session",
    cwd: root,
    model: "gpt-5",
    permission_mode: "default",
    transcript_path: null,
    source: "resume",
  });
  expect(result).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: expect.stringContaining("<workit-contract>"),
    },
  });
});

test("Codex MCP provider keeps caller identity empty on both surfaces", async () => {
  for (const host of ["codex_cli", "codex_desktop"] as const) {
    const provider = codexContextProvider(host, initializedRoot());
    const context = await provider.current();
    expect(context.caller).toEqual({ host, actor: "" });
    expect(context.callerAttested).toBe(false);
  }
  const pluginRoot = path.resolve(import.meta.dir, "../../packages/workit-codex");
  expect(resolveCodexWorkspaceRoot(pluginRoot, { PWD: pluginRoot })).toBeNull();
  const validRoot = initializedRoot();
  expect(resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: validRoot })).toBe(
    validRoot,
  );
  const freshRoot = mkdtempSync(path.join(tmpdir(), "workit-codex-no-state-"));
  expect(await codexContextProvider("codex_cli", freshRoot).current()).toMatchObject({
    root: freshRoot,
  });
  expect(
    resolveCodexWorkspaceRoot(pluginRoot, {
      PWD: mkdtempSync(path.join(tmpdir(), "workit-codex-workspace-")),
    }),
  ).toContain("workit-codex-workspace-");
  const mismatchedRoot = initializedRoot();
  const workspacePath = path.join(mismatchedRoot, ".workit", "workspace.json");
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
  workspace.root = path.join(mismatchedRoot, "different-root");
  writeFileSync(workspacePath, `${JSON.stringify(workspace)}\n`);
  expect(
    resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: mismatchedRoot }),
  ).toBeNull();
});

const packCodex = () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), "workit-codex-package-"));
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--workspace", packageRoot, "--pack-destination", packRoot],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error(`npm pack returned no filename: ${packed.stdout}`);
  const extractRoot = path.join(packRoot, "extract");
  mkdirSync(extractRoot);
  const extracted = spawnSync("tar", ["-xzf", path.join(packRoot, filename), "-C", extractRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (extracted.status !== 0) throw new Error(extracted.stderr || extracted.stdout);
  return {
    root: path.join(extractRoot, "package"),
    cleanup: () => rmSync(packRoot, { recursive: true, force: true }),
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
        5000,
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

test("packed Codex launcher uses the shipped node command and lists eight families once", async () => {
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
      "workit_evidence",
      "workit_finding",
      "workit_decision",
      "workit_worker",
      "workit_writer",
      "workit_state",
    ]);
    expect(Object.keys(launcher.responses)).toEqual(["1", "2"]);
    expect(launcher.getStderr()).toBe("");
  } finally {
    launcher.child.kill();
    launcher.packed.cleanup();
  }
});

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
