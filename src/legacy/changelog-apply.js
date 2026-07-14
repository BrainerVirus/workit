import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_ROOT } from "./plugin-root.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

const CATEGORIES = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

function normalizeEntries(entries) {
  if (!entries) return { data: {} };
  if (Array.isArray(entries)) {
    const grouped = {};
    for (const item of entries) {
      const cat = item.category ?? item.type;
      const text = item.text ?? item.entry ?? "";
      if (!cat || !text) {
        return { error: "each entry needs category + text" };
      }
      const canon = CATEGORIES.find((c) => c.toLowerCase() === String(cat).toLowerCase());
      if (!canon) return { error: `invalid category: ${cat}` };
      (grouped[canon] ??= []).push(text);
    }
    return { data: grouped };
  }
  if (typeof entries === "object") {
    const grouped = {};
    for (const [cat, bullets] of Object.entries(entries)) {
      const canon = CATEGORIES.find((c) => c.toLowerCase() === String(cat).toLowerCase());
      if (!canon) return { error: `invalid category: ${cat}` };
      const list = Array.isArray(bullets) ? bullets : [bullets];
      grouped[canon] = list.filter(Boolean).map(String);
    }
    return { data: grouped };
  }
  return { error: "entries must be object or array" };
}

export function changelogApply({
  entries,
  path: changelogPath,
  normalize_only,
  workspace_root,
}) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const normalized = normalize_only
    ? { data: {} }
    : normalizeEntries(entries);
  if (normalized.error) return { error: normalized.error };
  if (!normalize_only && Object.keys(normalized.data).length === 0) {
    return { error: "entries required unless normalize_only" };
  }

  const rel = changelogPath || "CHANGELOG.md";
  const target = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: "changelog path must be inside workspace_root" };
  }
  const script = path.join(
    PLUGIN_ROOT,
    "scripts/changelog/apply-unreleased.py",
  );
  const payload = JSON.stringify({
    path: path.relative(root, target),
    entries: normalized.data,
    normalize_only: Boolean(normalize_only),
  });
  const result = spawnSync("python3", [script], {
    cwd,
    encoding: "utf8",
    input: payload,
  });
  if (result.status !== 0) {
    const err =
      (result.stderr || result.stdout || "changelog apply failed").trim();
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      return { error: err };
    }
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { error: "invalid JSON from apply-unreleased", raw: result.stdout };
  }
}

export function changelogUnreleasedStats(workspace_root, changelogPath = "CHANGELOG.md") {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const abs = path.isAbsolute(changelogPath)
    ? changelogPath
    : path.join(cwd, changelogPath);
  if (!fs.existsSync(abs)) return { exists: false };
  const text = fs.readFileSync(abs, "utf8");
  const m = text.match(/##\s+\[Unreleased\]([\s\S]*?)(?=\n##\s+\[|$)/i);
  if (!m) return { exists: true, has_unreleased: false };
  const body = m[1];
  const headings = [...body.matchAll(/^###\s+(\w+)\s*$/gim)].map((x) => x[1]);
  const dupes = headings.filter((h, i) =>
    headings.slice(0, i).some((p) => p.toLowerCase() === h.toLowerCase()),
  );
  return {
    exists: true,
    has_unreleased: true,
    category_headings: headings,
    duplicate_category_headings: dupes,
    needs_normalize: dupes.length > 0,
  };
}
