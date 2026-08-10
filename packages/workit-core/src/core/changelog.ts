import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "./scripts";

const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

// Port of scripts/changelog/apply-unreleased.py — merge Keep a Changelog
// entries into ## [Unreleased] without duplicating ### headings.
const CAT_RE = /^###\s+(?:Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/i;
const UNRELEASED_RE = /^##\s+\[Unreleased\]\s*$/i;
const VERSION_RE = /^##\s+\[/;
const BULLET_RE = /^([-*]\s+)(.+?)\s*$/;
const HEADING_RE = /^###\s+/;

const SKELETON = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

`;

function normalizeBullet(text: string): string {
  text = text.trim();
  const m = BULLET_RE.exec(text);
  if (m) return m[2].trim();
  if (text.startsWith("- ") || text.startsWith("* ")) return text.slice(2).trim();
  return text;
}

function formatBullet(text: string): string {
  return `- ${normalizeBullet(text)}`;
}

function splitUnreleased(text: string): [string, string, string] {
  const lines = text.split(/(?<=\n)/);
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (UNRELEASED_RE.test(lines[i].replace(/\n$/, ""))) {
      start = i;
      break;
    }
  }
  if (start === null) return [text, "", ""];

  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const stripped = lines[j].replace(/\n$/, "");
    // Next version heading ends Unreleased (ignore a stray second Unreleased)
    if (VERSION_RE.test(stripped)) {
      if (UNRELEASED_RE.test(stripped)) continue;
      end = j;
      break;
    }
  }

  const before = lines.slice(0, start + 1).join("");
  const body = lines.slice(start + 1, end).join("");
  const after = lines.slice(end).join("");
  return [before, body, after];
}

function canonicalCategory(heading: string): string | null {
  const match = CAT_RE.exec(heading.replace(/\r?\n$/, ""));
  if (!match) return null;
  return (
    CATEGORIES.find(
      (c) =>
        c.toLowerCase() ===
        match[0]
          .replace(/^###\s+/, "")
          .trim()
          .toLowerCase(),
    ) ?? null
  );
}

function splitSections(
  body: string,
): [string[], Array<{ heading: string; category: string | null; body: string[] }>] {
  const preamble: string[] = [];
  const sections: Array<{ heading: string; category: string | null; body: string[] }> = [];
  let current: { heading: string; category: string | null; body: string[] } | null = null;
  for (const line of body.split(/(?<=\n)/)) {
    if (HEADING_RE.test(line)) {
      current = { heading: line, category: canonicalCategory(line), body: [] };
      sections.push(current);
    } else if (current === null) {
      preamble.push(line);
    } else {
      current.body.push(line);
    }
  }
  return [preamble, sections];
}

function bulletBlocks(lines: string[]): Array<[string | null, string[]]> {
  const blocks: Array<[string | null, string[]]> = [];
  let current: string[] = [];
  let key: string | null = null;
  for (const line of lines) {
    const match = BULLET_RE.exec(line.replace(/\r\n$/, "").replace(/\n$/, ""));
    if (match) {
      if (current.length) blocks.push([key, current]);
      key = normalizeBullet(line).toLowerCase();
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push([key, current]);
  return blocks;
}

function mergeSections(
  body: string,
  entries: Record<string, string[]>,
  normalizeOnly: boolean,
): [string, Record<string, number>, Record<string, number> | null, string | null] {
  const [preamble, sections] = splitSections(body);
  const first: Record<string, { heading: string; body: string[] }> = {};
  const rendered: Array<{ heading: string; body: string[] }> = [];
  for (const section of sections) {
    if (section.category && section.category in first) {
      first[section.category].body.push(...section.body);
    } else {
      const entry = { heading: section.heading, body: section.body };
      rendered.push(entry);
      if (section.category) first[section.category] = entry;
    }
  }

  const added: Record<string, number> = {};
  if (!normalizeOnly) {
    for (const [rawCategory, bullets] of Object.entries(entries)) {
      const category = CATEGORIES.find((c) => c.toLowerCase() === rawCategory.toLowerCase());
      if (category === undefined) {
        return ["", {}, {}, `invalid category: ${rawCategory}`];
      }
      let section = first[category];
      if (section === undefined) {
        section = { heading: `### ${category}\n`, body: ["\n"] };
        rendered.push(section);
        first[category] = section;
      }

      const seen = new Set<string>();
      const kept: string[] = [];
      for (const [key, block] of bulletBlocks(section.body)) {
        if (key !== null && seen.has(key)) continue;
        if (key !== null) seen.add(key);
        kept.push(...block);
      }

      const fresh: string[] = [];
      for (const bullet of bullets ?? []) {
        const key = normalizeBullet(bullet).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fresh.push(formatBullet(bullet) + "\n");
      }
      if (fresh.length) {
        let insertAt = 0;
        while (insertAt < kept.length && !kept[insertAt].trim()) insertAt++;
        section.body = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
      } else {
        section.body = kept;
      }
      added[category] = fresh.length;
    }
  }

  let output = preamble.join("");
  for (const section of rendered) {
    output += section.heading + section.body.join("");
  }
  const counts: Record<string, number> = {};
  for (const [category, section] of Object.entries(first)) {
    counts[category] = bulletBlocks(section.body).filter(([key]) => key !== null).length;
  }
  return [output, counts, added, null];
}

function ensureFile(target: string): string {
  if (fs.existsSync(target)) return fs.readFileSync(target, "utf8");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SKELETON, "utf8");
  return SKELETON;
}

function hasUnreleasedHeading(text: string): boolean {
  return text.split("\n").some((line) => UNRELEASED_RE.test(line.replace(/\n$/, "")));
}

function applyChangelog(
  target: string,
  entries: Record<string, string[]>,
  normalizeOnly: boolean,
): Record<string, any> {
  let text = ensureFile(target);
  if (!hasUnreleasedHeading(text)) {
    const lines = text.split(/(?<=\n)/);
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/\n$/, "");
      if (VERSION_RE.test(stripped) && !UNRELEASED_RE.test(stripped)) {
        insertAt = i;
        break;
      }
    }
    text =
      lines.slice(0, insertAt).join("") + "## [Unreleased]\n\n" + lines.slice(insertAt).join("");
  }

  const [before, body, after] = splitUnreleased(text);
  const [newBody, counts, addedCounts, error] = mergeSections(body, entries, normalizeOnly);
  if (error) return { error };
  // before already includes "## [Unreleased]\n"
  const out = (before.endsWith("\n") ? before : before + "\n") + newBody + after;
  fs.writeFileSync(target, out, "utf8");
  return {
    ok: true,
    path: target,
    normalize_only: normalizeOnly,
    added: addedCounts,
    categories: counts,
  };
}

function normalizeEntries(entries: any): { data: Record<string, string[]> } | { error: string } {
  if (!entries) return { data: {} };
  if (Array.isArray(entries)) {
    const grouped: Record<string, string[]> = {};
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
    const grouped: Record<string, string[]> = {};
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
}: {
  entries?: any;
  path?: string;
  normalize_only?: boolean;
  workspace_root: string;
}): Record<string, any> {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const normalized = normalize_only
    ? { data: {} as Record<string, string[]> }
    : normalizeEntries(entries);
  if ("error" in normalized) return { error: normalized.error };
  if (!normalize_only && Object.keys(normalized.data).length === 0) {
    return { error: "entries required unless normalize_only" };
  }

  const rel = changelogPath || "CHANGELOG.md";
  const target = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: "changelog path must be inside workspace_root" };
  }

  try {
    return applyChangelog(target, normalized.data, Boolean(normalize_only));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "changelog apply failed" };
  }
}

export function changelogUnreleasedStats(workspace_root: string, changelogPath = "CHANGELOG.md") {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const abs = path.isAbsolute(changelogPath) ? changelogPath : path.join(cwd, changelogPath);
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
