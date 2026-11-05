// Every test file runs with its own process.env, cwd and globals: through
// `--parallel` (which implies `--isolate`) or `--isolate` on serial legs.
// Serial Windows shards once ran without it, so one file's leftover env
// failed later, unrelated files by shard order.
import { expect, test } from "bun:test";
import { CI_LEGS, ciShardArgs, tierArgs } from "@/scripts/test";

const isolated = (args: readonly string[]): boolean =>
  args.some((arg) => arg === "--isolate" || arg.startsWith("--parallel"));

test("Given every CI leg, Then its shards run each file isolated", () => {
  expect(CI_LEGS.length).toBeGreaterThan(0);
  for (const leg of CI_LEGS) {
    const args = ciShardArgs(leg, "1/2");
    expect({ leg, isolated: args ? isolated(args) : null }).toEqual({ leg, isolated: true });
  }
});

test("Given the local tiers, Then files run isolated unless the caller picked a mode", () => {
  expect(isolated(tierArgs("unit", []))).toBe(true);
  expect(isolated(tierArgs("packaging", []))).toBe(true);
  expect(tierArgs("unit", ["--parallel"]).filter((arg) => arg === "--isolate")).toEqual([]);
});

test("Given an unknown leg or a bad shard spec, Then no arguments are built", () => {
  expect(ciShardArgs("solaris", "1/2")).toBeNull();
  expect(ciShardArgs("windows", "one")).toBeNull();
});
