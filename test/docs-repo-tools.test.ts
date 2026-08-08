import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDocsRepoTools } from "../packages/workit-core/src/tools/docs-repo";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const makeRepo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-tool-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  return dir;
};

test("repo_link requires confirmed and persists", async () => {
  const repo = makeRepo();
  try {
    process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-tool-config.json");
    const tools = createDocsRepoTools();
    const ctx = { directory: repo, worktree: repo } as never;
    const no = JSON.parse(await tools.workflow_docs_repo_link.execute({ path: repo, confirmed: false }, ctx) as string);
    expect(no.ok).toBe(false);
    const yes = JSON.parse(await tools.workflow_docs_repo_link.execute({ path: repo, confirmed: true }, ctx) as string);
    expect(yes.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("docs_list reports specs; promote copies files", async () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-tool-config2.json");
    const { writeDocsRepoConfig } = await import("../packages/workit-core/src/core/docs-repo");
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "zeta"), { recursive: true });
    writeFileSync(path.join(work, "docs/zeta/spec.md"),
      `# Spec: zeta\n\n**Branch:** \`feature/zeta\`\n\n## Context\n\nPromotes zeta.\n\n## Goals\n\n- Ship zeta\n\n## Non-goals\n\n- Nothing\n\n## Architecture\n\nNo flow here.\n\n## Acceptance criteria\n\n- CA-01 done\n`);

    const tools = createDocsRepoTools();
    const ctx = { directory: work, worktree: work } as never;
    const list = JSON.parse(await tools.workflow_docs_list.execute({}, ctx) as string);
    expect(list.ok).toBe(true);
    expect(list.data.specs[0].slug).toBe("zeta");
    expect(list.data.specs[0].promoted).toBe(false);

    const promote = JSON.parse(await tools.workflow_docs_promote.execute(
      { slug: "zeta", confirmed: true }, ctx) as string);
    expect(promote.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
