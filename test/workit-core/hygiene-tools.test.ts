import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executeInitApply,
  initApplyRuntime,
} from "@/packages/workit-opencode/src/shared/init-apply";

// The OpenCode V2 adapter calls the shared executor directly (v2/plugin.ts).
const createRepoTools = (runtime = initApplyRuntime) => ({
  workit_init_apply: {
    execute: async (args: unknown, context: { directory: string }) =>
      executeInitApply(args as never, context.directory, runtime),
  },
});

test("init_apply hygiene action creates missing files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-hygiene-tools-"));
  try {
    const tools = createRepoTools();
    const no = JSON.parse(
      await tools.workit_init_apply.execute(
        {
          confirmed: false,
          action: "hygiene",
        },
        { directory: dir, worktree: dir } as never,
      ),
    );
    expect(no.ok).toBe(false);

    const yes = JSON.parse(
      await tools.workit_init_apply.execute(
        {
          confirmed: true,
          action: "hygiene",
          include_open_source: true,
        },
        { directory: dir, worktree: dir } as never,
      ),
    );
    expect(yes.ok).toBe(true);
    expect(yes.data.created).toContain("CHANGELOG.md");
    expect(existsSync(path.join(dir, "CHANGELOG.md"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
