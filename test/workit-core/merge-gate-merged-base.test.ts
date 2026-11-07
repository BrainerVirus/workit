import { expect, test } from "bun:test";
import {
  landedBaseGuard,
  landedBranch,
} from "@/packages/workit-core/src/forge/merge-gate-merged-base";
import type { ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import {
  failure,
  success,
  type ForgePrStatus,
  type PrRef,
} from "@/packages/workit-core/src/forge/types";

// #752: the merge gate reads a base as landed only when its own PR merged
// into another branch and the base has not moved since; a live or
// long-lived base, or a failed read, never refuses.

type Pr = { number: number; branch: string; base: string; state: PrRef["state"]; head: string };

const resolvedWith = (prs: Pr[], baseTips: Record<string, string>, broken = false) =>
  ({
    fork: false,
    headRepo: "o/r",
    headProjectId: null,
    forge: {
      kind: "github",
      repo: "o/r",
      findPr: (head: string) => {
        if (broken) return failure("failed", "HTTP 502");
        const mine = prs.filter((pr) => pr.branch === head).toSorted((a, b) => b.number - a.number);
        const pick = mine.find((pr) => pr.state === "open") ?? mine[0];
        return success(
          pick
            ? {
                number: pick.number,
                url: "",
                state: pick.state,
                headBranch: pick.branch,
                headSha: pick.head,
              }
            : null,
        );
      },
      prStatus: (number: number) => {
        const pr = prs.find((candidate) => candidate.number === number);
        if (!pr) return failure("not_found", `no PR ${number}`);
        return success({
          number,
          state: pr.state,
          base: pr.base,
          baseSha: baseTips[pr.base] ?? null,
          head: { branch: pr.branch, sha: pr.head },
        } as ForgePrStatus);
      },
    },
  }) as unknown as ResolvedForge;

/** What `pr merge` sees: its first read of PR `number` through the guard. */
const gate = (resolved: ResolvedForge, number: number) => {
  const guard = landedBaseGuard(resolved.forge, resolved);
  return { read: guard.forge.prStatus(number), refusal: guard.refusal() };
};

const A_MERGED: Pr = { number: 11, branch: "feature/a", base: "main", state: "merged", head: "a1" };
const B_OPEN: Pr = {
  number: 12,
  branch: "feature/b",
  base: "feature/a",
  state: "open",
  head: "b1",
};

test("Given feature/a squash-merged into main at a1 and still at a1, When PR 12 into feature/a is gated, Then it is refused as base_landed with the retarget command", () => {
  const { read, refusal } = gate(resolvedWith([A_MERGED, B_OPEN], { "feature/a": "a1" }), 12);
  expect(read).toMatchObject({ ok: false, code: "blocked" });
  expect(refusal?.data).toEqual({
    reason: "base_landed",
    pr: 12,
    base: "feature/a",
    landedOn: "main",
    landedPr: 11,
  });
  expect(refusal?.unblock).toStartWith("workit pr edit --pr 12 --base main");
});

test("Given feature/a moved to a2 after its PR merged at a1, When PR 12 is gated, Then the base is live and nothing is refused", () => {
  expect(gate(resolvedWith([A_MERGED, B_OPEN], { "feature/a": "a2" }), 12).refusal).toBeNull();
});

test("Given feature/a has a newer open PR besides the merged one, When it is read, Then it has not landed", () => {
  const reopened: Pr = { ...A_MERGED, number: 13, state: "open" };
  expect(landedBranch(resolvedWith([A_MERGED, reopened], {}), "feature/a")).toEqual(success(null));
});

test("Given develop merged into main through a PR, When a PR into develop is gated, Then a long-lived branch never reads as landed", () => {
  const release: Pr = { number: 20, branch: "develop", base: "main", state: "merged", head: "d1" };
  const feature: Pr = {
    number: 21,
    branch: "feature/x",
    base: "develop",
    state: "open",
    head: "x1",
  };
  expect(gate(resolvedWith([release, feature], { develop: "d1" }), 21).refusal).toBeNull();
});

test("Given the PR lookup fails, When PR 12 is gated, Then the gate does not refuse (the merge gate reads the PR again)", () => {
  expect(
    gate(resolvedWith([A_MERGED, B_OPEN], { "feature/a": "a1" }, true), 12).refusal,
  ).toBeNull();
});
