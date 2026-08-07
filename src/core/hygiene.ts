import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogUnreleasedStats } from "./changelog";

export type HygieneFile = "CHANGELOG.md" | "README.md" | ".editorconfig" | ".gitattributes" | "LICENSE" | "CONTRIBUTING.md";
type State = "missing" | "invalid" | "ok" | "skip";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatesDir = () => path.join(repoRoot, "templates", "hygiene");

const isOpenSource = (root: string): boolean => {
  if (existsSync(path.join(root, "LICENSE"))) return true;
  if (existsSync(path.join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.private === false) return true;
    } catch { /* ignore */ }
  }
  return path.basename(root) === "workflow-toolkit";
};

export const hygieneFiles = (root: string): { state: Record<HygieneFile, State>; openSource: boolean } => {
  const openSource = isOpenSource(root);
  const state = {} as Record<HygieneFile, State>;
  for (const file of ["CHANGELOG.md", "README.md", ".editorconfig", ".gitattributes", "LICENSE", "CONTRIBUTING.md"] as HygieneFile[]) {
    if (file === "LICENSE" || file === "CONTRIBUTING.md") {
      state[file] = openSource ? (existsSync(path.join(root, file)) ? "ok" : "missing") : "skip";
      continue;
    }
    if (!existsSync(path.join(root, file))) { state[file] = "missing"; continue; }
    if (file === "CHANGELOG.md") {
      const stats = changelogUnreleasedStats(root);
      state[file] = stats.exists && stats.has_unreleased ? "ok" : "invalid";
      continue;
    }
    state[file] = "ok";
  }
  return { state, openSource };
};

export const ensureHygieneFiles = (
  root: string,
  opts: { confirmed: boolean; includeOpenSource?: boolean },
): { ok: true; created: string[] } | { ok: false; error: string } => {
  if (!opts.confirmed) return { ok: false, error: "confirmed: true required" };
  const files = ["CHANGELOG.md", "README.md", ".editorconfig", ".gitattributes"] as HygieneFile[];
  if (opts.includeOpenSource) files.push("LICENSE", "CONTRIBUTING.md");
  const created: string[] = [];
  const tplDir = templatesDir();
  for (const file of files) {
    if (existsSync(path.join(root, file))) continue;
    const tpl = path.join(tplDir, file);
    if (!existsSync(tpl)) continue; // skip missing template, never fail
    const content = readFileSync(tpl, "utf8")
      .replace(/<PROJECT>/g, path.basename(root))
      .replace(/<YEAR>/g, String(new Date().getFullYear()))
      .replace(/<HOLDER>/g, "");
    writeFileSync(path.join(root, file), content, "utf8");
    created.push(file);
  }
  return { ok: true, created };
};
