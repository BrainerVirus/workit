import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin from "@/packages/workit-opencode/src/plugin";
import { assertOpencodeWorkitNamespace } from "@/test/shared/helpers/opencode-namespace";

const repository = (branch: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-smoke-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(git(["init", "-q", "-b", branch]).status).toBe(0);
  git(["config", "user.name", "Workflow Smoke"]);
  git(["config", "user.email", "workflow-smoke@example.test"]);
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  git(["add", "README.md"]);
  expect(git(["commit", "-q", "-m", "test: fixture"]).status).toBe(0);
  return { root, git };
};

test("native tools expose exactly the eight OpenCode operation families", () => {
  assertOpencodeWorkitNamespace();
});

test("OpenCode plugin registers native tools without Cursor assets", async () => {
  const { root } = repository("feature/test");
  try {
    expect(existsSync(path.join(root, ".cursor/plugins/local/workit"))).toBe(false);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const config: Record<string, any> = {};
    await hooks.config?.(config);
    expect(Object.keys(config.command ?? {}).sort()).toEqual([
      "wk-babysit",
      "wk-blast-radius",
      "wk-challenge",
      "wk-debug",
      "wk-deslop",
      "wk-diagram",
      "wk-green-run",
      "wk-handoff",
      "wk-implement",
      "wk-mockup",
      "wk-plan",
      "wk-review",
      "wk-steer",
      "wk-tdd",
    ]);
    expect(config.skills.paths).toEqual([
      path.resolve(import.meta.dir, "../../packages/workit-opencode/assets/skills"),
    ]);
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(10);
    expect(Object.keys(hooks.tool ?? {})).toContain("workit_external_action");
    expect(Object.keys(hooks.tool ?? {})).toContain("workit_init_apply");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
