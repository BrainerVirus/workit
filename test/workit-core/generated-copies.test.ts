import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Host packages commit copies of canonical sources so git-based installs
// (Cursor marketplace, Codex plugin) work without a build. `bun run build`
// regenerates these copies in place, so comparing working-tree files after a
// build would pass by construction. Instead compare the committed git trees:
// a canonical edit committed without its regenerated copies fails here.
const repoRoot = path.resolve(import.meta.dir, "../..");

const GENERATED_COPIES: Record<string, string[]> = {
  "packages/workit-core/skills": [
    "packages/workit-opencode/assets/skills",
    "packages/workit-cursor/skills",
    "packages/workit-codex/skills",
    "packages/workit-pi/skills",
  ],
  "packages/workit-core/templates": ["packages/workit-cli/assets/templates"],
};

const committedTree = (relative: string): string => {
  const result = spawnSync("git", ["rev-parse", `HEAD:${relative}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD:${relative}: ${result.stderr}`);
  return result.stdout.trim();
};

test("committed host copies match the canonical source they are built from", () => {
  for (const [canonical, copies] of Object.entries(GENERATED_COPIES)) {
    const expected = committedTree(canonical);
    for (const copy of copies)
      expect(committedTree(copy), `${copy} differs from ${canonical}; run bun run build`).toBe(
        expected,
      );
  }
});
