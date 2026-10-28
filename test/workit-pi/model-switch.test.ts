// #435 on Pi: the per-turn context leads with the compact contract on the
// first turn after a model switch, once; a repeated identical failing Workit
// tool call ends its error with the corrected payload.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invariantBootstrap } from "@/packages/workit-core/src/core";
import { turnContext } from "@/packages/workit-pi/src/context";
import { registerWorkitTools } from "@/packages/workit-pi/src/tools";

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

test("Given a Pi session, When its model changes, Then only the next turn context carries the contract", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-pi-switch-"));
  try {
    const ctx = fakeCtx(root, "pi-switch");
    const contract = invariantBootstrap();
    expect(turnContext(ctx as never) ?? "").not.toContain(contract);
    expect(turnContext(ctx as never) ?? "").not.toContain(contract);
    ctx.model = { id: "deepseek-flash", provider: "deepseek" };
    expect(turnContext(ctx as never)).toContain(contract);
    expect(turnContext(ctx as never) ?? "").not.toContain(contract);
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
