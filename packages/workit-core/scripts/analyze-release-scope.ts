#!/usr/bin/env bun
// AR-16: path-gated releases. Replaces message-only commit analysis: a
// releasable commit counts only when it touches a PRODUCT PATH (any of the
// four package dirs). Tooling-only merges produce no release at all.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const RELEASE_PACKAGES = [
  "workit-core",
  "workit-opencode",
  "workit-cursor",
  "workit-cli",
] as const;

const g = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function latestTag(root = process.cwd()): string | null {
  const out = g(root, ["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return out[0] ?? null;
}

type Level = "major" | "minor" | "patch";
const LEVEL_RANK: Record<Level, number> = { patch: 1, minor: 2, major: 3 };
const TYPE_LEVEL: Record<string, Level> = { fix: "patch", perf: "patch", feat: "minor" };

const subjectLevel = (commit: string): Level | null => {
  const firstLine = commit.split("\n")[0] ?? "";
  const m = /^(?:fix|perf|feat)(?:\([^)]*\))?!?:/.exec(firstLine);
  if (!m) return null;
  if (/!:/.test(firstLine)) return "major";
  const body = commit.split("\n").slice(1).join("\n");
  return /BREAKING CHANGE:/.test(body) ? "major" : TYPE_LEVEL[m[0].split("(")[0].replace("!", "")];
};

// Two-pass collection (sanctioned by the task brief): the single-pass
// `%H<NUL>%s%n%b` + `--name-only` interleave is brittle because execFileSync
// rejects NUL bytes inside arguments, and NUL-delimited parsing interleaves
// badly with --name-only output. Bounded by commit count; acceptable for this
// repo's cadence.
const commitsSince = (root: string, from: string): { message: string; files: string[] }[] => {
  const hashes = g(root, ["log", "--reverse", "--format=%H", `${from}..HEAD`])
    .split("\n")
    .filter(Boolean);
  return hashes.map((h) => ({
    message: g(root, ["show", "-s", "--format=%B", h]),
    files: g(root, ["show", "--name-only", "--format=", h])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  }));
};

export function analyzeReleaseScope(
  root = process.cwd(),
): { level: Level | null; productPkgs: string[] } {
  const from = latestTag(root);
  if (from === null) {
    return { level: "minor", productPkgs: [...RELEASE_PACKAGES] };
  }
  const commits = commitsSince(root, from);
  const levels: Level[] = [];
  const pkgs = new Set<string>();
  for (const { message, files } of commits) {
    const touched = files.filter((f) => RELEASE_PACKAGES.some((p) => f.startsWith(`packages/${p}/`)));
    if (touched.length === 0) continue;
    const lvl = subjectLevel(message);
    if (lvl) levels.push(lvl);
    for (const p of RELEASE_PACKAGES) if (touched.some((f) => f.startsWith(`packages/${p}/`))) pkgs.add(p);
  }
  if (levels.length === 0) return { level: null, productPkgs: [...pkgs] };
  const level = levels.reduce<Level>((best, l) => (LEVEL_RANK[l] > LEVEL_RANK[best] ? l : best), "patch");
  return { level, productPkgs: [...pkgs] };
}

if (import.meta.main) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const { level } = analyzeReleaseScope(root);
  if (level) process.stdout.write(`${level}\n`);
}
