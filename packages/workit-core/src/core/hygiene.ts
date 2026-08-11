import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changelogUnreleasedStats } from "./changelog";
import { assetRoot } from "./package-root";

export type HygieneFile =
  | "CHANGELOG.md"
  | "README.md"
  | ".editorconfig"
  | ".gitattributes"
  | "LICENSE"
  | "CONTRIBUTING.md";
type State = "missing" | "invalid" | "ok" | "skip";

const repoRoot = assetRoot();
const templatesDir = () => path.join(repoRoot, "templates", "hygiene");

const packageJson = (root: string): Record<string, unknown> | null => {
  if (!existsSync(path.join(root, "package.json"))) return null;
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

const isOpenSource = (root: string): boolean => {
  if (existsSync(path.join(root, "LICENSE"))) return true;
  const pkg = packageJson(root);
  if (pkg && !pkg.private) return true; // I2: missing `private` = public (npm default)
  return path.basename(root) === "workflow-toolkit";
};

const licenseHolder = (root: string): string => {
  const pkg = packageJson(root);
  if (pkg) {
    const author = pkg.author;
    if (typeof author === "string" && author.trim()) return author.trim();
    if (author && typeof author === "object") {
      const name = (author as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return "";
};

export const hygieneFiles = (
  root: string,
): { state: Record<HygieneFile, State>; openSource: boolean } => {
  const openSource = isOpenSource(root);
  const state = {} as Record<HygieneFile, State>;
  for (const file of [
    "CHANGELOG.md",
    "README.md",
    ".editorconfig",
    ".gitattributes",
    "LICENSE",
    "CONTRIBUTING.md",
  ] as HygieneFile[]) {
    if (file === "LICENSE" || file === "CONTRIBUTING.md") {
      state[file] = openSource ? (existsSync(path.join(root, file)) ? "ok" : "missing") : "skip";
      continue;
    }
    if (!existsSync(path.join(root, file))) {
      state[file] = "missing";
      continue;
    }
    if (file === "CHANGELOG.md") {
      const stats = changelogUnreleasedStats(root);
      state[file] = stats.exists && stats.has_unreleased ? "ok" : "invalid";
      continue;
    }
    state[file] = "ok";
  }
  return { state, openSource };
};

// Pure planner: which hygiene files would be created and with what content,
// without touching the filesystem. Drives the wizard preview (WZ-08) and the
// apply path; ensureHygieneFiles is just "plan then write".
export const planHygieneFiles = (
  root: string,
  opts: { includeOpenSource?: boolean } = {},
): Array<{ path: string; content: string }> => {
  const openSource = opts.includeOpenSource ?? isOpenSource(root);
  const files = ["CHANGELOG.md", "README.md", ".editorconfig", ".gitattributes"] as HygieneFile[];
  if (openSource) files.push("LICENSE", "CONTRIBUTING.md");
  const planned: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    if (existsSync(path.join(root, file))) continue;
    const tpl = path.join(templatesDir(), file);
    if (!existsSync(tpl)) continue; // skip missing template, never fail
    const content = readFileSync(tpl, "utf8")
      .replace(/<PROJECT>/g, path.basename(root))
      .replace(/<YEAR>/g, String(new Date().getFullYear()))
      .replace(/<HOLDER>\s*/g, licenseHolder(root));
    planned.push({ path: path.join(root, file), content });
  }
  return planned;
};

export const ensureHygieneFiles = (
  root: string,
  opts: { confirmed: boolean; includeOpenSource?: boolean },
): { ok: true; created: string[] } | { ok: false; error: string } => {
  if (!opts.confirmed) return { ok: false, error: "confirmed: true required" };
  const created: string[] = [];
  for (const planned of planHygieneFiles(root, opts)) {
    writeFileSync(planned.path, planned.content, "utf8");
    created.push(path.basename(planned.path));
  }
  return { ok: true, created };
};
