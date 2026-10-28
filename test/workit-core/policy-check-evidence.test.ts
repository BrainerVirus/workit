import { expect, test } from "bun:test";
import { checkEvidence } from "../../packages/workit-core/src/core/policy/check-evidence";

const HEAD = "a".repeat(40);
const configured = ["test", "lint", "typecheck", "packaging", "check"];
const green = (name: string) => ({ name, head: HEAD, dirty: false, passed: true });

test("G a change that breaks only a packaging suite, T the unit tier alone never completes the evidence", () => {
  const local = ["test", "lint", "typecheck"].map(green);
  const doc = checkEvidence({ lane: "focused", head: HEAD, configured, local, ci: [] });
  expect(doc.needed.map((item) => item.name)).toEqual(["test", "lint", "typecheck", "packaging"]);
  expect(doc.satisfied).toBe(false);
  expect(doc.needed.find((item) => item.name === "packaging")?.status).toBe("missing");
});

test("G a failing local packaging run or red CI, T the evidence is failing, not satisfied", () => {
  const local = [
    ...["test", "lint", "typecheck"].map(green),
    { ...green("packaging"), passed: false },
  ];
  expect(
    checkEvidence({ lane: "full", head: HEAD, configured, local, ci: [] }).needed[3]?.status,
  ).toBe("failing");
  const red = checkEvidence({
    lane: "focused",
    head: HEAD,
    configured,
    local: ["test", "lint", "typecheck"].map(green),
    ci: [{ name: "Packaging tests", state: "failing" }],
  });
  expect(red.satisfied).toBe(false);
  expect(red.needed[3]).toMatchObject({ status: "failing", via: "ci" });
});

test("G a focused lane, T green CI covers a check; a full lane still needs the local run; stale or dirty runs never count", () => {
  const ci = [{ name: "packaging", state: "passing" as const }];
  const local = ["test", "lint", "typecheck"].map(green);
  expect(checkEvidence({ lane: "focused", head: HEAD, configured, local, ci }).satisfied).toBe(
    true,
  );
  expect(checkEvidence({ lane: "full", head: HEAD, configured, local, ci }).satisfied).toBe(false);
  const stale = ["test", "lint", "typecheck", "packaging"].map((name) => ({
    ...green(name),
    head: "b".repeat(40),
  }));
  expect(
    checkEvidence({ lane: "focused", head: HEAD, configured, local: stale, ci: [] }).satisfied,
  ).toBe(false);
  const dirty = ["test", "lint", "typecheck", "packaging"].map((name) => ({
    ...green(name),
    dirty: true,
  }));
  expect(
    checkEvidence({ lane: "full", head: HEAD, configured, local: dirty, ci: [] }).satisfied,
  ).toBe(false);
});

test("G a none or self lane, T no check run is needed", () => {
  for (const lane of ["none", "self"] as const)
    expect(checkEvidence({ lane, head: HEAD, configured, local: [], ci: [] })).toMatchObject({
      needed: [],
      satisfied: true,
    });
});
