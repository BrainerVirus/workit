import { describe, expect, test } from "bun:test";
import plugin from "../src/plugin";

const names = [
  "wf-init", "wf-status", "wf-verify", "wf-commit", "wf-pr",
  "wf-changelog", "wf-release-notes", "wf-docs-refresh",
  "wf-handoff", "wf-implement", "wf-meetings", "wf-issue-update",
];

describe("plugin registration", () => {
  test("registers exactly the twelve wf commands and one skill path", async () => {
    const hooks = await plugin({ worktree: "/repo" } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command).sort()).toEqual([...names].sort());
    expect(config.skills.paths).toHaveLength(1);
    expect(config.skills.paths[0]).toEndWith("workflow-toolkit-opencode/skills");
  });
});
