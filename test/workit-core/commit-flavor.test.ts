import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCommitFlavor,
  matchCommitFlavor,
} from "@/packages/workit-core/src/core/commit-flavors";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";

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
  const tickets = ["NSAT-1 a", "NSAT-2 b", "NSAT-3 c", "free line"];
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

test("git.commit resolve rejects messages outside the configured flavor", () => {
  const root = repoWithStaged(["feat(a): seed"]);
  try {
    withConfig("conventional", {}, () => {
      const bad = resolveExternalActionRequest(root, {
        operation: "git.commit",
        payload: { message: "wip stuff" },
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect((bad as { error: string }).error).toContain("conventional");
      const good = resolveExternalActionRequest(root, {
        operation: "git.commit",
        payload: { message: "fix(auth): handle empty input" },
      });
      expect(good.ok).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git.commit resolve honors ticket-prefix preset and custom patterns", () => {
  const root = repoWithStaged(["TST-1 seed"]);
  try {
    withConfig("ticket-prefix", {}, () => {
      expect(
        resolveExternalActionRequest(root, {
          operation: "git.commit",
          payload: { message: "TST-123 rename column" },
        }).ok,
      ).toBe(true);
      expect(
        resolveExternalActionRequest(root, {
          operation: "git.commit",
          payload: { message: "feat(x): wrong flavor" },
        }).ok,
      ).toBe(false);
    });
    withConfig("custom", { pattern: "^JIRA-\\d+" }, () => {
      expect(
        resolveExternalActionRequest(root, {
          operation: "git.commit",
          payload: { message: "JIRA-9 done" },
        }).ok,
      ).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git.commit resolve auto-detects repo flavor with conventional fallback", () => {
  const conventionalRoot = repoWithStaged(["feat(a): one", "fix(b): two", "chore(c): three"]);
  const mixedRoot = repoWithStaged(["feat(a): one", "random words", "another line", "✨ emoji"]);
  try {
    withConfig("auto", {}, () => {
      expect(
        resolveExternalActionRequest(conventionalRoot, {
          operation: "git.commit",
          payload: { message: "docs(d): detected" },
        }).ok,
      ).toBe(true);
      expect(
        resolveExternalActionRequest(conventionalRoot, {
          operation: "git.commit",
          payload: { message: "free words" },
        }).ok,
      ).toBe(false);
      expect(
        resolveExternalActionRequest(mixedRoot, {
          operation: "git.commit",
          payload: { message: "fix(e): fallback" },
        }).ok,
      ).toBe(true);
    });
  } finally {
    rmSync(conventionalRoot, { recursive: true, force: true });
    rmSync(mixedRoot, { recursive: true, force: true });
  }
});
