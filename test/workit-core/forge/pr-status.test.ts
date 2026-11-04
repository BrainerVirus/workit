import { expect, test } from "bun:test";
import { rollupForHead } from "@/packages/workit-core/src/forge/pr-status";
import { fixture } from "@/test/shared/helpers/forge-replay";
import { GH_STATUS, githubRoutes, statusOf, useForgeHarness } from "./shared";

// #646 root (W2.19): `commits(last: 1)` can describe an older commit than the
// PR head for a moment after a push. Its rollup is that commit's result, so
// pr status must not read it as the current head's success or pending.

const { repoFor } = useForgeHarness();

const OLD = "0123456789abcdef0123456789abcdef01234567";

/** The passing PR fixture with its rollup moved to an older commit than the head. */
const staleRollup = (): string => {
  const raw = fixture("github/pr-passing.json");
  const marker = /("commit": \{\s*"oid": )"\{\{HEAD\}\}"/u;
  expect(raw).toMatch(marker);
  return raw.replace(marker, `$1"${OLD}"`);
};

test("Given a rollup for an older commit, When pr status reads it, Then the old run's result is not reported as the head's", () => {
  const repo = repoFor("github");
  const routes = githubRoutes("github/pr-passing.json");
  const fresh = statusOf(repo, routes, 12);
  // The control: the same rollup on the head reads as passing.
  expect(fresh.checks.state).toBe("passing");
  expect(fresh.checks.passing).toBeGreaterThan(0);

  routes[GH_STATUS] = staleRollup();
  const stale = statusOf(repo, routes, 12);
  expect(stale.head.sha).not.toBe(OLD);
  expect(stale.checks.state).not.toBe("passing");
  expect(stale.checks.passing).toBe(0);
  // No old run is listed as running on the head; the head waits on its own
  // required checks, which have not reported yet.
  expect(stale.checks.pending).toEqual([]);
  expect(stale.checks.missingRequired?.length ?? 0).toBeGreaterThan(0);
});

test("rollupForHead keeps the head's rollup and drops another commit's", () => {
  const rollup = { state: "SUCCESS" };
  expect(rollupForHead({ oid: "a1", statusCheckRollup: rollup }, "a1")).toBe(rollup);
  expect(rollupForHead({ oid: "b2", statusCheckRollup: rollup }, "a1")).toBeNull();
  expect(rollupForHead(undefined, "a1")).toBeNull();
});
