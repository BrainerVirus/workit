import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoTools } from "../packages/workit/src/tools/repo";
import { readConfig } from "../packages/workit/src/core/config";

test("init_apply writes config.json with guided values", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-config-tools-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    const tools = createRepoTools();
    const raw = await tools.workflow_toolkit_init_apply.execute({
      confirmed: true,
      action: "config",
      locale: "es-CL",
      branch_policy_preset: "custom",
      branch_policy_allowed: ["feature/*", "codex/*"],
      branch_policy_protected: ["main"],
    }, { directory: dir, worktree: dir } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    const cfg = readConfig();
    expect(cfg.locale).toBe("es-CL");
    expect(cfg.branchPolicy.preset).toBe("custom");
    expect(cfg.branchPolicy.allowed).toContain("codex/*");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
