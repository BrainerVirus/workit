// S17 invalid_input rate: realistic agent payloads (flat, aliased,
// stringified, and the ≤6.x nested assessment) replayed against one branch
// task through every host's parse path and the engine. None is rejected for
// shape.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TaskStore,
  WorkitCore,
  parseAdvertisedOperation,
  type OperationFamily,
} from "@/packages/workit-core/src/core";
import type { Host } from "@/packages/workit-core/src/core/task-contract";

type Payload = { name: string; family: OperationFamily; input: Record<string, unknown> };
const { payloads } = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../fixtures/agent-payloads/replay.json"), "utf8"),
) as { payloads: Payload[] };

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test.each<Host>(["opencode", "cursor", "pi", "workit_cli"])(
  "%s: every realistic agent payload is accepted for shape (0 invalid_input)",
  (host) => {
    const root = mkdtempSync(path.join(tmpdir(), "workit-replay-"));
    roots.push(root);
    spawnSync("git", ["init", "-q", "-b", "feature/replay"], { cwd: root });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"],
      { cwd: root },
    );
    const core = new WorkitCore(new TaskStore(root), {
      root,
      caller: { host, actor: "agent-session" },
      callerAttested: true,
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const rejected: string[] = [];
    for (const payload of payloads) {
      // The host-side parse every adapter runs before the engine.
      const parsed = parseAdvertisedOperation(payload.family, payload.input, host);
      if (!parsed.ok) {
        rejected.push(`${payload.name}: host parse ${JSON.stringify(parsed.details)}`);
        continue;
      }
      const run = core[payload.family] as unknown as (input: unknown) => {
        ok: boolean;
        code?: string;
        details?: unknown;
      };
      const result = run.call(core, parsed.data);
      if (!result.ok)
        rejected.push(`${payload.name}: ${result.code} ${JSON.stringify(result.details)}`);
    }
    expect(rejected).toEqual([]);
    expect(payloads.length).toBeGreaterThanOrEqual(15);
  },
);
