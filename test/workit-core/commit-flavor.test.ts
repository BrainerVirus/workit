import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCommitFlavor,
  matchCommitFlavor,
} from "@/packages/workit-core/src/core/commit-flavors";
import { lintCommitMessage } from "@/packages/workit-core/src/git/ops";
import { resolveCommitPolicy } from "@/packages/workit-core/src/core/config";
import type { ToolkitConfig } from "@/packages/workit-core/src/core/config";

const baseConfig = (over: Partial<ToolkitConfig> = {}): ToolkitConfig => ({
  locale: "en",
  localeOptions: ["en"],
  branchPolicy: { preset: "gitflow", allowed: [], protected: [] },
  commitPolicy: { preset: "conventional" },
  ...over,
});

test("resolveCommitPolicy prefers workspace override, falls back to global", () => {
  expect(resolveCommitPolicy(baseConfig(), { commitPolicy: { preset: "gitmoji" } }).preset).toBe(
    "gitmoji",
  );
  expect(resolveCommitPolicy(baseConfig(), null).preset).toBe("conventional");
  expect(resolveCommitPolicy(baseConfig(), {}).preset).toBe("conventional");
  expect(resolveCommitPolicy(baseConfig(), { commitPolicy: { preset: "nope" } }).preset).toBe(
    "conventional",
  );
  expect(
    resolveCommitPolicy(baseConfig({ commitPolicy: { preset: "custom", pattern: "^JIRA-" } }), {
      commitPolicy: { preset: "ticket-prefix" },
    }),
  ).toEqual({ preset: "ticket-prefix" });
});

test("matchCommitFlavor accepts each flavor and rejects the rest", () => {
  expect(matchCommitFlavor("feat(auth): add login", "conventional")).toBe(true);
  expect(matchCommitFlavor("fix: crash on empty input", "conventional")).toBe(true);
  expect(matchCommitFlavor("wip stuff", "conventional")).toBe(false);
  expect(matchCommitFlavor("✨ add sparkles", "gitmoji")).toBe(true);
  expect(matchCommitFlavor("feat(x): no emoji", "gitmoji")).toBe(false);
  expect(matchCommitFlavor("TST-123 rename column", "ticket-prefix")).toBe(true);
  expect(matchCommitFlavor("feat(x): no ticket", "ticket-prefix")).toBe(false);
  expect(matchCommitFlavor("anything at all", "freeform")).toBe(true);
  expect(matchCommitFlavor("JIRA-1 done", "custom", "^[A-Z]+-\\d+")).toBe(true);
  expect(matchCommitFlavor("nope", "custom", "^[A-Z]+-\\d+")).toBe(false);
});

test("matchCommitFlavor fails closed on invalid custom patterns", () => {
  expect(matchCommitFlavor("anything", "custom")).toBe(false);
  expect(matchCommitFlavor("anything", "custom", "([")).toBe(false);
});

test("detectCommitFlavor picks majority above threshold, else null", () => {
  const conventional = ["feat(a): x", "fix(b): y", "chore(c): z", "docs(d): w"];
  expect(detectCommitFlavor(conventional).flavor).toBe("conventional");
  const mixed = ["feat(a): x", "random words here", "another free line", "✨ emoji"];
  expect(detectCommitFlavor(mixed).flavor).toBeNull();
  expect(detectCommitFlavor([]).flavor).toBeNull();
  const tickets = ["TST-1 a", "TST-2 b", "TST-3 c", "free line"];
  expect(detectCommitFlavor(tickets).flavor).toBe("ticket-prefix");
});

const git = (root: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repoWithStaged = (messages: string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "workit-commit-flavor-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Workit Test"]);
  messages.forEach((message, index) => {
    writeFileSync(join(root, `file-${index}.txt`), `${message}\n`);
    git(root, ["add", `.`]);
    git(root, ["commit", "-qm", message]);
  });
  writeFileSync(join(root, "staged.txt"), "staged\n");
  git(root, ["add", "staged.txt"]);
  return root;
};

const withConfig = (preset: string, extra: Record<string, unknown>, run: () => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "workit-commit-config-"));
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ commitPolicy: { preset, ...extra } }));
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    run();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("commit lint validates against the matched workspace flavor", () => {
  const root = repoWithStaged(["feat(a): seed"]);
  const dir = mkdtempSync(join(tmpdir(), "workit-commit-config-"));
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ commitPolicy: { preset: "conventional" } }),
    );
    writeFileSync(
      join(dir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "t",
            glob: `${root}/**`,
            commitPolicy: { preset: "gitmoji" },
          },
        ],
      }),
    );
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    expect(lintCommitMessage(root, "✨ emoji wins here")).toMatchObject({
      ok: true,
    });
    const other = lintCommitMessage(root, "fix(auth): global flavor loses here");
    expect(other).toMatchObject({
      ok: false,
      error: expect.stringContaining("commit_style"),
    });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit lint rejects messages outside the configured flavor", () => {
  const root = repoWithStaged(["feat(a): seed"]);
  try {
    withConfig("conventional", {}, () => {
      const bad = lintCommitMessage(root, "wip stuff");
      expect(bad).toMatchObject({
        ok: false,
        error: expect.stringContaining("commit_style"),
      });
      const good = lintCommitMessage(root, "fix(auth): handle empty input");
      expect(good.ok).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit lint honors ticket-prefix preset and custom patterns", () => {
  const root = repoWithStaged(["TST-1 seed"]);
  try {
    withConfig("ticket-prefix", {}, () => {
      expect(lintCommitMessage(root, "TST-123 rename column").ok).toBe(true);
      expect(lintCommitMessage(root, "feat(x): wrong flavor")).toMatchObject({
        ok: false,
      });
    });
    withConfig("custom", { pattern: "^JIRA-\\d+" }, () => {
      expect(lintCommitMessage(root, "JIRA-9 done").ok).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit lint auto-detects repo flavor with conventional fallback", () => {
  const conventionalRoot = repoWithStaged(["feat(a): one", "fix(b): two", "chore(c): three"]);
  const mixedRoot = repoWithStaged(["feat(a): one", "random words", "another line", "✨ emoji"]);
  try {
    withConfig("auto", {}, () => {
      expect(lintCommitMessage(conventionalRoot, "docs(d): detected").ok).toBe(true);
      // The lint holds `auto` to the detected history flavor.
      expect(lintCommitMessage(conventionalRoot, "free words").ok).toBe(false);
      expect(lintCommitMessage(mixedRoot, "fix(e): fallback").ok).toBe(true);
    });
  } finally {
    rmSync(conventionalRoot, { recursive: true, force: true });
    rmSync(mixedRoot, { recursive: true, force: true });
  }
});
