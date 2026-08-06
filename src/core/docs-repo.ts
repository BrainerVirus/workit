import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const configPath = () =>
  process.env.WORKFLOW_DOCS_REPO_CONFIG
  ?? path.join(os.homedir(), ".config", "workflow-toolkit", "docs-repo.json");

export const readDocsRepoConfig = (): { path: string } | null => {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { path?: string };
    return parsed.path ? { path: parsed.path } : null;
  } catch {
    return null;
  }
};

export const writeDocsRepoConfig = (docsPath: string): void => {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ path: docsPath }, null, 2) + "\n", "utf8");
};

export const docsRepoPath = (): string | null => readDocsRepoConfig()?.path ?? null;

export const validateDocsRepo = (docsPath: string): { ok: true } | { ok: false; error: string } => {
  if (!existsSync(docsPath)) return { ok: false, error: `docs repo path does not exist: ${docsPath}` };
  try {
    execFileSync("git", ["-C", docsPath, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
  } catch {
    return { ok: false, error: `docs repo is not a git repository: ${docsPath}` };
  }
  const featuresDir = path.join(docsPath, "features");
  if (!existsSync(featuresDir)) mkdirSync(featuresDir, { recursive: true });
  return { ok: true };
};

export const linkDocsRepo = (
  docsPath: string,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const valid = validateDocsRepo(docsPath);
  if (!valid.ok) return valid;
  writeDocsRepoConfig(docsPath);
  return { ok: true, path: docsPath };
};

export const listSpecs = (
  workspaceRoot: string,
): { docs_repo: string | null; specs: { slug: string; spec: string; promoted: boolean; target: string | null }[] } => {
  const repoPath = docsRepoPath();
  const specs: { slug: string; spec: string; promoted: boolean; target: string | null }[] = [];
  const docsDir = path.join(workspaceRoot, "docs");
  if (existsSync(docsDir)) {
    for (const slug of readdirSync(docsDir)) {
      if (slug.startsWith(".")) continue;
      const spec = path.posix.join("docs", slug, "spec.md");
      if (!existsSync(path.join(workspaceRoot, spec))) continue;
      let promoted = false;
      let target: string | null = null;
      if (repoPath) {
        const featuresDir = path.join(repoPath, "features");
        if (existsSync(featuresDir)) {
          const match = readdirSync(featuresDir).find((d) => d.endsWith(`-${slug}`));
          if (match) {
            promoted = true;
            target = path.join(repoPath, "features", match);
          }
        }
      }
      specs.push({ slug, spec, promoted, target });
    }
  }
  return { docs_repo: repoPath, specs };
};
