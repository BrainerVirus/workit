/** Deterministic OpenAI-compatible stub for the V2 contract spike.
 *
 * Serves SSE-streamed chat completions (the 2.0.3 openai-compatible runtime
 * requires `stream: true`; plain JSON bodies fail as provider.invalid-output
 * and retry forever). Turns are scripted per conversation and selected
 * WITHOUT counters so reruns are deterministic:
 * - model id `stub-<script>` selects the script (no headers needed);
 * - a trailing runtime summary prompt selects the templated summary turn;
 * - otherwise a tool-result in history selects the final turn, else the opener.
 * Every request is logged to $STUB_LOG (default /tmp/stub-requests.log).
 * Run directly: `bun mock-provider.ts` (PORT env, default 8000). */

const LOG = process.env.STUB_LOG ?? "/tmp/stub-requests.log";
const log = async (line: unknown) => {
  try {
    const prev = (await Bun.file(LOG).exists()) ? await Bun.file(LOG).text() : "";
    await Bun.write(LOG, `${prev + JSON.stringify(line)}\n`);
  } catch {}
};

const chunk = (delta: object, finish: string | null) =>
  JSON.stringify({
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

const textTurn = (text: string, finish: string | null) =>
  chunk({ role: "assistant", content: text }, finish);

const toolTurn = (id: string, name: string, args: object) =>
  chunk(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    null,
  );

const sse = (chunks: string[]) =>
  new Response(`${chunks.map((c) => `data: ${c}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });

const textOnly = (t: string) => textTurn(t, null);

const SUMMARY = [
  "## Objective",
  "- Probe the V2 contract spike",
  "",
  "## Requirements",
  "- (none)",
  "",
  "## Decisions",
  "- (none)",
  "",
  "## Work State",
  "### Completed",
  "- (none)",
  "### Active",
  "- Probing",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. (none)",
  "",
  "## Relevant Files",
  "- (none)",
  "",
  "## Important Context",
  "- (none)",
].join("\n");

const scripts: Record<string, (() => Response)[]> = {
  // Opener calls probe_ping (expected to fail as unavailable on 2.0.3;
  // the envelope shape is the assertion), closer ends the loop.
  model: [
    () => sse([toolTurn("call_1", "probe_ping", { word: "hello" }), textTurn("", "tool_calls")]),
    () => sse([textTurn("pong done", null), textTurn("", "stop")]),
  ],
  shell: [
    () =>
      sse([
        toolTurn("call_1", "shell", {
          command: "git switch -c probe-branch",
          description: "probe shell",
        }),
        textTurn("", "tool_calls"),
      ]),
    () => sse([textTurn("shell done", null), textTurn("", "stop")]),
  ],
  question: [
    () =>
      sse([
        toolTurn("call_1", "question", {
          questions: [
            {
              question: "Pick one?",
              header: "Probe",
              options: [
                { label: "alpha", description: "First" },
                { label: "beta", description: "Second" },
              ],
            },
          ],
        }),
        textTurn("", "tool_calls"),
      ]),
    () => sse([textTurn("question done", null), textTurn("", "stop")]),
  ],
  subagent: [
    () =>
      sse([
        toolTurn("call_1", "subagent", {
          description: "probe child",
          prompt: "reply with child-ok",
          agent: "general",
        }),
        textTurn("", "tool_calls"),
      ]),
    () => sse([textOnly("child done"), textTurn("", "stop")]),
  ],
  subagent2: [
    () =>
      sse([
        JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1,
          model: "stub-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "subagent",
                      arguments: JSON.stringify({
                        description: "child one",
                        prompt: "reply one",
                        agent: "general",
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "subagent",
                      arguments: JSON.stringify({
                        description: "child two",
                        prompt: "reply two",
                        agent: "general",
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        textTurn("", "tool_calls"),
      ]),
    () => sse([textOnly("both done"), textTurn("", "stop")]),
  ],
  text: [() => sse([textOnly("hello from stub"), textTurn("", "stop")])],
  summary: [() => sse([textOnly(SUMMARY), textTurn("", "stop")])],
};

const hasToolResult = (body: any) =>
  Array.isArray(body?.messages) &&
  body.messages.some(
    (m: any) =>
      m?.role === "tool" ||
      (Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "tool-result")),
  );

const isCompaction = (body: any) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1];
  const textOf = (m: any) =>
    typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n")
        : "";
  return (
    (last?.role === "user" || last?.role === undefined) && /summariz/i.test(textOf(last) ?? "")
  );
};

Bun.serve({
  port: Number(process.env.PORT ?? 8000),
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    let body: any = null;
    try {
      body = await req.json();
    } catch {}
    await log({
      method: req.method,
      path: url.pathname,
      stream: body?.stream,
      model: body?.model,
      tools: (body?.tools ?? []).map((t: any) => t?.function?.name ?? t?.name),
      promptMarker: JSON.stringify(body?.messages ?? []).includes("[PROBE-PROMPT-MARKER]"),
    });
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "stub-model", object: "model", created: 1, owned_by: "stub" }],
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      const model = String(body?.model ?? "");
      const script = model.startsWith("stub-") ? model.slice("stub-".length) : "model";
      const turns = scripts[script] ?? scripts.model!;
      if (isCompaction(body)) return scripts.summary![0]!();
      return hasToolResult(body) ? turns[turns.length - 1]!() : turns[0]!();
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`stub listening on :${process.env.PORT ?? 8000}`);
