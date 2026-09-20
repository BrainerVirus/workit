/** V2 Docker contract suite (docs/opencode-v2/plan.md step 3).
 *
 * Boots the pinned V2 image with the deterministic mock provider and asserts
 * every host surface the later parity matrix needs. Opt-in only:
 * `WORKIT_V2_HARNESS=1 bun test test/opencode-v2/contract.test.ts`
 * (needs docker plus the pinned images; pulls them when reachable).
 * Without the opt-in the file passes silently.
 *
 * Deliberately asserted 2.0.3 behaviors that differ from latest docs:
 * - ctx has no provider/model domains (config-declared providers instead);
 * - plugin-registered tools need `options: { codemode: false }` to reach
 *   model requests;
 * - context/compaction system edits reach the provider like prompt edits
 *   (an earlier spike note claimed they did not; re-probed and corrected).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { boot, dispose, dockerAvailable, ensureImages, V2_IMAGE, type Harness } from "./harness";

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

test("probe plugin loads with the pinned 2.0.3 context shape", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "hi");
  await waitIdle(id);
  const evs = lines(h.probeLog());
  expect(evs.some((e) => e.ev === "setup" && e.version === "2.0.3")).toBe(true);
  const keys = evs.find((e) => e.ev === "ctx.keys")?.keys as string[];
  expect(keys).toContain("tool");
  expect(keys).toContain("event");
  expect(keys).toContain("permission");
  expect(keys).toContain("session");
  expect(keys).not.toContain("provider");
  expect(keys).not.toContain("model");
}, 180_000);

test("agent loop streams through the stub and reports envelopes with ids", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "hi");
  const msgs = await waitIdle(id);
  const last = msgs.filter((m) => m.type === "assistant").at(-1);
  expect(last.content[0]).toMatchObject({ type: "text", text: "hello from stub" });
  expect(last.finish).toBe("stop");
  expect(msgs.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
  const evs = lines(h.probeLog()).filter((e) => e.ev === "event");
  expect(evs.length).toBeGreaterThan(0);
  for (const e of evs) expect(e.id).toMatch(/^evt_/);
  expect(evs.some((e) => e.type === "session.created")).toBe(true);
}, 180_000);

test("offered tools include the subagent/question/shell surfaces", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "hi");
  await waitIdle(id);
  const reqs = lines(h.stubLog());
  const offered = reqs.find((r) => Array.isArray(r.tools) && r.tools.length > 5)?.tools as string[];
  expect(offered).toBeDefined();
  for (const name of ["subagent", "question", "shell"]) expect(offered).toContain(name);
}, 180_000);

test("shell allow path executes and captures output", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-shell");
  await prompt(id, "run shell");
  const msgs = await waitIdle(id);
  const call = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === "tool" && c.name === "shell");
  expect(call.state.status).toBe("completed");
  expect(JSON.stringify(call.state.content)).toContain("git");
  const perm = lines(h.probeLog()).find(
    (e) => e.ev === "hook.permission" && e.event?.action === "shell",
  );
  expect(perm?.event?.resources?.[0]).toContain("git switch -c probe-branch");
}, 180_000);

test("shell deny rules filter the tool from the offering", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-shell");
  await h.api(
    "PUT",
    `/api/session/${id}/permission/rules`,
    {
      permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    },
    true,
  );
  await prompt(id, "run shell");
  const msgs = await waitIdle(id);
  const call = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === "tool" && c.name === "shell");
  // Denied tools are not offered: the scripted call fails unexecuted.
  // (A mid-flight deny via the evaluate hook yields permission.rejected;
  // observed manually during the spike and recorded in task evidence.)
  expect(call.executed).toBe(false);
  expect(call.state.status).toBe("error");
  const offered = lines(h.stubLog())
    .filter((r) => r.model === "stub-shell" && Array.isArray(r.tools) && r.tools.length > 0)
    .at(-1)?.tools as string[];
  expect(offered).not.toContain("shell");
}, 180_000);

test("shell ask path surfaces a request and the reply executes it", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-shell");
  await h.api(
    "PUT",
    `/api/session/${id}/permission/rules`,
    {
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    },
    true,
  );
  await prompt(id, "run shell");
  let req: any = null;
  const start = Date.now();
  for (;;) {
    const list = await h.op("v2.session.permission.list", { sessionID: id });
    req = (list.data as any[])[0];
    if (req ?? Date.now() - start > 60_000) break;
    await Bun.sleep(2000);
  }
  expect(req.action).toBe("shell");
  expect(req.resources[0]).toContain("git switch -c probe-branch");
  expect(req.source.type).toBe("tool");
  await h.op(
    "v2.session.permission.reply",
    { sessionID: id, requestID: req.id },
    { reply: "once" },
    true,
  );
  const msgs = await waitIdle(id);
  const call = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === "tool" && c.name === "shell");
  expect(call.state.status).toBe("completed");
}, 180_000);

test("question flow creates a form, accepts a reply, and completes", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-question");
  await prompt(id, "ask me");
  let form: any = null;
  const start = Date.now();
  for (;;) {
    const list = await h.api("GET", `/api/session/${id}/form`);
    form = (list.data as any[])[0];
    if (form ?? Date.now() - start > 60_000) break;
    await Bun.sleep(2000);
  }
  expect(form.fields[0].key).toBe("q0");
  expect(form.fields[0].options.map((o: any) => o.value)).toEqual(["alpha", "beta"]);
  expect(form.metadata.kind).toBe("question");
  await h.op(
    "v2.session.form.reply",
    { sessionID: id, formID: form.id },
    { answer: { q0: "alpha" } },
    true,
  );
  const msgs = await waitIdle(id);
  expect(msgs.filter((m) => m.type === "assistant").at(-1).content[0].text).toBe("question done");
  expect(msgs.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
}, 180_000);

test("subagent spawns a child with parent lineage and a result envelope", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-subagent");
  await prompt(id, "spawn child");
  const msgs = await waitIdle(id, 120_000);
  const call = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === "tool" && c.name === "subagent");
  expect(call.state.status).toBe("completed");
  const childId = call.state.metadata.sessionID as string;
  expect(childId).toMatch(/^ses_/);
  const all = await h.api("GET", "/api/session");
  const child = (all.data as any[]).find((s) => s.id === childId);
  expect(child.parentID).toBe(id);
  expect(call.state.content[0].text).toContain(childId);
}, 180_000);

test("concurrent subagent calls complete in one turn", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-subagent2");
  await prompt(id, "spawn two");
  const msgs = await waitIdle(id, 120_000);
  const calls = msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === "tool" && c.name === "subagent");
  expect(calls.map((c) => c.id).sort()).toEqual(["call_1", "call_2"]);
  for (const c of calls) expect(c.state.status).toBe("completed");
  const all = await h.api("GET", "/api/session");
  const kids = (all.data as any[]).filter((s) => s.parentID === id);
  expect(kids.length).toBe(2);
}, 180_000);

test("compaction runs the hook, validates the template, and completes", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "hello");
  await waitIdle(id);
  await h.api("POST", `/api/session/${id}/compact`, {});
  const msgs = await waitIdle(id, 120_000);
  const compaction = msgs.find((m) => m.type === "compaction");
  expect(compaction.status).toBe("completed");
  expect(compaction.summary).toContain("## Objective");
  expect(lines(h.probeLog()).some((e) => e.ev === "hook.compaction")).toBe(true);
}, 180_000);

test("prompt-hook edits land in the persisted input and the model request", async () => {
  if (!h) return;
  const id = await sessionWithModel("stub-text");
  await prompt(id, "marker check");
  await waitIdle(id);
  const ctx = await h.api("GET", `/api/session/${id}/context`);
  const userMsg = (ctx.data as any[]).find((m) => m.type === "user");
  expect(userMsg.text).toContain("[PROBE-PROMPT-MARKER]");
  expect(lines(h.stubLog()).some((r) => r.promptMarker === true)).toBe(true);
}, 180_000);

test("unload runs plugin cleanup", async () => {
  if (!h) return;
  const before = lines(h.probeLog()).filter((e) => e.ev === "cleanup").length;
  rmSync(path.join(need().workdir, ".opencode", "plugins", "v2probe", "index.js"));
  const start = Date.now();
  for (;;) {
    if (lines(need().probeLog()).filter((e) => e.ev === "cleanup").length > before) break;
    if (Date.now() - start > 60_000) throw new Error("cleanup never ran");
    await Bun.sleep(2000);
  }
}, 120_000);

test("V1-shaped config normalizes in memory without rewriting the file", async () => {
  if (!h) return;
  const v1home = path.join(need().root, "v1home");
  mkdirSync(path.join(v1home, ".config", "opencode"), { recursive: true });
  const source = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: ["./local-plugin"],
      provider: {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          name: "Stub",
          options: { baseURL: "http://stub:8000/v1" },
          models: { "stub-model": { name: "Stub Model" } },
        },
      },
    },
    null,
    2,
  );
  writeFileSync(path.join(v1home, ".config", "opencode", "opencode.json"), source);
  const name = `v2harness-v1-${process.pid}`;
  try {
    await $`docker run --rm -d --name ${name} --network ${need().net} --entrypoint tail -e HOME=/home/oc -v ${v1home}:/home/oc ${V2_IMAGE} -f /dev/null`;
    await Bun.sleep(3000);
    const out = await $`docker exec ${name} opencode api GET /api/config`.text();
    const docs = JSON.parse(out.slice(out.indexOf("[")));
    const info = docs.find((d: any) => d.type === "document")?.info;
    expect(info.plugins).toEqual(["./local-plugin"]);
    expect(info.providers.stub.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(info.providers.stub.settings.baseURL).toBe("http://stub:8000/v1");
    expect(readFileSync(path.join(v1home, ".config", "opencode", "opencode.json"), "utf8")).toBe(
      source,
    );
  } finally {
    await $`docker rm -f ${name}`.quiet().catch(() => {});
  }
}, 120_000);
