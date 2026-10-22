// #320: a standing order the lead adds while workers run reaches each running
// worker's next hooked tool call once per revision; `standing add --stop`
// tells it to stop and report.
import { afterEach, expect, test } from "bun:test";
import { CLAUDE_CODE_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/claude-code";
import { handleHook } from "@/packages/workit-core/src/hooks/handle";
import type { HookDecision, HookInput } from "@/packages/workit-core/src/hooks/protocol";
import { standingPending } from "@/packages/workit-core/src/hooks/standing-signal";
import {
  LEAD,
  addOrder,
  cleanup,
  clearOrder,
  liftStopLine,
  standingRepo,
} from "./standing-fixture";

afterEach(cleanup);

const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };

/** A Claude Code PreToolUse for `ls` from `agentId` (a subagent of LEAD) or the lead itself. */
const lsCall = (cwd: string, agentId: string | null, session = LEAD): HookInput => ({
  host: "claude_code",
  cwd,
  session: { id: session, agentId, agentType: null, parentId: agentId ? session : null },
  permissionMode: "default",
  transcriptPath: null,
  event: { kind: "shell.pre", command: "ls", toolUseId: "t1" },
});

const subagentStart = (cwd: string, agentId: string): HookInput => ({
  ...lsCall(cwd, agentId),
  event: { kind: "subagent.start", agentId, agentType: "workit:implementer", task: null },
});

const text = (decision: HookDecision): string =>
  decision.kind === "context" ? decision.text : `(${decision.kind})`;

test("Given a running worker, When the lead adds a standing order, Then its next tool call carries it once", () => {
  const { root, slice } = standingRepo();
  addOrder(root, "no new dependencies");
  handleHook(subagentStart(root, "agent-1"), deps);
  expect(handleHook(lsCall(slice, "agent-1"), deps)).toEqual({ kind: "none" });

  addOrder(root, "close every browser tab you opened before reporting");
  expect(standingPending(slice, LEAD, "agent-1")).toBe(true);
  const first = text(handleHook(lsCall(slice, "agent-1"), deps));
  expect(first).toContain("new: close every browser tab you opened before reporting");
  expect(first).not.toContain("no new dependencies");
  expect(standingPending(slice, LEAD, "agent-1")).toBe(false);
  expect(handleHook(lsCall(slice, "agent-1"), deps)).toEqual({ kind: "none" });
});

test("Given standing add --stop, When a worker's next hook fires, Then it is told to stop and report; lifting it tells it to resume", () => {
  const { root, slice } = standingRepo();
  handleHook(subagentStart(root, "agent-1"), deps);
  addOrder(root, "", true);
  const stop = text(handleHook(lsCall(slice, "agent-1"), deps));
  expect(stop).toContain("new: STOP:");
  expect(stop).toContain("report to the lead");
  expect(stop).toContain("Stop now");

  liftStopLine(root);
  const lifted = text(handleHook(lsCall(slice, "agent-1"), deps));
  expect(lifted).toContain("no longer in force: STOP:");
  expect(lifted).toContain("the stop is lifted");
});

test("Given a cleared order, When the worker's next hook fires, Then it is told the order no longer applies", () => {
  const { root, slice } = standingRepo();
  const id = addOrder(root, "run the e2e suite before reporting");
  handleHook(subagentStart(root, "agent-1"), deps);
  clearOrder(root, id);
  expect(text(handleHook(lsCall(slice, "agent-1"), deps))).toContain(
    "no longer in force: run the e2e suite before reporting",
  );
});

test("Given the lead itself or a session outside the fanout, When their tool call runs, Then no standing delta is added", () => {
  const { root } = standingRepo();
  addOrder(root, "no new dependencies");
  expect(handleHook(lsCall(root, null), deps)).toEqual({ kind: "none" });
  expect(handleHook(lsCall(root, null, "someone-else"), deps)).toEqual({ kind: "none" });
});

test("Given a separate session on a slice branch, When it first calls a tool, Then it gets every order in force once", () => {
  const { root, slice } = standingRepo();
  addOrder(root, "no new dependencies");
  const first = text(handleHook(lsCall(slice, null, "worker-session"), deps));
  expect(first).toContain("new: no new dependencies");
  expect(handleHook(lsCall(slice, null, "worker-session"), deps)).toEqual({ kind: "none" });
});

test("Given a pending delta, When the worker's call is denied, Then the delta waits for the next call that runs", () => {
  const { root, slice } = standingRepo();
  handleHook(subagentStart(root, "agent-1"), deps);
  addOrder(root, "no new dependencies");
  const denied = handleHook(
    {
      ...lsCall(slice, "agent-1"),
      event: { kind: "shell.pre", command: "git push --force origin main", toolUseId: "t2" },
    },
    deps,
  );
  expect(denied.kind).toBe("deny");
  expect(text(handleHook(lsCall(slice, "agent-1"), deps))).toContain("new: no new dependencies");
});
