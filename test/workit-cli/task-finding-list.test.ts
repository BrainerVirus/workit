import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskCommand } from "@/packages/workit-cli/src/task";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";

const scope = { description: "checkout", paths: ["."], exclusions: [] };

const list = async (root: string, args: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await runTaskCommand(["finding", "list", ...args], {
    cwd: root,
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { code, stdout, stderr };
};

test("Given recorded findings, When `finding list` runs, Then ids are listed and --status filters open from resolved", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-finding-list-"));
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
      intent: { objective: "list findings", scope, authorityRefs: [] },
    });
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const ids: string[] = [];
    for (const claim of ["first claim", "second claim"]) {
      const recorded = core.finding({
        schemaVersion: 1,
        action: "record",
        taskId,
        claim,
        consequence: "c",
        scope,
        candidateId: null,
        refs: [],
      });
      if (!recorded.ok) throw new Error(recorded.error);
      ids.push((recorded.data as { id: string }).id);
    }
    const all = await list(root, []);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain(`${ids[0]} open`);
    expect(all.stdout).toContain(`${ids[1]} open`);

    const open = await list(root, ["--status", "open", "--json"]);
    const rows = JSON.parse(open.stdout).data.findings;
    expect(rows.map((row: { id: string }) => row.id)).toEqual(ids);
    const resolved = JSON.parse((await list(root, ["--status", "resolved", "--json"])).stdout);
    expect(resolved.data.findings).toEqual([]);

    const other = JSON.parse((await list(root, ["--branch", "nope", "--json"])).stdout);
    expect(other.data.findings).toEqual([]);
    const bad = await list(root, ["--status", "bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("open or resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given no findings, When `finding list` runs, Then it says so and where findings are recorded", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-finding-list-"));
  try {
    const result = await list(root, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no findings recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
