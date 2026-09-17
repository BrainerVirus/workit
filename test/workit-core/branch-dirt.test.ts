import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBranchDirt } from "@/packages/workit-core/src/core/branch";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-branch-dirt-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "spec.md"), "spec\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
};

test("clean trees read as clean", () => {
  const root = repo();
  try {
    expect(classifyBranchDirt(root)).toBe("clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untracked files always carry", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "notes.md"), "untracked\n");
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "scratch", "tmp.txt"), "tmp\n");
    expect(classifyBranchDirt(root)).toBe("carry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs-confined tracked modifications carry", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "docs", "spec.md"), "spec v2\n");
    writeFileSync(join(root, "docs", "new.md"), "new doc\n");
    git(root, ["add", "docs/new.md"]);
    expect(classifyBranchDirt(root)).toBe("carry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("code dirt outside docs requires the stash question", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "base.txt"), "wip\n");
    expect(classifyBranchDirt(root)).toBe("stash-required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed untracked and code dirt requires the stash question", () => {
  const root = repo();
  try {
    writeFileSync(join(root, "notes.md"), "untracked\n");
    writeFileSync(join(root, "base.txt"), "wip\n");
    expect(classifyBranchDirt(root)).toBe("stash-required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable checkouts fail open as clean", () => {
  expect(classifyBranchDirt(join(tmpdir(), "workit-branch-dirt-missing-"))).toBe("clean");
});
