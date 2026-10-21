import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskCommand } from "@/packages/workit-cli/src/task";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";

const scope = { description: "checkout", paths: ["."], exclusions: [] };

const capture = () => {
  let stdout = "";
  return {
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: () => {} },
    read: () => stdout,
  };
};

const inspect = async (root: string, args: string[]) => {
  const io = capture();
  const code = await runTaskCommand(["task", "inspect", ...args, "--json"], {
    cwd: root,
    out: io.out,
    err: io.err,
  });
  return { code, stdout: io.read() };
};

test("Given a task with a large history, When task inspect --view summary runs, Then the output is valid JSON under 4 KB", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-task-summary-"));
  try {
    const core = new WorkitCore(new TaskStore(root), {
      root,
      caller: { host: "workit_cli", actor: "test" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
    });
    const started = core.task({
      schemaVersion: 1,
      action: "start",
      expectedWorkspaceRevision: null,
      intent: { objective: `${"o".repeat(1200)} "quoted"`, scope, authorityRefs: [] },
    });
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const progressed = core.task({
      schemaVersion: 1,
      action: "progress",
      taskId,
      progress: {
        summary: "é\n".repeat(900),
        nextAction: "n".repeat(900),
        blockers: Array.from({ length: 25 }, (_, index) => ({
          reason: `blocker ${index} ${"r".repeat(800)}`,
          dependentAction: "d".repeat(400),
          refs: [],
        })),
      },
    });
    if (!progressed.ok) throw new Error(progressed.error);
    for (let index = 0; index < 60; index += 1) {
      const recorded = core.finding({
        schemaVersion: 1,
        action: "record",
        taskId,
        claim: `finding ${index} ${"c".repeat(3000)}`,
        consequence: "k".repeat(3000),
        scope,
        candidateId: null,
        refs: [],
      });
      if (!recorded.ok) throw new Error(recorded.error);
    }

    const full = await inspect(root, ["--task", taskId, "--view", "full"]);
    expect(full.code).toBe(0);
    expect(full.stdout.length).toBeGreaterThan(300_000);

    for (const args of [
      ["--task", taskId, "--view", "summary"],
      ["--task", taskId],
    ]) {
      const brief = await inspect(root, args);
      expect(brief.code).toBe(0);
      expect(Buffer.byteLength(brief.stdout)).toBeLessThan(4096);
      expect(JSON.parse(brief.stdout)).toMatchObject({
        ok: true,
        data: { id: taskId, status: "active", truncated: true },
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
