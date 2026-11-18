// The released-changelog repo rule, a warning: an [Unreleased] entry a
// workit-dev-v* tag already shipped is printed with the roll command, the run
// still passes, and a checkout without tags skips it.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/repo-rules/check.mts";

const changelog = (entries: string[]): string =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${entries.join("\n")}\n`;
const SHIPPED = "- Shipped: in 1.0.0 already.";
const FRESH = "- Fresh: not released yet.";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A checkout whose CHANGELOG.md held `tagged` at workit-dev-v1.0.0 (when given) and `now` at HEAD. */
function checkout(now: string, tagged?: string): string {
  const base = mkdtempSync(path.join(os.tmpdir(), "wk-released-changelog-"));
  roots.push(base);
  const root = path.join(base, "repo");
  mkdirSync(root);
  const globalConfig = path.join(base, ".gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "core.hooksPath", path.join(base, "no-hooks"));
  if (tagged !== undefined) {
    writeFileSync(path.join(root, "CHANGELOG.md"), tagged);
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "docs: changelog");
    git("tag", "workit-dev-v1.0.0");
  }
  writeFileSync(path.join(root, "CHANGELOG.md"), now);
  // oxlint refuses a tree with no file to lint.
  writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;\n");
  return root;
}

const run = (root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["--root", root], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("Given an [Unreleased] entry a workit-dev-v tag already holds, When the repo rules run, Then they warn at its line naming the release and the roll command, and still pass", () => {
  const root = checkout(changelog([FRESH, SHIPPED]), changelog([SHIPPED]));
  const { code, out, err } = run(root);
  expect(code).toBe(0);
  expect(err).toBe("");
  expect(out).toBe(
    "warning: CHANGELOG.md:8:1 workit/released-changelog: this [Unreleased] entry already shipped in 1.0.0. Fix: run `bun scripts/roll-changelog.ts`, which moves every released entry into its version's section. (release notes: no release writes back to main, so 1,200 lines of shipped entries piled up under [Unreleased])",
  );
});

test("Given only entries no tag holds, When the repo rules run, Then they pass", () => {
  const root = checkout(changelog([FRESH]), changelog([SHIPPED]));
  expect(run(root)).toEqual({ code: 0, out: "", err: "" });
});

test("Given a checkout with no workit-dev-v tags (CI's shallow clone), When the repo rules run, Then the rule reports nothing", () => {
  const root = checkout(changelog([SHIPPED]));
  expect(run(root)).toEqual({ code: 0, out: "", err: "" });
});
