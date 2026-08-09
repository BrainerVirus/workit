import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config";

export type TemplateName = "issue-update" | "greeting" | "headers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const templatePath = (name: TemplateName): string => path.join(configDir(), "templates", `${name}.md`);

export const readTemplate = (name: TemplateName): { source: "config" | "repo"; content: string } => {
  const cfg = templatePath(name);
  if (existsSync(cfg)) return { source: "config", content: readFileSync(cfg, "utf8") };
  return { source: "repo", content: readFileSync(path.join(repoRoot, "templates", `${name}.md`), "utf8") };
};

export const writeTemplate = (
  name: TemplateName,
  content: string,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const file = templatePath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { ok: true, path: file };
};

export const listTemplates = (): { name: TemplateName; source: "config" | "repo" | "missing"; path: string }[] =>
  (["issue-update", "greeting", "headers"] as TemplateName[]).map((name) => {
    const cfg = templatePath(name);
    const repoFile = path.join(repoRoot, "templates", `${name}.md`);
    if (existsSync(cfg)) return { name, source: "config", path: cfg };
    if (existsSync(repoFile)) return { name, source: "repo", path: repoFile };
    return { name, source: "missing", path: cfg };
  });
