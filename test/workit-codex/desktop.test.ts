import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  codexContextProvider,
  codexQualification,
  resolveCodexWorkspaceRoot,
} from "@/packages/workit-codex/scripts/launch-mcp";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

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
  // Direct field assertions (never toMatchObject with asymmetric matchers:
  // bun's matcher pass replaces asymmetrically-matched properties on the
  // received object with {} — proven by repro: {x:"hello-world"} became {x:{}}).
  const output = result.hookSpecificOutput as {
    hookEventName: string;
    additionalContext: unknown;
  };
  expect(output.hookEventName).toBe("SessionStart");
  expect(typeof output.additionalContext).toBe("string");
  expect(output.additionalContext).toContain("workit-codex-mutations");
  expect(output.additionalContext).toContain("workit CLI");
  expect(output.additionalContext).toContain("<workit-contract>");
});

test("Codex MCP mutation refusal points at the CLI path", async () => {
  const { createMcpServer } = await import("@/packages/workit-mcp/src/server");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const root = mkdtempSync(path.join(tmpdir(), "workit-codex-refusal-"));
  const server = createMcpServer("codex_cli", codexContextProvider("codex_cli", root));
  const client = new Client({ name: "workit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: "workit_task",
      arguments: {
        schemaVersion: 1,
        action: "start",
        intent: {
          objective: "x",
          scope: { description: "x", paths: [], exclusions: [] },
          authorityRefs: [],
        },
      },
    });
    const structured = result.structuredContent as { ok: boolean; code?: string; error?: string };
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe("capability_unavailable");
    expect(structured.error ?? "").toContain("workit CLI");
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
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
    new TaskStore(validRoot).root,
  );
  const freshRoot = mkdtempSync(path.join(tmpdir(), "workit-codex-no-state-"));
  expect(await codexContextProvider("codex_cli", freshRoot).current()).toMatchObject({
    root: new TaskStore(freshRoot).root,
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
