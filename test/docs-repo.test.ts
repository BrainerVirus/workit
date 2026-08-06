import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readDocsRepoConfig, writeDocsRepoConfig, docsRepoPath,
  validateDocsRepo, linkDocsRepo,
} from "../src/core/docs-repo";

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
