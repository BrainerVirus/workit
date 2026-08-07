import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GITIGNORE_ENTRIES = [
  "# workflow-toolkit: SDD working state (never commit)",
  "docs/*/sdd/",
  "",
  "# OS / editor cruft",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  ".idea/",
  ".vscode/",
  ".env",
  "node_modules/",
  "dist/",
  "*.log",
  ".cache/",
];

export const ensureProjectGitignore = (
  workspaceRoot: string,
  confirmed: boolean,
): { ok: true; path: string; added: string[] } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const file = path.join(workspaceRoot, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean));
  const added: string[] = [];
  const append: string[] = [];
  for (const entry of GITIGNORE_ENTRIES) {
    if (entry.trim() === "" || existingLines.has(entry.trim())) continue;
    append.push(entry);
    added.push(entry);
  }
  if (append.length) {
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(file, existing + separator + (existing ? "\n" : "") + append.join("\n") + "\n", "utf8");
  } else if (!existsSync(file)) {
    writeFileSync(file, "", "utf8");
  }
  return { ok: true, path: file, added };
};
