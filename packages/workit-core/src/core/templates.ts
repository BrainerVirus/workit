import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config";
import { assetRoot } from "./package-root";

export type TemplateName = "issue-update" | "greeting" | "headers";

const repoRoot = assetRoot();

export const templatePath = (name: TemplateName): string =>
  path.join(configDir(), "templates", `${name}.md`);

export const readTemplate = (
  name: TemplateName,
): { source: "config" | "repo"; content: string } => {
  const cfg = templatePath(name);
  if (existsSync(cfg)) return { source: "config", content: readFileSync(cfg, "utf8") };
  return {
    source: "repo",
    content: readFileSync(path.join(repoRoot, "templates", `${name}.md`), "utf8"),
  };
};
