import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
  await expect(
    codexContextProvider(
      "codex_cli",
      mkdtempSync(path.join(tmpdir(), "workit-codex-no-state-")),
    ).current(),
  ).rejects.toThrow("workspace root is unavailable");
  expect(
    resolveCodexWorkspaceRoot(pluginRoot, {
      PWD: mkdtempSync(path.join(tmpdir(), "workit-codex-workspace-")),
    }),
  ).toBeNull();
  const mismatchedRoot = initializedRoot();
  const workspacePath = path.join(mismatchedRoot, ".workit", "workspace.json");
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
  workspace.root = path.join(mismatchedRoot, "different-root");
  writeFileSync(workspacePath, `${JSON.stringify(workspace)}\n`);
  expect(
    resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: mismatchedRoot }),
  ).toBeNull();
});

test("packed Codex launcher initializes once and lists the shared eight families", async () => {
  const root = initializedRoot();
  const config = JSON.parse(readFileSync(path.join(packageRoot, ".mcp.json"), "utf8"));
  const server = config.mcpServers.workit;
  const child = spawn(
    process.execPath,
    server.args.map((arg: string) => path.resolve(packageRoot, arg)),
    {
      cwd: path.resolve(packageRoot, server.cwd),
      env: {
        ...process.env,
        WORKFLOW_WORKSPACE_ROOT: root,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
        CODEX_ELECTRON_RESOURCES_PATH: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
  try {
    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-packed-test", version: "1.0.0" },
    });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await request(2, "tools/list", {});
    expect(responses[1].result.serverInfo.name).toBe("workit");
    expect(responses[2].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "workit_task",
      "workit_policy",
      "workit_evidence",
      "workit_finding",
      "workit_decision",
      "workit_worker",
      "workit_writer",
      "workit_state",
    ]);
    expect(Object.keys(responses)).toEqual(["1", "2"]);
    expect(stderr).toBe("");
  } finally {
    child.kill();
  }
});
