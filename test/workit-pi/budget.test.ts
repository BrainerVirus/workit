// Retro P9 on Pi: a supervised worker whose brief names `N tool calls` is
// told once, on the tool result of its Nth call, to checkpoint, report and stop.
import { afterEach, expect, test } from "bun:test";
import extension from "@/packages/workit-pi/extensions/workit";
import { launchWorker, type WorkerAssignment } from "@/packages/workit-pi/src/worker";
import { LEAD, cleanup, standingRepo } from "../workit-core/hooks/standing-fixture";

const saved = { ...process.env };
afterEach(() => {
  cleanup();
  for (const key of ["WORKIT_PI_WORKER_SESSION", "WORKIT_SESSION_ID"])
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const assignment: WorkerAssignment = {
  role: "implementer",
  objective: "build slice a",
  scope: { description: "slice a", paths: ["src"], exclusions: [] },
  decisionIds: [],
  requirementIds: [],
  candidateId: null,
  stoppingCondition: "report the result",
};

const toolResult = async (root: string) => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  await extension({
    registerTool: () => undefined,
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
  } as any);
  const ctx = {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pi-worker-b", getCwd: () => root },
  };
  const result = (await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "README.md" },
      content: [{ type: "text", text: "# app" }],
      isError: false,
    },
    ctx,
  )) as { content: Array<{ text: string }> } | undefined;
  return result?.content.map((part) => part.text).join("\n") ?? null;
};

test("Given a worker launched with a 2-call budget, When its tool results return, Then the 2nd and 4th carry the budget line, no other", async () => {
  const { root } = standingRepo();
  const worker = launchWorker(assignment, {
    runtime: { node: "node", cli: "/pi.js", workitExtension: "/workit.js", root },
    workerId: "worker-b",
    sessionId: "pi-worker-b",
    leadSession: LEAD,
    pendingPrompt:
      "GOAL: x\nTIMEBOX: 30 minutes, 2 tool calls; past it without a new commit you will be replaced",
    spawn: () => ({ pid: 41, stdout: null, stderr: null, once: () => undefined, kill: () => true }),
  });
  process.env.WORKIT_PI_WORKER_SESSION = "pi-worker-b";
  process.env.WORKIT_SESSION_ID = worker.spec.env!.WORKIT_SESSION_ID;
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await toolResult(root));
  expect(results[0]).toBeNull();
  expect(results[1]).toContain(
    "Tool-call budget reached (2): commit your work, write your report, stop.",
  );
  expect(results[2]).toBeNull();
  expect(results[3]).toContain("Tool-call budget reached (4)");
  expect(results[4]).toBeNull();
});
