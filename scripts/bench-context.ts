#!/usr/bin/env bun
/**
 * Per-turn context benchmark for the OpenCode host.
 *
 * Builds a throwaway Git checkout with ~70 Workit tasks (each carrying a
 * recorded candidate, like real long-lived records) and times
 * `compactContextFor`, the call OpenCode makes on every model turn.
 *
 *   bun scripts/bench-context.ts [--tasks 70] [--files 1500] [--turns 30]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore } from "../packages/workit-core/src/core";
import { captureCandidate } from "../packages/workit-core/src/core/task-evaluation";
import { compactContextFor } from "../packages/workit-opencode/src/runtime";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const TASKS = arg("tasks", 70);
const FILES = arg("files", 1500);
const TURNS = arg("turns", 30);

const root = mkdtempSync(path.join(tmpdir(), "workit-bench-"));
try {
  for (let index = 0; index < FILES; index += 1) {
    const dir = path.join(root, "src", `m${index % 40}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `f${index}.ts`), `export const v${index} = ${"x".repeat(2000)};\n`);
  }
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "fixture");

  const store = new TaskStore(root);
  const candidate = captureCandidate(root, {
    description: "checkout",
    paths: ["."],
    exclusions: [],
  });
  if (!candidate.ok) throw new Error(candidate.error);
  for (let index = 0; index < TASKS; index += 1) {
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: `session-${index}` },
      capabilities: [],
      constraints: [],
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const started = core.task({
      schemaVersion: 1,
      action: "start",
      intent: {
        objective: `benchmark task ${index}`,
        scope: { description: "checkout", paths: ["."], exclusions: [] },
        authorityRefs: [],
      },
    });
    if (!started.ok) throw new Error(started.error);
    const id = (started.data as { id: string; revision: string }).id;
    const revision = (started.data as { revision: string }).revision;
    const grown = store.mutateTask(id, revision as never, (task) => ({
      ok: true,
      revision: null,
      workspaceRevision: null,
      data: { ...task, candidates: [candidate.data] },
    }));
    if (!grown.ok) throw new Error(grown.error);
  }

  const session = `session-${Math.floor(TASKS / 2)}`;
  const samples: number[] = [];
  let output: string | null = null;
  for (let turn = 0; turn < TURNS; turn += 1) {
    const started = performance.now();
    output = compactContextFor(root, session);
    samples.push(performance.now() - started);
  }
  if (!output) throw new Error("benchmark produced no context");
  // Cold index: a missing .workit/index.json is rebuilt on the next turn.
  rmSync(path.join(root, ".workit", "index.json"), { force: true });
  const coldStart = performance.now();
  compactContextFor(root, session);
  const coldIndexMs = performance.now() - coldStart;
  // After a write to the session's task the cached context is invalidated.
  const own = store.listTasks();
  if (!own.ok) throw new Error(own.error);
  const target = own.data.find((task) => task.intent.provenance.session?.handle === session)!;
  store.mutateTask(target.id, target.revision, (task) => ({
    ok: true,
    revision: null,
    workspaceRevision: null,
    data: { ...task, progress: { ...task.progress, nextAction: "benchmark next" } },
  }));
  const updatedStart = performance.now();
  const updated = compactContextFor(root, session);
  const afterUpdateMs = performance.now() - updatedStart;
  if (!updated?.includes("benchmark next")) throw new Error("context did not reflect the update");
  const sorted = [...samples].sort((left, right) => left - right);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  console.log(
    JSON.stringify({
      tasks: TASKS,
      files: FILES,
      turns: TURNS,
      firstMs: Number(samples[0]!.toFixed(2)),
      medianMs: Number(pick(0.5).toFixed(2)),
      p95Ms: Number(pick(0.95).toFixed(2)),
      coldIndexMs: Number(coldIndexMs.toFixed(2)),
      afterUpdateMs: Number(afterUpdateMs.toFixed(2)),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
