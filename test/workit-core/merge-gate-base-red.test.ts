import { expect, test } from "bun:test";
import { uncoveredBaseRed } from "@/packages/workit-core/src/forge/merge-gate-base-red";
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
