import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LANE_THRESHOLDS,
  branchLane,
  changedFiles,
  computeLane,
  isRiskPath,
  laneGate,
  type ChangedFile,
  type LaneInput,
} from "@/packages/workit-core/src/core/policy/lane";

// #333 review lanes: none / self / focused / full, computed from the diff.

const file = (name: string, lines = 1, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path: name,
  added: lines,
  deleted: 0,
  ...extra,
});
const lane = (files: ChangedFile[], extra: Omit<LaneInput, "files"> = {}) =>
  computeLane({ files, ...extra }).lane;

test("none: docs, comment or formatting-only files and generated copies need no review", () => {
  expect(lane([file("README.md", 40), file("docs/guide/verification.md", 300)])).toBe("none");
  expect(lane([file("src/a.ts", 3, { cosmetic: true })])).toBe("none");
  expect(lane([file("packages/x/skills/a/SKILL.md", 5, { generated: true })])).toBe("none");
  expect(lane([file("src/api.generated.ts", 900)])).toBe("none");
  expect(lane([])).toBe("none");
});

test("self: a small behavior change off risk paths; agent instructions and lockfiles are behavior", () => {
  expect(lane([file("src/a.ts", 3), file("test/a.test.ts", 20)])).toBe("self");
  expect(lane([file("packages/core/skills/review/SKILL.md", 4)])).toBe("self");
  expect(lane([file("AGENTS.md", 2)])).toBe("self");
  // A lockfile changes what runs; its size never counts.
  expect(lane([file("bun.lock", 4000)])).toBe("self");
  // A binary asset is a change even with no line counts.
  expect(lane([file("assets/logo.png", 0, { binary: true })])).toBe("self");
});

test("a recorded judgment only raises: high risk lifts anything to full; normal or trivial risk never lowers", () => {
  expect(lane([file("README.md")], { riskTier: "high" })).toBe("full");
  expect(lane([file("src/a.ts", 2)], { riskTier: "trivial" })).toBe("self");
  expect(lane([file("src/hooks/a.ts", 2)], { riskTier: "normal" })).toBe("full");
});

test("focused: more than selfMaxLines lines or selfMaxFiles behavior files", () => {
  const { selfMaxLines, selfMaxFiles, fullMinLines } = LANE_THRESHOLDS;
  expect(lane([file("src/a.ts", selfMaxLines)])).toBe("self");
  expect(lane([file("src/a.ts", selfMaxLines + 1)])).toBe("focused");
  expect(
    lane(Array.from({ length: selfMaxFiles + 1 }, (_, index) => file(`src/f${index}.ts`))),
  ).toBe("focused");
  expect(lane([file("src/a.ts", fullMinLines - 1)])).toBe("focused");
  // Docs lines never count toward size.
  expect(lane([file("src/a.ts", 2), file("docs/big.md", 5000)])).toBe("self");
});

test("full: a large diff or any behavior file on a risk path", () => {
  expect(lane([file("src/a.ts", LANE_THRESHOLDS.fullMinLines)])).toBe("full");
  const assessed = computeLane({ files: [file("src/a.ts"), file("src/hooks/stop.ts", 2)] });
  expect(assessed).toMatchObject({ lane: "full", riskFiles: ["src/hooks/stop.ts"] });
  expect(assessed.reasons[0]).toContain("risk path: src/hooks/stop.ts");
});

test("risk paths: gates, hooks, auth, release, migrations and CI; never tests or docs", () => {
  for (const risky of [
    "packages/core/src/core/policy/derive.ts",
    "src/hooks/stop.ts",
    "src/auth/session.ts",
    "src/oauth-client.ts",
    "app/auth.service.ts",
    "packages/cli/src/verbs/release.ts",
    "db/migrations/0001_init.sql",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    "src/merge-gate.ts",
  ])
    expect(isRiskPath(risky)).toBe(true);
  for (const plain of [
    "src/author.ts",
    "src/feature.ts",
    "test/workit-core/hooks/stop.test.ts",
    "src/hooks/stop.test.ts",
  ])
    expect(isRiskPath(plain)).toBe(false);
  expect(lane([file("docs/agents/release.md", 3)])).toBe("none");
  expect(lane([file("test/hooks/stop.test.ts", 3)])).toBe("self");
});

test("configured risk paths only tighten: a matching glob makes the lane full", () => {
  expect(lane([file("db/schema/0002.sql", 2)])).toBe("self");
  expect(lane([file("db/schema/0002.sql", 2)], { riskPaths: ["db/schema/**"] })).toBe("full");
  expect(lane([file("src/billing/charge.ts", 2)], { riskPaths: ["src/billing"] })).toBe("full");
});

// laneGate: what each lane asks of the ledger.

const verdict = (id: string) => ({ id }) as never;
const check = (
  accepted: string | null,
  self: string | null,
  reasons: string[] = accepted ? [] : ["no_verdict"],
) =>
  ({
    accepted: {
      accepted: accepted !== null,
      verdict: accepted ? verdict(accepted) : null,
      reasons,
    },
    selfVerdict: self ? verdict(self) : null,
  }) as never;

test("laneGate under proportional: none needs nothing, self takes the author's own, focused and full need a non-author verdict", () => {
  expect(laneGate(check(null, null), "proportional", { lane: "none" })).toMatchObject({
    need: "none",
    satisfied: true,
    verdictId: null,
  });
  expect(laneGate(check(null, "v-self"), "proportional", { lane: "self" })).toMatchObject({
    need: "self",
    satisfied: true,
    verdictId: "v-self",
    review: "self-reviewed",
  });
  expect(laneGate(check(null, null), "proportional", { lane: "self" }).satisfied).toBe(false);
  for (const name of ["focused", "full"] as const) {
    expect(laneGate(check(null, "v-self"), "proportional", { lane: name })).toMatchObject({
      need: "non-author",
      satisfied: false,
    });
    expect(laneGate(check("v-ind", null), "proportional", { lane: name })).toMatchObject({
      satisfied: true,
      verdictId: "v-ind",
      review: "verified",
    });
  }
});

test("laneGate: a current independent failure or a tampered ledger blocks every lane, even none", () => {
  expect(
    laneGate(check(null, null, ["failing_verdict"]), "proportional", { lane: "none" }).satisfied,
  ).toBe(false);
  expect(
    laneGate(check(null, null, ["ledger_tampered"]), "proportional", { lane: "none" }).satisfied,
  ).toBe(false);
});

test("laneGate under self or independent ignores the lane: an accepted non-author verdict, as before", () => {
  for (const mode of ["self", "independent"] as const) {
    expect(laneGate(check(null, null), mode, { lane: "none" })).toMatchObject({
      need: "non-author",
      satisfied: false,
    });
    expect(laneGate(check(null, "v-self"), mode, { lane: "self" }).satisfied).toBe(false);
    expect(laneGate(check("v-ind", null), mode, { lane: "full" }).satisfied).toBe(true);
  }
});

// The diff read from git.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};
const write = (root: string, name: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), text);
};
const repoWith = (base: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-lane-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(base)) write(root, name, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "switch", "-q", "-c", "feature/x");
  return root;
};
const commitAll = (root: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return git(root, "rev-parse", "HEAD");
};

test("from git: whitespace-only and comment-only edits are cosmetic, a code edit is not", () => {
  const root = repoWith({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "// old note\nexport const b = 2;\n",
    "src/c.py": "x = 1\n",
    "src/d.ts": "export const d = 4;\n",
  });
  write(root, "src/a.ts", "export const a  =  1;\n\n");
  write(root, "src/b.ts", "// a new, longer note\n/* and a block */\nexport const b = 2;\n");
  write(root, "src/c.py", "# why x\nx = 1\n");
  write(root, "src/d.ts", "export const d = 5;\n");
  const head = commitAll(root);
  const files = changedFiles(root, "main", head) ?? [];
  const cosmetic = Object.fromEntries(files.map((entry) => [entry.path, entry.cosmetic]));
  expect(cosmetic).toEqual({
    "src/a.ts": true,
    "src/b.ts": true,
    "src/c.py": true,
    "src/d.ts": false,
  });
  expect(branchLane(root, { base: "main", head })).toMatchObject({ lane: "self", files: 1 });
});

test("from git: .gitattributes linguist-generated marks generated copies; the working tree counts untracked files", () => {
  const root = repoWith({
    ".gitattributes": "copies/** linguist-generated\n",
    "copies/a.ts": "export const a = 1;\n",
  });
  write(root, "copies/a.ts", "export const a = 2;\n");
  const head = commitAll(root);
  expect(branchLane(root, { base: "main", head }).lane).toBe("none");
  write(root, "src/new.ts", "export const n = 1;\n");
  expect(branchLane(root, { base: "main", head: null, workingTree: true })).toMatchObject({
    lane: "self",
    files: 1,
  });
});

test("from git: an unreadable diff is focused, never none", () => {
  const root = repoWith({ "a.ts": "1\n" });
  expect(branchLane(root, { base: "main", head: "0".repeat(40) })).toMatchObject({
    lane: "focused",
  });
});
