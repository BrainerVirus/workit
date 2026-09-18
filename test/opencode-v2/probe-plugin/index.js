import fs from "node:fs";

// Dependency-free V2 probe plugin (plain object form; the pinned 2.0.3
// runtime has no ctx.provider/ctx.model domains, so nothing is imported).
// Observes only: it registers one tool, subscribes to events, and logs
// hook invocations as JSONL to $V2PROBE_LOG (default /tmp/v2probe-events.log).
// Permission rules are NEVER set here; tests set them explicitly per session
// through PUT /api/session/{id}/permission/rules.

const LOG = process.env.V2PROBE_LOG ?? "/tmp/v2probe-events.log";
const log = (line) => {
  try {
    fs.appendFileSync(LOG, JSON.stringify(line) + "\n");
  } catch {}
};

export default {
  id: "v2probe",
  async setup(ctx) {
    log({ ev: "setup", version: ctx.app?.version, dir: ctx.location?.directory });
    log({ ev: "ctx.keys", keys: Object.keys(ctx).sort() });
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe_ping",
        description: "Probe tool that returns pong",
        input: {
          type: "object",
          properties: { word: { type: "string", description: "A word" } },
          required: ["word"],
          additionalProperties: false,
        },
        execute: async (input) => {
          log({ ev: "tool.execute", tool: "probe_ping", input });
          return { content: `pong ${input?.word ?? ""}`.trim() };
        },
      });
      log({ ev: "tool.list", tools: editor.list().map((t) => t.id) });
    });
    const ctl = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ctl.signal })) {
          log({ ev: "event", type: event.type ?? "?", id: event.id ?? null });
        }
      } catch (e) {
        log({ ev: "event.end", error: String(e) });
      }
    })();
    await ctx.session.hook("prompt", async (event) => {
      if (event.prompt && typeof event.prompt.text === "string") {
        event.prompt.text = `${event.prompt.text}\n[PROBE-PROMPT-MARKER]`;
        log({ ev: "hook.prompt" });
      }
    });
    await ctx.session.hook("context", async () => {
      log({ ev: "hook.context" });
    });
    await ctx.session.hook("compaction", async () => {
      log({ ev: "hook.compaction" });
    });
    await ctx.permission.hook("evaluate", async (event) => {
      log({ ev: "hook.permission", event: JSON.parse(JSON.stringify(event)) });
    });
    await ctx.tool.hook("execute.before", async (event) => {
      log({ ev: "hook.tool.before", tool: event.tool });
    });
    await ctx.tool.hook("execute.after", async (event) => {
      log({ ev: "hook.tool.after", tool: event.tool, status: event.status });
    });
    return () => {
      ctl.abort();
      log({ ev: "cleanup" });
    };
  },
};
