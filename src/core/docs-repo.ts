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

import { docsValidate, qualitySpec } from "./docs-validate";

const monthPrefix = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

const specSummary = (specText: string): string => {
  const contextMatch = specText.match(/## Context\n\n([\s\S]*?)(?=\n## )/);
  if (!contextMatch) return "";
  const first = contextMatch[1].trim().split("\n").find((l) => l.trim() && !l.startsWith("<!--"));
  return (first ?? "").trim();
};

const specRepos = (specText: string): string => {
  const match = specText.match(/^\*\*Repos:\*\*\s*(.+)$/m);
  return match?.[1]?.trim() ?? "—";
};

export const promoteSpec = (
  workspaceRoot: string,
  slug: string,
  opts: { confirmed: boolean; force?: boolean },
): { ok: true; target_dir: string; files: string[]; index_updated: boolean }
  | { ok: false; error: string; findings?: unknown[] } => {
  if (!opts.confirmed) return { ok: false, error: "confirmed: true required" };
  const repoPath = docsRepoPath();
  if (!repoPath) return { ok: false, error: "docs repo not linked — run workflow_docs_repo_link" };

  const specRel = path.posix.join("docs", slug, "spec.md");
  const planRel = path.posix.join("docs", slug, "plan.md");
  const specText = readSafe(path.join(workspaceRoot, specRel));
  if (specText === null) return { ok: false, error: `docs/${slug}/spec.md not found` };

  const planText = readSafe(path.join(workspaceRoot, planRel));
  if (planText !== null) {
    const validated = docsValidate({ spec_path: specRel, plan_path: planRel, workspace_root: workspaceRoot });
    if (validated.ok === false) return { ok: false, error: validated.error };
  }

  const findings = qualitySpec(specText);
  const hardFindings = findings.filter((f) => f.severity === "hard");
  if (hardFindings.length > 0 && !opts.force) {
    return { ok: false, error: "spec has hard quality findings; pass force: true to override", findings };
  }

  const prefix = monthPrefix();
  const targetDir = path.join(repoPath, "features", `${prefix}-${slug}`);
  mkdirSync(targetDir, { recursive: true });

  const files: string[] = ["spec.md"];
  writeFileSync(path.join(targetDir, "spec.md"), specText, "utf8");
  if (planText !== null) {
    writeFileSync(path.join(targetDir, "plan.md"), planText, "utf8");
    files.push("plan.md");
  }

  const title = specText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const readme = `# Feature: ${title}

**Fecha:** ${prefix}
**Estado:** Spec en revisión
**Repos afectados:** ${specRepos(specText)}

## Resumen

${specSummary(specText)}

## Documentación

| Documento | Contenido |
| --- | --- |
| [spec.md](./spec.md) | Especificación completa |
${planText !== null ? "| [plan.md](./plan.md) | Plan de implementación |\n" : ""}`;
  writeFileSync(path.join(targetDir, "README.md"), readme, "utf8");
  files.push("README.md");

  const indexPath = path.join(repoPath, "features", "README.md");
  const indexText = readSafe(indexPath) ?? `# Features\n\nEspecificaciones y planes por feature.\n\n## Features documentadas\n\n| Feature | Repos afectados | Estado |\n| --- | --- | --- |\n`;
  const row = `| [${slug}](./${prefix}-${slug}/) | ${specRepos(specText)} | Spec en revisión |`;
  const rowRe = new RegExp(`^\\| \\[${slug}\\]\\([^)]*\\) \\|.*$`, "m");
  let newIndex: string;
  if (rowRe.test(indexText)) {
    newIndex = indexText.replace(rowRe, row);
  } else if (/^(\| --- \| --- \| --- \|\n)/m.test(indexText)) {
    newIndex = indexText.replace(/^(\| --- \| --- \| --- \|\n)/m, `$1${row}\n`);
  } else {
    newIndex = indexText + `\n${row}\n`;
  }
  writeFileSync(indexPath, newIndex, "utf8");

  return { ok: true, target_dir: targetDir, files, index_updated: true };
};
