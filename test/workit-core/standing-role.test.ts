// #710 nit: standing orders reach a subagent of the lead only when its type is
// a Workit worker or judge spelled its host's way, the same rule workitRole
// applies, so the orders and the role steering never disagree.
import { afterEach, expect, test } from "bun:test";
import { CLAUDE_CODE_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/claude-code";
import { CURSOR_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { handleHook } from "@/packages/workit-core/src/hooks/handle";
import type { HookDecision, HookInput, HostId } from "@/packages/workit-core/src/hooks/protocol";
import { workitRole } from "@/packages/workit-core/src/hooks/steering";
import { LEAD, addOrder, cleanup, standingRepo } from "./hooks/standing-fixture";

afterEach(cleanup);

const call = (cwd: string, host: HostId, agentId: string, agentType: string): HookInput => ({
  host,
  cwd,
  session: { id: LEAD, agentId, agentType, parentId: LEAD },
  permissionMode: "default",
  transcriptPath: null,
  event: { kind: "shell.pre", command: "ls", toolUseId: "t1" },
});

const gotOrder = (decision: HookDecision): boolean =>
  decision.kind === "context" && decision.text.includes("new: no new dependencies");

test("Given WORKER_TYPE 'workit-implementer' on Claude Code, When it calls a tool, Then it gets no standing order, as workitRole names it no Workit role", () => {
  const { root } = standingRepo();
  addOrder(root, "no new dependencies");
  const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };
  for (const agentType of ["workit-implementer", "workit:implementer"]) {
    const role = workitRole(CLAUDE_CODE_DESCRIPTOR, agentType);
    const decision = handleHook(call(root, "claude_code", `a-${agentType}`, agentType), deps);
    expect(gotOrder(decision), agentType).toBe(role !== null);
  }
  expect(workitRole(CLAUDE_CODE_DESCRIPTOR, "workit-implementer")).toBeNull();
});

test("Given a host that names agents with a dash, When 'workit-implementer' calls a tool, Then it gets the standing order, as workitRole names it an implementer", () => {
  const { root } = standingRepo();
  addOrder(root, "no new dependencies");
  const deps = { descriptor: CURSOR_DESCRIPTOR, addendum: null };
  expect(workitRole(CURSOR_DESCRIPTOR, "workit-implementer")).toBe("implementer");
  expect(gotOrder(handleHook(call(root, "cursor", "c-1", "workit-implementer"), deps))).toBe(true);
  expect(gotOrder(handleHook(call(root, "cursor", "c-2", "workit:implementer"), deps))).toBe(false);
});
