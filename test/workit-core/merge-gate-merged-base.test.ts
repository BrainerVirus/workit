import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  landedBaseGuard,
  landedBranch,
  shortLivedBranch,
} from "@/packages/workit-core/src/forge/merge-gate-merged-base";
import { writeStack } from "@/packages/workit-core/src/stack";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import type { ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import {
  failure,
  success,
  type ForgePrStatus,
  type PrRef,
} from "@/packages/workit-core/src/forge/types";

// #752: the merge gate reads a base as landed only when it is short-lived (a
// stack branch or a work branch), its own PR merged into another branch and
// the base has not moved since; a live or long-lived base (staging after a
// promotion, develop, release/*), an unknown base tip or a failed read never
// refuses.

let configHome: ConfigHome;
let cwd = "";
beforeAll(() => {
  configHome = useConfigHome("wk-landed-base-");
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  cwd = mkdtempSync(path.join(os.tmpdir(), "wk-landed-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
});
afterAll(() => {
  configHome.restore();
  rmSync(cwd, { recursive: true, force: true });
});

type Pr = { number: number; branch: string; base: string; state: PrRef["state"]; head: string };

const resolvedWith = (
  prs: Pr[],
  baseTips: Record<string, string>,
  broken = false,
  ambiguous: readonly string[] = [],
) =>
  ({
    fork: false,
    headRepo: "o/r",
    headProjectId: null,
    forge: {
      kind: "github",
      repo: "o/r",
      findPr: (head: string) => {
        if (broken) return failure("failed", "HTTP 502");
        if (ambiguous.includes(head))
          return failure(
            "blocked",
            `ambiguous_pr: ${head} has open pull requests #40 -> main, #41 -> develop`,
          );
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
  const guard = landedBaseGuard(resolved.forge, resolved, cwd);
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
  expect(landedBranch(cwd, resolvedWith([A_MERGED, reopened], {}), "feature/a")).toEqual(
    success(null),
  );
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

test("Given staging was promoted to main through PR 30 and is untouched since, When a feature PR into staging is gated, Then staging is long-lived and nothing is refused", () => {
  const promotion: Pr = {
    number: 30,
    branch: "staging",
    base: "main",
    state: "merged",
    head: "s1",
  };
  const feature: Pr = {
    number: 31,
    branch: "feature/y",
    base: "staging",
    state: "open",
    head: "y1",
  };
  expect(gate(resolvedWith([promotion, feature], { staging: "s1" }), 31).refusal).toBeNull();
});

test("Given the forge could not read the base tip (baseSha null), When PR 12 into the landed feature/a is gated, Then nothing is refused", () => {
  expect(gate(resolvedWith([A_MERGED, B_OPEN], {}), 12).refusal).toBeNull();
});

test("Given feature/a has open PRs into two bases (ambiguous_pr), When it is read, Then it has not landed", () => {
  expect(
    landedBranch(cwd, resolvedWith([A_MERGED], {}, false, ["feature/a"]), "feature/a"),
  ).toEqual(success(null));
});

test("Given long-lived and release bases, When they are classified, Then only work branches and stack branches are short-lived, and a long-lived base asks the forge nothing", () => {
  for (const branch of [
    "main",
    "develop",
    "staging",
    "dev",
    "next",
    "qa",
    "release/1.0",
    "hotfix/1.0.1",
  ])
    expect([branch, shortLivedBranch(cwd, branch)]).toEqual([branch, false]);
  for (const branch of ["feature/a", "fix/b", "chore/c", "docs/d", "bugfix/e"])
    expect([branch, shortLivedBranch(cwd, branch)]).toEqual([branch, true]);
  const silent = {
    fork: false,
    headProjectId: null,
    forge: {
      kind: "github",
      repo: "o/r",
      findPr: () => {
        throw new Error("the forge was asked");
      },
    },
  } as unknown as ResolvedForge;
  expect(landedBranch(cwd, silent, "release/1.0")).toEqual(success(null));
});

test("Given a branch recorded in a workit stack, When it is classified, Then it is short-lived whatever its name", () => {
  expect(shortLivedBranch(cwd, "wave-a")).toBe(false);
  const written = writeStack(cwd, {
    v: 1,
    name: "wave",
    trunk: "main",
    forge: null,
    repo: null,
    branches: ["wave-a", "wave-b"].map((branch, index) => ({
      branch,
      parent: index === 0 ? "main" : "wave-a",
      pr: null,
      lastHead: null,
      lastParentHead: null,
      patchId: null,
      merged: null,
    })),
    updatedAt: "",
  });
  expect(written.ok).toBe(true);
  expect(shortLivedBranch(cwd, "wave-a")).toBe(true);
});
