import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  codexContextProvider,
  codexQualification,
} from "../../packages/workit-codex/scripts/launch-mcp";
import { handleCodexHook } from "../../packages/workit-codex/hooks/workit-hook";

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
    const provider = codexContextProvider(
      host,
      mkdtempSync(path.join(tmpdir(), "workit-codex-mcp-")),
    );
    const context = await provider.current();
    expect(context.caller).toEqual({ host, actor: "" });
    expect(context.callerAttested).toBe(false);
  }
});
