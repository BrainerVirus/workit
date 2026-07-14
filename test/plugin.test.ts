import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/plugin";

const names = [
  "wf-init", "wf-status", "wf-verify", "wf-commit", "wf-pr",
  "wf-changelog", "wf-release-notes", "wf-docs-refresh",
  "wf-handoff", "wf-implement", "wf-meetings", "wf-issue-update",
];

describe("plugin registration", () => {
  test("registers exactly the twelve wf commands and one skill path", async () => {
    const hooks = await plugin({ worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toHaveLength(1);
    expect(config.skills.paths[0]).toEndWith("workflow-toolkit-opencode/skills");
  });

  test("compaction includes only active workflow paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-plugin-"));
    mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(path.join(root, "docs/superpowers/specs/x-design.md"), "# X\n");
    writeFileSync(
      path.join(root, "docs/superpowers/plans/x.md"),
      "# X\n**Spec:** `docs/superpowers/specs/x-design.md`\n### Task 1: One\n",
    );
    const hooks = await plugin({ worktree: root, serverUrl: new URL("http://localhost") } as never);
    await hooks.tool?.workflow_plan_tasks.execute(
      { plan_path: "docs/superpowers/plans/x.md" },
      { worktree: root, sessionID: "s1" } as never,
    );
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, output);

    expect(output.context).toEqual([
      "Active workflow:\nSpec: docs/superpowers/specs/x-design.md\nPlan: docs/superpowers/plans/x.md\nSDD: docs/superpowers/sdd/x",
    ]);
  });
});
