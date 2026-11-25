import { expect, test } from "bun:test";
import {
  classifyBaseRed,
  uncoveredBaseRed,
} from "@/packages/workit-core/src/forge/merge-gate-base-red";
import { success } from "@/packages/workit-core/src/forge/types";
import type { ForgeCheck } from "@/packages/workit-core/src/forge/types";

const check = (name: string, state: ForgeCheck["state"]): ForgeCheck => ({
  name,
  context: name.split(" / ").pop() ?? name,
  state,
  conclusion: state === "failing" ? "failure" : state === "passing" ? "success" : null,
  url: null,
  runId: 1,
  jobId: 1,
  scope: null,
  required: true,
});

const names = (checks: readonly ForgeCheck[]) => checks.map((item) => item.name);

const RED = check("CI / test (windows-latest)", "failing");

test("Given main red on a check the head passes under the same name, Then nothing is left uncovered", () => {
  expect(uncoveredBaseRed([RED], [check("CI / test (windows-latest)", "passing")])).toEqual([]);
});

test("Given main red on a check the head lacks, Then that check is uncovered", () => {
  expect(names(uncoveredBaseRed([RED], [check("CI / fast checks", "passing")]))).toEqual([
    RED.name,
  ]);
});

test("Given main red on a check the head fails, Then that check is uncovered", () => {
  expect(names(uncoveredBaseRed([RED], [check("CI / test (windows-latest)", "failing")]))).toEqual([
    RED.name,
  ]);
});

test("Given main red on a check the head runs in another workflow, Then the job name alone does not cover it", () => {
  expect(names(uncoveredBaseRed([RED], [check("PR / test (windows-latest)", "passing")]))).toEqual([
    RED.name,
  ]);
});

test("Given a head that ran the check twice and one run failed, Then the check is uncovered", () => {
  const head = [
    check("CI / test (windows-latest)", "passing"),
    check("CI / test (windows-latest)", "failing"),
  ];
  expect(names(uncoveredBaseRed([RED], head))).toEqual([RED.name]);
});

test("Given a head whose run of the check is still pending, Then the check is uncovered", () => {
  expect(names(uncoveredBaseRed([RED], [check("CI / test (windows-latest)", "pending")]))).toEqual([
    RED.name,
  ]);
});

test("Given main red on two checks and the head passes only one, Then only the other is uncovered", () => {
  const shard = check("CI / windows shard", "failing");
  expect(
    names(uncoveredBaseRed([RED, shard], [check("CI / test (windows-latest)", "passing")])),
  ).toEqual([shard.name]);
});

// #920: on GitHub the workflow id, not the display name alone, decides coverage.
const inWorkflow = (item: ForgeCheck, workflow: number | null): ForgeCheck => ({
  ...item,
  workflow,
});
const RED_CI = inWorkflow(RED, 11);

test("Given main red in workflow CI and the head passes the job only in a second workflow also named CI, Then the decoy does not cover it", () => {
  const decoy = inWorkflow(check("CI / test (windows-latest)", "passing"), 99);
  expect(names(uncoveredBaseRed([RED_CI], [decoy]))).toEqual([RED.name]);
});

test("Given the head's real CI run fails the job and a same-named second workflow passes it, Then the check is uncovered", () => {
  const head = [
    inWorkflow(check("CI / test (windows-latest)", "failing"), 11),
    inWorkflow(check("CI / test (windows-latest)", "passing"), 99),
  ];
  expect(names(uncoveredBaseRed([RED_CI], head))).toEqual([RED.name]);
});

test("Given the head passes the job in the same workflow as the base, Then it is covered", () => {
  const head = [inWorkflow(check("CI / test (windows-latest)", "passing"), 11)];
  expect(uncoveredBaseRed([RED_CI], head)).toEqual([]);
});

test("Given a head run whose workflow could not be read, Then the check fails closed", () => {
  const head = [inWorkflow(check("CI / test (windows-latest)", "passing"), null)];
  expect(names(uncoveredBaseRed([RED_CI], head))).toEqual([RED.name]);
});

test("Given a base run whose workflow could not be read, Then the check fails closed", () => {
  const head = [inWorkflow(check("CI / test (windows-latest)", "passing"), null)];
  expect(names(uncoveredBaseRed([inWorkflow(RED, null)], head))).toEqual([RED.name]);
});

// #928: the flaky/broken hint reads the previous base run keyed by workflow too.
const previousRun = (checks: ForgeCheck[]) =>
  success({ sha: "0".repeat(40), checks, protected: true, requiredKnown: true });

test("Given two workflows sharing a job name and the base's workflow passed it on the previous run, Then classifyBaseRed calls it flaky from that workflow's run", () => {
  const previous = previousRun([
    inWorkflow(check("CI / test (windows-latest)", "passing"), 11),
    inWorkflow(check("CI / test (windows-latest)", "failing"), 99),
  ]);
  expect(classifyBaseRed([RED_CI], previous)).toEqual({ kind: "flaky", checks: [RED_CI] });
});

test("Given two workflows sharing a job name and the base's workflow failed it on the previous run, Then classifyBaseRed calls it broken from that workflow's run", () => {
  const previous = previousRun([
    inWorkflow(check("CI / test (windows-latest)", "failing"), 11),
    inWorkflow(check("CI / test (windows-latest)", "passing"), 99),
  ]);
  expect(classifyBaseRed([RED_CI], previous)).toEqual({ kind: "broken", checks: [RED_CI] });
});

test("Given only a second workflow with the same job name ran on the previous base commit, Then classifyBaseRed cannot tell a flake apart", () => {
  const previous = previousRun([inWorkflow(check("CI / test (windows-latest)", "passing"), 99)]);
  expect(classifyBaseRed([RED_CI], previous)).toMatchObject({ kind: "unknown" });
});
