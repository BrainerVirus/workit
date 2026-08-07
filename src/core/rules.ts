import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config";

export type RulePlatform = "cursor" | "opencode";
export type CanonicalRule = {
  name: string;
  description: string;
  platforms: RulePlatform[];
  body: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const rulesDir = () => path.join(configDir(), "rules");

export const parseRule = (markdown: string): CanonicalRule | { error: string } => {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return { error: "rule must start with frontmatter (--- name/description/platforms ---)" };
  const meta: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const name = meta.name ?? "";
  const description = meta.description ?? "";
  const platforms = (meta.platforms ?? "")
    .replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().replace(/['"]/g, ""))
    .filter(Boolean) as RulePlatform[];
  if (!name || !description || platforms.length === 0) {
    return { error: "rule frontmatter requires name, description, and platforms" };
  }
  return { name, description, platforms, body: fm[2].trim() + "\n" };
};

export const listRules = (): { name: string; platforms: string[]; source: "config" | "repo" }[] => {
  const result: { name: string; platforms: string[]; source: "config" | "repo" }[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed) continue;
      result.push({ name: parsed.name, platforms: parsed.platforms, source: "config" });
    }
  }
  return result;
};

export const readRule = (name: string): { source: "config" | "repo" | "missing"; rule: CanonicalRule } => {
  const file = path.join(rulesDir(), name, "rule.md");
  if (existsSync(file)) {
    return { source: "config", rule: parseRule(readFileSync(file, "utf8")) as CanonicalRule };
  }
  return { source: "missing", rule: { name, description: "", platforms: [], body: "" } };
};

export const writeRule = (
  rule: CanonicalRule,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const dir = path.join(rulesDir(), rule.name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rule.md");
  const md = `---\nname: ${rule.name}\ndescription: ${rule.description}\nplatforms: [${rule.platforms.join(", ")}]\n---\n${rule.body}`;
  writeFileSync(file, md, "utf8");
  return { ok: true, path: file };
};

export const compileRuleCursor = (rule: CanonicalRule): string =>
  `---\ndescription: ${rule.description}\nalwaysApply: true\n---\n\n${rule.body}`;

export const compileRuleOpenCode = (rule: CanonicalRule): string =>
  `## ${rule.name}\n\n${rule.body}`;

export const compiledOpenCodeSections = (): string => {
  const sections: string[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed || !parsed.platforms.includes("opencode")) continue;
      sections.push(compileRuleOpenCode(parsed));
    }
  }
  return sections.join("\n\n");
};

export const writeCompiledCursorRules = (targetDir: string): string[] => {
  const written: string[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed || !parsed.platforms.includes("cursor")) continue;
      const out = path.join(targetDir, `${parsed.name}.mdc`);
      writeFileSync(out, compileRuleCursor(parsed), "utf8");
      written.push(out);
    }
  }
  return written;
};
