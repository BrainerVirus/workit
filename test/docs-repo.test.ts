import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readDocsRepoConfig, writeDocsRepoConfig, docsRepoPath,
  validateDocsRepo, linkDocsRepo,
} from "../packages/workit/src/core/docs-repo";

process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-config-test.json");

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  return dir;
};

test("readDocsRepoConfig returns null when missing", () => {
  const previous = process.env.WORKFLOW_DOCS_REPO_CONFIG;
  process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-missing.json");
  try {
    expect(readDocsRepoConfig()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_DOCS_REPO_CONFIG;
    else process.env.WORKFLOW_DOCS_REPO_CONFIG = previous;
  }
});

test("writeDocsRepoConfig + readDocsRepoConfig round trip", () => {
  const dir = makeRepo();
  try {
    writeDocsRepoConfig(dir);
    expect(readDocsRepoConfig()).toEqual({ path: dir });
    expect(docsRepoPath()).toBe(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateDocsRepo rejects non-git paths and creates features/", () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-plain-"));
  try {
    const bad = validateDocsRepo(plain);
    expect(bad.ok).toBe(false);
  } finally { rmSync(plain, { recursive: true, force: true }); }

  const repo = makeRepo();
  try {
    const ok = validateDocsRepo(repo);
    expect(ok.ok).toBe(true);
    expect(existsSync(path.join(repo, "features"))).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("linkDocsRepo requires confirmed and writes config", () => {
  const repo = makeRepo();
  try {
    const noConfirm = linkDocsRepo(repo, false);
    expect(noConfirm.ok).toBe(false);
    const linked = linkDocsRepo(repo, true);
    expect(linked.ok).toBe(true);
    expect(docsRepoPath()).toBe(repo);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

import { promoteSpec } from "../packages/workit/src/core/docs-repo";

const goodSpec = (slug: string) => `# Spec: ${slug}

**Branch:** \`feature/${slug}\`

## Context

Promotes ${slug} to the docs repo.

## Goals

- Ship ${slug}

## Non-goals

- Nothing

## Architecture

No flow here.

## Acceptance criteria

- CA-01 done
`;

test("promoteSpec copies spec+plan, writes README, updates index", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "alpha"), { recursive: true });
    writeFileSync(path.join(work, "docs/alpha/spec.md"), goodSpec("alpha"));
    writeFileSync(
      path.join(work, "docs/alpha/plan.md"),
      "# Plan\n\n**Spec:** `docs/alpha/spec.md`\n**Branch:** `feature/alpha`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );

    const result = promoteSpec(work, "alpha", { confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toEqual(expect.arrayContaining(["spec.md", "plan.md", "README.md"]));
      const target = result.target_dir;
      expect(existsSync(path.join(target, "spec.md"))).toBe(true);
      expect(existsSync(path.join(target, "plan.md"))).toBe(true);
      expect(existsSync(path.join(target, "README.md"))).toBe(true);
      const readme = readFileSync(path.join(target, "README.md"), "utf8");
      expect(readme).toContain("# Feature: Spec: alpha");
      expect(readme).toContain("Spec en revisión");
      const index = readFileSync(path.join(repo, "features", "README.md"), "utf8");
      expect(index).toContain("alpha");
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec refuses on hard quality findings unless force", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "bad"), { recursive: true });
    writeFileSync(path.join(work, "docs/bad/spec.md"), "# Spec\n\n**Branch:** `feature/bad`\n");

    const refused = promoteSpec(work, "bad", { confirmed: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.findings?.length).toBeGreaterThan(0);

    const forced = promoteSpec(work, "bad", { confirmed: true, force: true });
    expect(forced.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec is idempotent on re-promote", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "gamma"), { recursive: true });
    writeFileSync(path.join(work, "docs/gamma/spec.md"), goodSpec("gamma"));
    promoteSpec(work, "gamma", { confirmed: true });
    const again = promoteSpec(work, "gamma", { confirmed: true });
    expect(again.ok).toBe(true);
    if (again.ok) {
      const index = readFileSync(path.join(repo, "features", "README.md"), "utf8");
      expect((index.match(/^\| \[gamma\]/gm) ?? []).length).toBe(1);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec errors when docs repo not linked", () => {
  const work = makeRepo();
  const previous = process.env.WORKFLOW_DOCS_REPO_CONFIG;
  process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), `wf-docsrepo-unlinked-${Date.now()}.json`);
  try {
    const result = promoteSpec(work, "alpha", { confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("docs repo not linked");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_DOCS_REPO_CONFIG;
    else process.env.WORKFLOW_DOCS_REPO_CONFIG = previous;
    rmSync(work, { recursive: true, force: true });
  }
});

test("promoteSpec rejects traversal and regex-special slugs", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    const traversal = promoteSpec(work, "../evil", { confirmed: true });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error).toContain("invalid slug");

    const regexSpecial = promoteSpec(work, "c++", { confirmed: true });
    expect(regexSpecial.ok).toBe(false);
    if (!regexSpecial.ok) expect(regexSpecial.error).toContain("invalid slug");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec with a dotted slug works and stays in features/", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "dot.8"), { recursive: true });
    writeFileSync(path.join(work, "docs/dot.8/spec.md"), goodSpec("dot.8"));
    const result = promoteSpec(work, "dot.8", { confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target_dir).toContain(path.join(repo, "features"));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
