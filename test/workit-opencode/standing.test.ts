// #320 on OpenCode: a child's system context is rebuilt every model call, so a
// standing order the lead adds after the child started stands in its
// `<workit-standing>` part on each call; orders its brief already carried do not.
import { afterEach, expect, test } from "bun:test";
import { injectAgentContext, type SystemPart } from "@/packages/workit-opencode/src/v2/injection";
import {
  LEAD,
  addOrder,
  cleanup,
  liftStopLine,
  standingRepo,
} from "../workit-core/hooks/standing-fixture";

afterEach(cleanup);

const standingPart = (root: string, child: string, parentID: string | undefined = LEAD) => {
  const system: SystemPart[] = [];
  injectAgentContext(root, { id: child, parentID, directory: root }, new Map(), system);
  const part = system.find(
    (item) => typeof item.text === "string" && item.text.startsWith("<workit-standing>"),
  );
  return typeof part?.text === "string" ? part.text : null;
};

test("Given a running child, When the lead adds a standing order, Then each later model call carries it and the brief's orders are not repeated", () => {
  const { root } = standingRepo();
  addOrder(root, "no new dependencies");
  expect(standingPart(root, "child-1")).toBeNull();
  addOrder(root, "close every browser tab you opened before reporting");
  const next = standingPart(root, "child-1");
  expect(next).toContain("new: close every browser tab you opened before reporting");
  expect(next).not.toContain("no new dependencies");
  expect(standingPart(root, "child-1")).toBe(next);
});

test("Given standing add --stop, When the child's next model call runs, Then it is told to stop and report; the lead's own session never is", () => {
  const { root } = standingRepo();
  expect(standingPart(root, "child-1")).toBeNull();
  addOrder(root, "", true);
  expect(standingPart(root, "child-1")).toContain("Stop now");
  expect(standingPart(root, LEAD, undefined)).toBeNull();
  liftStopLine(root);
  expect(standingPart(root, "child-1")).toBeNull();
});
