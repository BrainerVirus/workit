// Retro P9 on OpenCode: a lead's `subagent` call whose prompt names `N tool
// calls` budgets the child; from its Nth call the line stands in the child's
// `<workit-standing>` system part.
import { afterEach, expect, test } from "bun:test";
import { observeBudget } from "@/packages/workit-opencode/src/v2/budget";
import { injectAgentContext, type SystemPart } from "@/packages/workit-opencode/src/v2/injection";
import { LEAD, cleanup, standingRepo } from "../workit-core/hooks/standing-fixture";

afterEach(cleanup);

const standingPart = (root: string, child: string) => {
  const system: SystemPart[] = [];
  injectAgentContext(root, { id: child, parentID: LEAD, directory: root }, new Map(), system);
  const part = system.find(
    (item) => typeof item.text === "string" && item.text.startsWith("<workit-standing>"),
  );
  return typeof part?.text === "string" ? part.text : null;
};

test("Given a child spawned with a 3-call budget, When it makes its 3rd call, Then its system context carries the budget line from then on", () => {
  const { root } = standingRepo();
  const children = new Map([["child-b", LEAD]]);
  observeBudget(
    root,
    {
      tool: "subagent",
      sessionID: LEAD,
      input: {
        prompt: "GOAL: x\nTIMEBOX: 30 minutes, 3 tool calls; past it …",
        subagent_type: "general",
      },
    },
    new Map(),
  );
  const read = { tool: "read", sessionID: "child-b", input: {} };
  observeBudget(root, read, children);
  observeBudget(root, read, children);
  expect(standingPart(root, "child-b")).toBeNull();
  observeBudget(root, read, children);
  const line = standingPart(root, "child-b");
  expect(line).toContain(
    "Tool-call budget reached (3): commit your work, write your report, stop.",
  );
  expect(standingPart(root, "child-b")).toBe(line);
});

test("Given a child spawned without a budget, When it calls tools, Then no budget line appears", () => {
  const { root } = standingRepo();
  const children = new Map([["child-c", LEAD]]);
  observeBudget(root, { tool: "subagent", sessionID: LEAD, input: { prompt: "do x" } }, new Map());
  for (let i = 0; i < 4; i++)
    observeBudget(root, { tool: "read", sessionID: "child-c", input: {} }, children);
  expect(standingPart(root, "child-c")).toBeNull();
});
