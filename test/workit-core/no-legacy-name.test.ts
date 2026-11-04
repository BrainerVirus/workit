// Only the name workit exists: no tracked file may spell the old product name
// (env vars, paths, marketplace names, docs) or an old WORKFLOW_* env var (now
// WORKIT_*, with no alias). The allowed leftovers are the
// release history in CHANGELOG.md, this guard, and the one constant Codex
// setup and upgrade read to move an install off the old marketplace name.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const OLD_NAME = /workflow[-_ ]?toolkit/i;
const OLD_ENV_PREFIX = /\bWORKFLOW_[A-Z]/;
const SELF = "test/workit-core/no-legacy-name.test.ts";
const ALLOWED_FILES = new Set(["CHANGELOG.md", SELF]);
const ALLOWED_LINES = new Map([
  [
    "packages/workit-cli/src/upgrade/codex-marketplace.ts",
    'export const CODEX_LEGACY_MARKETPLACE = "workflow-toolkit";',
  ],
]);

type Source = { file: string; text: string };

/** Every `file:line: text` that spells the old name or env prefix outside the allowed places. */
const oldNameHits = (sources: Source[]): string[] => {
  const hits: string[] = [];
  for (const { file, text } of sources) {
    if (ALLOWED_FILES.has(file) || text.includes("\0")) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (!OLD_NAME.test(line) && !OLD_ENV_PREFIX.test(line)) return;
      if (ALLOWED_LINES.get(file) === line.trim()) return;
      hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
};

const trackedSources = (): Source[] => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((file) => {
      try {
        return [{ file, text: readFileSync(path.join(REPO_ROOT, file), "utf8") }];
      } catch {
        return []; // deleted in the working tree, not yet staged
      }
    });
};

test("no tracked file spells the old product name or WORKFLOW_* env prefix outside CHANGELOG.md and the Codex legacy constant", () => {
  expect(oldNameHits(trackedSources())).toEqual([]);
});

test("the guard names the file and line of a reintroduced old env var", () => {
  const hits = oldNameHits([
    {
      file: "packages/x/src/state.ts",
      text: "const a = 1;\nconst dir = env.WORKFLOW_TOOLKIT_STATE;\n",
    },
    {
      file: "packages/x/src/root.ts",
      text: "const root = env.WORKFLOW_WORKSPACE_ROOT;\nconst kept = env.WORKIT_WORKSPACE_ROOT;\nconst word = SUB_WORKFLOW_X;\n",
    },
    { file: "CHANGELOG.md", text: "WORKFLOW_TOOLKIT_STATE and WORKFLOW_YT_WRITE were renamed" },
    {
      file: "packages/workit-cli/src/upgrade/codex-marketplace.ts",
      text: 'export const CODEX_LEGACY_MARKETPLACE = "workflow-toolkit";\nconst again = "workflow-toolkit";\n',
    },
  ]);
  expect(hits).toEqual([
    "packages/x/src/state.ts:2: const dir = env.WORKFLOW_TOOLKIT_STATE;",
    "packages/x/src/root.ts:1: const root = env.WORKFLOW_WORKSPACE_ROOT;",
    'packages/workit-cli/src/upgrade/codex-marketplace.ts:2: const again = "workflow-toolkit";',
  ]);
});
