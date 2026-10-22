import { expect, test } from "bun:test";
import { productDecision, type LedgerView } from "@/packages/workit-core/src/core/policy/derive";
import { summarizeRow, rowLabels, type ReadRow } from "@/packages/workit-core/src/ledger";
import type { TaskRecord } from "@/packages/workit-core/src/core/task-contract";

const row = (extra: Record<string, unknown>): ReadRow =>
  ({
    v: 1,
    id: "r1",
    at: "2030-01-02T00:00:00.000Z",
    type: "decision",
    actor: { host: "h", session: "s", agentId: null },
    branch: "feature/x",
    seq: 1,
    superseded: false,
    supersedeIgnored: false,
    what: "pick B",
    why: "reversible",
    ...extra,
  }) as unknown as ReadRow;

const view = (rows: ReadRow[]): LedgerView => ({ branch: () => "feature/x", rows: () => rows });
const task = { createdAt: "2030-01-01T00:00:00.000Z", decisions: [] } as unknown as TaskRecord;

test("given an open product choice, when only a decider decision exists, then the choice stays open", () => {
  expect(productDecision(task, view([row({ by: "decider" })])).met).toBe(false);
});

test("given an open product choice, when the user's ledger decision exists beside a decider's, then the choice is met by it", () => {
  const status = productDecision(
    task,
    view([row({ id: "user" }), row({ id: "d", by: "decider" })]),
  );
  expect(status.met).toBe(true);
});

test("given a decider decision with views, when summarized, then it is labelled and shows each view", () => {
  const decider = row({ by: "decider", views: ["a: on", "b: off"] });
  expect(rowLabels(decider)).toContain("decider");
  expect(summarizeRow(decider).summary).toBe(
    "[decider] pick B (why: reversible; views: a: on | b: off)",
  );
  expect(rowLabels(row({}))).not.toContain("decider");
});
