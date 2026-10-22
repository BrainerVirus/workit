// #320 on Pi: tool_call cannot add context, so a standing-order change rides
// the worker's next tool result, once per revision. A supervised worker is
// seeded at launch with the orders its brief carries.
import { afterEach, expect, test } from "bun:test";
import extension from "@/packages/workit-pi/extensions/workit";
import { launchWorker, type WorkerAssignment } from "@/packages/workit-pi/src/worker";
import { LEAD, addOrder, cleanup, standingRepo } from "../workit-core/hooks/standing-fixture";

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
    sessionManager: { getSessionId: () => "pi-worker-1", getCwd: () => root },
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

test("Given a supervised worker launched under the lead, When the lead adds a standing order, Then its next tool result carries only that order, once", async () => {
  const { root } = standingRepo();
  addOrder(root, "no new dependencies");
  const worker = launchWorker(assignment, {
    runtime: { node: "node", cli: "/pi.js", workitExtension: "/workit.js", root },
    workerId: "worker-1",
    sessionId: "pi-worker-1",
    leadSession: LEAD,
    spawn: () => ({ pid: 41, stdout: null, stderr: null, once: () => undefined, kill: () => true }),
  });
  process.env.WORKIT_PI_WORKER_SESSION = "pi-worker-1";
  process.env.WORKIT_SESSION_ID = worker.spec.env!.WORKIT_SESSION_ID;
  expect(await toolResult(root)).toBeNull();

  addOrder(root, "stop your dev server before reporting");
  const next = await toolResult(root);
  expect(next).toContain("# app");
  expect(next).toContain("new: stop your dev server before reporting");
  expect(next).not.toContain("no new dependencies");
  expect(await toolResult(root)).toBeNull();
});

test("Given standing add --stop, When the worker's next tool result returns, Then it is told to stop and report", async () => {
  const { root } = standingRepo();
  process.env.WORKIT_PI_WORKER_SESSION = "pi-worker-2";
  process.env.WORKIT_SESSION_ID = `${LEAD}:pi-worker-2`;
  addOrder(root, "", true);
  expect(await toolResult(root)).toContain("Stop now");
});
