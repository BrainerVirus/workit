// #435 on Pi: the per-turn context leads with the compact contract on the
// first turn after a model switch, once; a repeated identical failing Workit
// tool call ends its error with the corrected payload.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invariantBootstrap } from "@/packages/workit-core/src/core";
import {
  modelSwitchContract,
  noteModelSelect,
  turnContext,
} from "@/packages/workit-pi/src/context";
import { observeToolResult, registerWorkitTools } from "@/packages/workit-pi/src/tools";

const fakeCtx = (root: string, session: string) => {
  const ctx = {
    cwd: root,
    hasUI: false,
    model: { id: "strong", provider: "anthropic" },
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => session },
  };
  return ctx;
};

test("Given a Pi session, When model_select reports a change, Then the contract is owed once and a first model owes nothing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-pi-switch-"));
  try {
    const ctx = fakeCtx(root, "pi-switch");
    const strong = { id: "strong", provider: "anthropic" };
    const flash = { id: "deepseek-flash", provider: "deepseek" };
    noteModelSelect({ model: strong, previousModel: undefined }, ctx as never);
    expect(modelSwitchContract(ctx as never)).toBeNull();
    noteModelSelect({ model: flash, previousModel: strong }, ctx as never);
    expect(modelSwitchContract(ctx as never)).toBe(invariantBootstrap());
    expect(modelSwitchContract(ctx as never)).toBeNull();
    noteModelSelect({ model: flash, previousModel: flash }, ctx as never);
    expect(modelSwitchContract(ctx as never)).toBeNull();
    expect(turnContext(ctx as never) ?? "").not.toContain(invariantBootstrap());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given failing bash workit calls, When the identical command fails twice, Then the second result names the unblock", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-pi-cli-"));
  try {
    const ctx = fakeCtx(root, "pi-cli");
    const event = (output: string) => ({
      toolName: "bash",
      toolCallId: "c",
      isError: true,
      input: { command: "workit check bogus" },
      content: [{ type: "text", text: output }],
    });
    const out = "workit: unknown check\nunblock: workit check typecheck";
    const first = observeToolResult(event(out) as never, ctx as never);
    expect(JSON.stringify(first ?? "")).not.toContain("Same call failed twice:");
    const second = observeToolResult(event(out) as never, ctx as never);
    expect(JSON.stringify(second)).toContain("Same call failed twice: workit check typecheck");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a failing Pi workit_finding call, When the identical call fails again, Then its error ends with the corrected payload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-pi-repeat-"));
  try {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<any> }> = [];
    registerWorkitTools({ registerTool: (tool) => tools.push(tool as never) });
    const finding = tools.find((tool) => tool.name === "workit_finding")!;
    const ctx = fakeCtx(root, "pi-repeat");
    const call = async (input: unknown) =>
      (await finding.execute("id", input, undefined, undefined, ctx)).details;
    const bad = { schemaVersion: 1, action: "record", claim: "x" };
    expect((await call(bad)).error).not.toContain("Same call failed twice:");
    expect((await call(bad)).error).toContain("Same call failed twice: workit_finding {");
    expect((await call({ ...bad, claim: "y" })).error).not.toContain("Same call failed twice:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
