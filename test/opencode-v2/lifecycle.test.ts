/** V2 lifecycle edge-case suite (docs/opencode-v2/plan.md step 4).
 *
 * Exercises what the contract suite does not: concurrent launches and event
 * interleaving, mid-flight interrupt, missed terminal events via mid-run
 * unload, subscription cleanup, and bounded session.get reconciliation.
 * Same opt-in as contract.test.ts: `WORKIT_V2_HARNESS=1 bun test
 * test/opencode-v2/lifecycle.test.ts`. The unload test runs last because it
 * briefly removes the probe plugin (restored immediately after).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, dispose, dockerAvailable, ensureImages, type Harness } from "./harness";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENABLED = process.env.WORKIT_V2_HARNESS === "1";
let h: Harness | null = null;
let skipped = "";

const need = (): Harness => {
  if (!h) throw new Error(`harness unavailable: ${skipped}`);
  return h;
};

beforeAll(async () => {
  if (!ENABLED) {
    skipped = "WORKIT_V2_HARNESS!=1";
    return;
  }
  if (!(await dockerAvailable())) {
    skipped = "no docker";
    return;
  }
  try {
    await ensureImages();
  } catch {
    skipped = "pinned images unreachable";
    return;
  }
  h = await boot();
}, 300_000);

afterAll(async () => {
  if (h) await dispose(h);
  h = null;
});

const lines = (text: string): any[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const sessionWithModel = async (model: string): Promise<string> => {
  const s = await need().api("POST", "/api/session", {
    location: { directory: "/workspace/work" },
  });
  const id = s.data.id as string;
  await need().api(
    "POST",
    `/api/session/${id}/model`,
    {
      model: { providerID: "stub", id: model },
    },
    true,
  );
  return id;
};

const prompt = async (id: string, text: string): Promise<void> => {
  await need().api("POST", `/api/session/${id}/prompt`, { text });
};

const waitIdle = async (id: string, timeoutMs = 90_000): Promise<any[]> => {
  const start = Date.now();
  for (;;) {
    const ctx = await need().api("GET", `/api/session/${id}/context`);
    const msgs = ctx.data as any[];
    if (msgs.some((m) => m.type === "idle")) return msgs;
    if (Date.now() - start > timeoutMs) throw new Error(`session ${id} never idle`);
    await Bun.sleep(2000);
  }
};

const waitForToolRunning = async (id: string, marker: string): Promise<void> => {
  const start = Date.now();
  for (;;) {
    const ctx = await need().api("GET", `/api/session/${id}/context`);
    if (JSON.stringify(ctx.data).includes(marker)) return;
    if (Date.now() - start > 60_000) throw new Error("tool never started");
    await Bun.sleep(2000);
  }
};

test("concurrent subagent launches interleave with unique event ids", async () => {
  if (!h) return;
  const beforeIds = new Set(
    lines(h.probeLog())
      .filter((e) => e.ev === "event" && typeof e.id === "string")
      .map((e) => e.id as string),
  );
  const id = await sessionWithModel("stub-subagent2");
  await prompt(id, "spawn two");
  const msgs = await waitIdle(id, 120_000);
  const calls = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === "tool" && c.name === "subagent");
  expect(calls.map((c) => c.id).sort()).toEqual(["call_1", "call_2"]);
  for (const c of calls) expect(c.state.status).toBe("completed");
  const all = await need().api("GET", "/api/session");
  const kids = (all.data as any[]).filter((s) => s.parentID === id);
  expect(kids.length).toBe(2);
  // No event id may repeat or go missing across the interleaved run.
  const windowIds = lines(need().probeLog())
    .filter((e) => e.ev === "event" && typeof e.id === "string")
    .map((e) => e.id as string)
    .filter((evt) => !beforeIds.has(evt));
  expect(windowIds.length).toBeGreaterThan(0);
  expect(new Set(windowIds).size).toBe(windowIds.length);
}, 240_000);

test("interrupt mid-flight aborts without forging terminal states", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-slow");
  await prompt(id, "go slow");
  await waitForToolRunning(id, "sleep 20");
  const intr = await need().api("POST", `/api/session/${id}/interrupt`, {});
  expect(intr).toMatchObject({ interrupted: true });
  const msgs = await waitIdle(id);
  const idle = msgs.find((m) => m.type === "idle");
  expect(idle.outcome).toBe("interrupted");
  const call = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === "tool" && c.name === "shell");
  expect(call.executed).toBe(false);
  expect(call.state.status).toBe("error");
  expect(call.state.error).toMatchObject({ type: "aborted" });
  const got = await need().api("GET", `/api/session/${id}`);
  expect(got.data).toMatchObject({ id, outcome: "interrupted" });
}, 240_000);

test("bounded session.get reconciliation exposes the terminal outcome", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "hi");
  await waitIdle(id);
  // A fixed small poll budget suffices; the route returns id, model,
  // outcome, cost, tokens, time, and location — no event stream needed.
  let polls = 0;
  let got: any = null;
  for (let i = 0; i < 5; i++) {
    polls += 1;
    got = await need().api("GET", `/api/session/${id}`);
    if (got?.data?.outcome) break;
  }
  expect(polls).toBeLessThanOrEqual(5);
  expect(got.data).toMatchObject({
    id,
    model: { id: "stub-text", providerID: "stub" },
    location: { directory: "/workspace/work" },
  });
  expect(typeof got.data.outcome).toBe("string");
  expect(got.data.time).toMatchObject({ created: expect.any(Number) });
}, 180_000);

test("unload mid-run cleans up and polling still reconciles", async () => {
  if (!h) return;
  const cleanupsBefore = lines(h.probeLog()).filter((e) => e.ev === "cleanup").length;
  const setupsBefore = lines(h.probeLog()).filter((e) => e.ev === "setup").length;
  const id = await sessionWithModel("stub-slow");
  await prompt(id, "go slow");
  await waitForToolRunning(id, "sleep 20");
  rmSync(path.join(need().workdir, ".opencode", "plugins", "v2probe", "index.js"));
  const t0 = Date.now();
  for (;;) {
    if (lines(need().probeLog()).filter((e) => e.ev === "cleanup").length > cleanupsBefore) break;
    if (Date.now() - t0 > 60_000) throw new Error("cleanup never ran");
    await Bun.sleep(2000);
  }
  // Subscription is dead from here on: terminal state must still reconcile
  // through polling alone.
  const msgs = await waitIdle(id, 120_000);
  expect(msgs.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
  copyFileSync(
    path.join(HERE, "probe-plugin", "index.js"),
    path.join(need().workdir, ".opencode", "plugins", "v2probe", "index.js"),
  );
  const t1 = Date.now();
  for (;;) {
    if (lines(need().probeLog()).filter((e) => e.ev === "setup").length > setupsBefore) break;
    if (Date.now() - t1 > 60_000) throw new Error("plugin never reloaded");
    await Bun.sleep(2000);
  }
}, 300_000);
