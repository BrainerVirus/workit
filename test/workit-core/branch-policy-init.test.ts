import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initApplyData } from "../../packages/workit-core/src/core/init";

const repoWith = (branches: string[]) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-bpi-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", branches[0] ?? "main"]);
  run(["config", "user.name", "T"]);
  run(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "r.md"), "x");
  run(["add", "r.md"]);
  run(["commit", "-q", "-m", "base"]);
  for (const b of branches.slice(1)) run(["branch", "-q", b]);
  return root;
};

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-bpi-cfg-"));
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
  return dir;
};

test("CA-03: branch_policy init creates the workspace entry idempotently", () => {
  const root = repoWith(["main", "develop"]);
  const cfg = cfgDir();
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
    const first = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
    } as NodeJS.ProcessEnv);
    expect(first.ok).toBe(true);
    expect(first.status).toBe("configured");
    expect(first.policy.preset).toBe("gitflow");
    expect(first.policy.integration).toBe("merge");
    const ws = JSON.parse(readFileSync(path.join(cfg, "workspaces.json"), "utf8"));
    expect(ws.workspaces).toHaveLength(1);
    expect(ws.workspaces[0].glob).toBe(`${root}/**`);
    expect(ws.workspaces[0].branchPolicy.preset).toBe("gitflow");

    const second = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
    } as NodeJS.ProcessEnv);
    expect(second.status).toBe("already-configured");

    const edited = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
      WORKFLOW_BP_INTEGRATION: "pr",
    } as NodeJS.ProcessEnv);
    expect(edited.status).toBe("updated");
    const ws2 = JSON.parse(readFileSync(path.join(cfg, "workspaces.json"), "utf8"));
    expect(ws2.workspaces[0].branchPolicy.integration).toBe("pr");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("CA-03: branch_policy init creates workspaces.json from a fresh config dir", () => {
  const root = repoWith(["main", "develop"]);
  const cfg = mkdtempSync(path.join(os.tmpdir(), "wf-bpi-fresh-"));
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
    const first = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
    } as NodeJS.ProcessEnv);
    expect(first.ok).toBe(true);
    expect(first.status).toBe("configured");
    expect(first.policy.preset).toBe("gitflow");
    const ws = JSON.parse(readFileSync(path.join(cfg, "workspaces.json"), "utf8"));
    expect(ws.workspaces).toHaveLength(1);
    expect(ws.workspaces[0].glob).toBe(`${root}/**`);
    expect(ws.workspaces[0].branchPolicy.preset).toBe("gitflow");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
