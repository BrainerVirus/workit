import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import React from "react";
import { Wizard } from "../../packages/workit-cli/src/steps";
import { renderInk } from "../shared/helpers/ink-tty";
import { applyWizardBranchPolicy } from "../../packages/workit-cli/src/logic";
import type { SetupValues } from "../../packages/workit-cli/src/wizard-state";
import { initApplyData } from "../../packages/workit-core/src/core/init";

// Task 5 (CA-06): the CLI wizard's branch-policy apply must write byte-identical
// bytes to the host init action (branch_policy) on the same fixture. The Wizard
// component only collects values; the apply runs through applyWizardBranchPolicy
// exactly like runInit does, so the test drives the wizard to accept defaults,
// replays its values through the wizard apply path, and compares the written
// workspaces.json against initApplyData's.

const ENTER = "\r";
const SPACE = " ";

const repoWith = (branches: string[]) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-bpw-"));
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

test("CA-06: wizard branch-policy apply equals the host init action write", async () => {
  const root = repoWith(["main", "develop"]);
  const cfg = mkdtempSync(path.join(os.tmpdir(), "wf-bpw-cfg-"));
  writeFileSync(path.join(cfg, "workspaces.json"), JSON.stringify({ workspaces: [] }));
  const prevCwd = process.cwd();
  const prevCfg = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const prevRoot = process.env.WORKFLOW_WORKSPACE_ROOT;
  const prevBpName = process.env.WORKFLOW_BP_NAME;
  process.chdir(root);
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
  process.env.WORKFLOW_WORKSPACE_ROOT = root;
  try {
    let exitValues: SetupValues | undefined;
    const tty = await renderInk(
      <Wizard
        onExit={(complete, values) => {
          if (complete) exitValues = values;
        }}
      />,
    );
    // platforms SPACE+ENTER, locale/timezone/branchPreset/youtrack/vcs ENTER,
    // workspaces Done ENTER -> branchPolicy (git repo), accept defaults ENTER ->
    // project, project y -> summary, summary y -> apply -> exit
    await tty.keys(SPACE, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, "y", "y");
    tty.unmount();
    expect(
      exitValues?.branchPolicy,
      "wizard reached and accepted the branchPolicy screen",
    ).toBeDefined();
    expect(exitValues?.branchPolicy?.preset).toBe("gitflow");

    // Replay the wizard's values through the exact apply path runInit uses
    // (applyWizardBranchPolicy — the shared seam owns env construction, so
    // runInit and this test cannot drift).
    const viaWizard = applyWizardBranchPolicy(exitValues!.branchPolicy, root, {});
    expect(viaWizard.ok, JSON.stringify(viaWizard)).toBe(true);
    expect(viaWizard.status).toBe("configured");
    const wsFile = readFileSync(path.join(cfg, "workspaces.json"), "utf8");

    const viaTool = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
      WORKFLOW_TOOLKIT_CONFIG: cfg,
    } as NodeJS.ProcessEnv);
    const wsTool = readFileSync(path.join(cfg, "workspaces.json"), "utf8");
    expect(viaTool.policy.integration).toBe("merge");
    expect(wsFile).toBe(wsTool);
    expect(JSON.parse(wsFile).workspaces[0].branchPolicy.preset).toBe("gitflow");
  } finally {
    process.chdir(prevCwd);
    if (prevCfg === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevCfg;
    if (prevRoot === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prevRoot;
    if (prevBpName === undefined) delete process.env.WORKFLOW_BP_NAME;
    else process.env.WORKFLOW_BP_NAME = prevBpName;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
