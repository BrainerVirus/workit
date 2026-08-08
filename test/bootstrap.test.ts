import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkflowBootstrap, isWorkflowBootstrap, loadWorkflowBootstrap } from "../packages/workit/src/bootstrap";
import plugin from "../packages/workit/src/plugin";

describe("session bootstrap", () => {
  test("bootstrap contract includes visual companion override", () => {
    const bootstrap = getWorkflowBootstrap();
    expect(bootstrap).toContain("NEVER offer Superpowers visual companion");
    expect(bootstrap).toContain("workflow_present_ascii");
    expect(bootstrap).toContain("workflow_present_flow");
  });

  test("messages.transform injects bootstrap once on first user turn", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as never);
    const output = {
      messages: [{
        info: { role: "user" as const, id: "m1", sessionID: "s1", time: { created: 0, updated: 0 } },
        parts: [{ type: "text" as const, text: "hello", id: "p1", messageID: "m1", sessionID: "s1", time: { created: 0, updated: 0 } }],
      }],
    };
    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    const texts = output.messages[0].parts.map((p: any) => p.text ?? "");
    expect(texts.some((t: string) => isWorkflowBootstrap(t))).toBe(true);
    expect(texts[texts.length - 1]).toBe("hello");
    const afterFirst = output.messages[0].parts.length;

    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    expect(output.messages[0].parts.length).toBe(afterFirst);
  });
});


test("loadWorkflowBootstrap returns null for a missing template root", () => {
  expect(loadWorkflowBootstrap("/nonexistent-toolkit-root")).toBeNull();
});

test("loadWorkflowBootstrap reads the real contract template", () => {
  const contract = loadWorkflowBootstrap(path.resolve(import.meta.dir, "..", "packages", "workit"));
  expect(contract).toContain("**Spec:**");
});

test("bootstrap contract declares the configured locale", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-bootstrap-locale-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      locale: "es-CL", localeOptions: ["en", "es-CL"], timezone: "UTC",
      branchPolicy: { preset: "gitflow" },
    }, null, 2));
    const fresh = await import(`../packages/workit/src/bootstrap?locale=${Date.now()}`);
    const bootstrap = fresh.getWorkflowBootstrap();
    expect(bootstrap).toContain("es-CL");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
