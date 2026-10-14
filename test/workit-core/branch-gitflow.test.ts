import { expect, test } from "bun:test";
import {
  allowedKinds,
  branchKindOf,
  flowMismatch,
  flowRoute,
  suggestBranchName,
  validateBranchNamePolicy,
  type GitFlow,
} from "@/packages/workit-core/src/core/branch";
import { branchGlobPattern } from "@/packages/workit-core/src/core/config";

const GITFLOW_KINDS = ["feature", "bugfix", "hotfix", "release"];
const policy = (globs: string[]) => ({
  allowed: globs.map(branchGlobPattern),
  protected: new Set(["main", "develop"]),
});

test("allowedKinds reads the <kind>/ prefixes of the allowed globs and skips the rest", () => {
  expect(allowedKinds(GITFLOW_KINDS.map((kind) => branchGlobPattern(`${kind}/*`)))).toEqual(
    GITFLOW_KINDS,
  );
  expect(allowedKinds([branchGlobPattern("*"), branchGlobPattern("release/v*")])).toEqual([]);
});

test("suggestBranchName maps habitual prefixes to the closest allowed kind and keeps the slug", () => {
  for (const [name, kinds, suggestion] of [
    ["fix/login", GITFLOW_KINDS, "bugfix/login"],
    ["chore/deps", GITFLOW_KINDS, "feature/deps"],
    ["feat/x", GITFLOW_KINDS, "feature/x"],
    ["hotfixes/y", GITFLOW_KINDS, "hotfix/y"],
    ["featur/z", GITFLOW_KINDS, "feature/z"],
    ["wip-x", GITFLOW_KINDS, "feature/wip-x"],
    // Only kinds the policy allows are suggested.
    ["fix/login", ["feature", "release"], "feature/login"],
    ["chore/a", ["release"], "release/a"],
  ] as const)
    expect(suggestBranchName(name, kinds), name).toBe(suggestion);
  expect(suggestBranchName("x", [])).toBeNull();
});

test("a disallowed prefix names the allowed kinds and the closest name; a policy without kinds keeps the patterns", () => {
  const check = validateBranchNamePolicy(
    "fix/login",
    policy(GITFLOW_KINDS.map((k) => `${k}/*`)),
    "w",
  );
  expect(check).toMatchObject({
    ok: false,
    rule: "allowed_pattern",
    correction:
      'use "bugfix/login"; the allowed kinds are feature/, bugfix/, hotfix/, release/ (workit git branch bugfix/login)',
  });
  const custom = validateBranchNamePolicy("chore/x", policy(["team-*"]), "w");
  expect(custom.ok === false && custom.correction).toBe(
    "choose a branch matching one of: /^team-.*$/i",
  );
  const protectedRef = validateBranchNamePolicy("develop", policy(["feature/*"]), "w");
  expect(protectedRef.ok === false && protectedRef.correction).toContain("allowed kind (feature/)");
});

const FLOW: GitFlow = { develop: "develop", production: "main", developExists: true };

test("git-flow routes: feature, bugfix and release start from develop; release and hotfix land on main and merge back", () => {
  expect(flowRoute(FLOW, "feature")).toEqual({
    kind: "feature",
    base: "develop",
    target: "develop",
    mergeBack: null,
  });
  expect(flowRoute(FLOW, "bugfix")).toMatchObject({ base: "develop", target: "develop" });
  expect(flowRoute(FLOW, "release")).toEqual({
    kind: "release",
    base: "develop",
    target: "main",
    mergeBack: "develop",
  });
  expect(flowRoute(FLOW, "hotfix")).toEqual({
    kind: "hotfix",
    base: "main",
    target: "main",
    mergeBack: "develop",
  });
  expect(branchKindOf("release/4.1.0")).toBe("release");
  expect(branchKindOf("chore/x")).toBeNull();
  expect(branchKindOf("feature")).toBeNull();
});

test("flowMismatch refuses only the other long-lived branch, once develop exists", () => {
  expect(flowMismatch(FLOW, "feature", "main", "base")).toBe(
    "gitflow_base: git-flow starts feature/* from develop, not main",
  );
  expect(flowMismatch(FLOW, "feature", "origin/develop", "base")).toBeNull();
  expect(flowMismatch(FLOW, "hotfix", "refs/remotes/origin/develop", "base")).toContain(
    "starts hotfix/* from main",
  );
  expect(flowMismatch(FLOW, "release", "main", "target")).toBeNull();
  // The back-merge PR (release -> develop) is a valid target.
  expect(flowMismatch(FLOW, "release", "develop", "target")).toBeNull();
  expect(flowMismatch(FLOW, "bugfix", "main", "target")).toContain("lands bugfix/* on develop");
  // Stack parents and unknown kinds are not git-flow's business.
  expect(flowMismatch(FLOW, "feature", "feature/parent", "base")).toBeNull();
  expect(flowMismatch(FLOW, null, "main", "base")).toBeNull();
  expect(flowMismatch({ ...FLOW, developExists: false }, "feature", "main", "base")).toBeNull();
  expect(flowMismatch(null, "feature", "main", "base")).toBeNull();
});
