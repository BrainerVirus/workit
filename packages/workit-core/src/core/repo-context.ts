import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { vcsConfig, mergedPrStyle } from "./vcs-config";

// Ports of scripts/_shared/common.sh + the four maintained context generators
// (pr-ready-context.sh, changelog-context.sh, docs-refresh-context.sh,
// release-notes-context.sh). Each generator returns the same stdout text shape
// the shell produced (## sections parsed by parse-sections.ts).

export type ContextResult = { stdout: string; stderr: string; exitCode: number; cwd: string };

const runGit = (
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trimEnd(),
    exitCode: result.status ?? 1,
  };
};

/** repo_root: git rev-parse --show-toplevel || pwd */
export const repoRoot = (cwd: string): string => {
  const r = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return r.exitCode === 0 && r.stdout ? r.stdout : cwd;
};

/** current_branch: git rev-parse --abbrev-ref HEAD || unknown */
export const currentBranch = (cwd: string): string => {
  const r = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.exitCode === 0 && r.stdout ? r.stdout : "unknown";
};

/** default_base: first of origin/main main origin/master master origin/develop develop, else HEAD~1 */
export const defaultBase = (cwd: string): string => {
  for (const ref of [
    "origin/main",
    "main",
    "origin/master",
    "master",
    "origin/develop",
    "develop",
  ]) {
    if (runGit(cwd, ["rev-parse", "--verify", ref]).exitCode === 0) return ref;
  }
  return "HEAD~1";
};

export const rangeArgOrDefault = (arg: string | undefined, cwd: string): string =>
  arg ? arg : `${defaultBase(cwd)}...HEAD`;

export const isProtectedBranch = (branch: string): boolean =>
  ["main", "master", "develop", "prod", "production"].includes(branch);

export const isPrBranch = (branch: string): boolean =>
  branch.startsWith("feature/") || branch.startsWith("bugfix/");

export type PrBranchContext = {
  baseRef: string;
  mergeBase: string;
  range: string;
  diffRange: string;
};

/** resolve_pr_branch_context: derive the branch-exclusive range from VCS config. */
export function resolvePrBranchContext(
  cwd: string,
): { ok: true; value: PrBranchContext } | { ok: false; error: string } {
  const branch = currentBranch(cwd);
  if (isProtectedBranch(branch)) {
    return {
      ok: false,
      error: `cannot build PR context on protected branch ${branch} — PRs are for feature/* or bugfix/* only`,
    };
  }
  if (!isPrBranch(branch)) {
    if (branch === "unknown") {
      return {
        ok: false,
        error: `not in a git repository at ${repoRoot(cwd)} — open the target repository as the OpenCode session directory`,
      };
    }
    return {
      ok: false,
      error: `branch ${branch} is not feature/* or bugfix/* — checkout a feature branch or pass an explicit git range`,
    };
  }

  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) {
    return { ok: false, error: String(resolved.error) };
  }
  const base = String(resolved.defaultTargetBranch ?? "");
  if (!base || runGit(cwd, ["check-ref-format", "--branch", base]).exitCode !== 0) {
    return { ok: false, error: `invalid configured PR target branch ${base}` };
  }

  for (const ref of [`origin/${base}`, base]) {
    if (runGit(cwd, ["rev-parse", "--verify", ref]).exitCode !== 0) continue;
    const mb = runGit(cwd, ["merge-base", ref, "HEAD"]);
    if (mb.exitCode !== 0 || !mb.stdout) continue;
    return {
      ok: true,
      value: {
        baseRef: ref,
        mergeBase: mb.stdout,
        range: `${ref}..HEAD`,
        diffRange: `${mb.stdout}..HEAD`,
      },
    };
  }
  return {
    ok: false,
    error: `configured PR target branch ${base} not found — fetch/checkout it or pass an explicit git range`,
  };
}

export function resolvePrRange(cwd: string): string | null {
  const ctx = resolvePrBranchContext(cwd);
  return ctx.ok ? ctx.value.range : null;
}

export const prRangeArgOrDefault = (arg: string | undefined, cwd: string): string | null =>
  arg ? arg : resolvePrRange(cwd);

export const printSection = (title: string): string => `\n## ${title}\n\n`;

// macOS/Windows filesystems are case-insensitive: existsSync() would match a
// differently-cased candidate, so the returned template_path must be the
// ACTUAL on-disk name. Probe each candidate directory case-insensitively and
// report the real entry — identical to the case-sensitive Linux probe, which
// only ever sees the exact on-disk name.
const probeCaseInsensitive = (dir: string, wanted: string): string | null => {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.toLowerCase() === wanted.toLowerCase()) return entry;
    }
  } catch {
    /* missing dir */
  }
  return null;
};

export const findPrTemplate = (cwd: string): string | null => {
  for (const rel of [
    ".gitlab/merge_request_templates/Default.md",
    ".gitlab/merge_request_templates/default.md",
    ".gitlab/merge_request_templates/merge_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
    "PULL_REQUEST_TEMPLATE.md",
  ]) {
    const parts = rel.split("/");
    const base = parts[parts.length - 1];
    const dir = parts.length > 1 ? path.join(cwd, ...parts.slice(0, -1)) : cwd;
    const actual = probeCaseInsensitive(dir, base);
    if (actual) return [...parts.slice(0, -1), actual].join("/");
  }
  return null;
};

export const fallbackPrTemplate = (): string => `## Summary
-

## Validation
- [ ] Not run`;

/** commit_log_for_range: git log --oneline --decorate --no-merges, falls back to -10. */
export const commitLogForRange = (cwd: string, range: string): string => {
  const r = runGit(cwd, ["log", "--oneline", "--decorate", "--no-merges", range, "--"]);
  if (r.exitCode === 0) return r.stdout;
  return runGit(cwd, ["log", "--oneline", "--decorate", "-10", "--"]).stdout;
};

export const changedFilesForRange = (cwd: string, range: string): string => {
  const r = runGit(cwd, ["diff", "--name-only", range, "--"]);
  if (r.exitCode === 0) return r.stdout;
  return runGit(cwd, ["diff", "--name-only", "--"]).stdout;
};

export const diffStatForRange = (cwd: string, range: string): string => {
  const r = runGit(cwd, ["diff", "--stat", range, "--"]);
  if (r.exitCode === 0) return r.stdout;
  return runGit(cwd, ["diff", "--stat", "--"]).stdout;
};

const packageScripts = (cwd: string, keys: string[]): string[] => {
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return keys
      .filter((k) => pkg.scripts && typeof pkg.scripts[k] === "string")
      .map((k) => `${k}: ${pkg.scripts?.[k]}`);
  } catch {
    return [];
  }
};

/** find . -maxdepth 3 -name README.md -o -name *.md with excludes, sorted, first 200. */
export const documentationFiles = (cwd: string): string[] => {
  const excluded = new Set([".git", "node_modules", "target", "dist"]);
  const matches: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && (entry.name === "README.md" || entry.name.endsWith(".md"))) {
        // Shell parity: the script printed "./path" with forward slashes even
        // on win32, where path.relative would otherwise emit backslashes.
        matches.push("./" + path.relative(cwd, path.join(dir, entry.name)).replaceAll("\\", "/"));
      }
    }
  };
  walk(cwd, 1);
  return matches.sort().slice(0, 200);
};

const readTrimmed = (file: string, maxLines: number): string => {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split("\n");
  return lines.slice(0, maxLines).join("\n");
};

/** Port of pr-ready-context.sh — PR-ready repository context. */
export function prReadyContext(root: string, range?: string): ContextResult {
  const cwd = path.resolve(repoRoot(root));
  let stdout = "";
  const autoRange = range === undefined;

  let ctx: { ok: true; value: PrBranchContext } | { ok: false; error: string } | null = null;
  if (autoRange) {
    ctx = resolvePrBranchContext(cwd);
    if (!ctx.ok) return { stdout: "", stderr: `ERROR: ${ctx.error}\n`, exitCode: 1, cwd };
    range = ctx.value.range;
  }

  stdout += printSection("Repository");
  stdout += `root: ${cwd}\n`;
  stdout += `branch: ${currentBranch(cwd)}\n`;
  stdout += `range: ${range}\n`;
  if (autoRange && ctx?.ok) {
    stdout += `base_ref: ${ctx.value.baseRef}\n`;
    stdout += `merge_base: ${ctx.value.mergeBase}\n`;
    stdout += `diff_range: ${ctx.value.diffRange}\n`;
    stdout += "range_mode: branch-exclusive\n";
    if (process.env.PR_SYNC_NOTES) stdout += `git_sync: ${process.env.PR_SYNC_NOTES}\n`;
  }
  const diffRange = autoRange && ctx?.ok ? ctx.value.diffRange : (range ?? "");

  stdout += printSection("Working Tree");
  const status = runGit(cwd, ["status", "--short"]);
  stdout += status.stdout + (status.stderr ? `\n${status.stderr}` : "");
  stdout += "\n";

  stdout += printSection("Commits");
  stdout += commitLogForRange(cwd, range ?? "");
  stdout += "\n";

  stdout += printSection("Diff Stat");
  stdout += diffStatForRange(cwd, diffRange);
  stdout += "\n";

  stdout += printSection("Changed Files");
  stdout += changedFilesForRange(cwd, diffRange);
  stdout += "\n";

  stdout += printSection("PR Template");
  const template = findPrTemplate(cwd);
  if (template) {
    stdout += `template_path: ${template}\n\n`;
    stdout += readTrimmed(path.join(cwd, template), 220);
  } else {
    stdout += "template_path: none\n\n";
    stdout += fallbackPrTemplate();
  }
  stdout += "\n";

  stdout += printSection("Recent Validation Signals");
  if (existsSync(path.join(cwd, "package.json"))) {
    stdout += "package.json detected. Common scripts:\n";
    const found = packageScripts(cwd, ["lint", "format:check", "test", "build"]);
    if (found.length) stdout += found.join("\n") + "\n";
  }
  if (
    existsSync(path.join(cwd, "Cargo.toml")) ||
    existsSync(path.join(cwd, "src-tauri/Cargo.toml"))
  ) {
    stdout += "Rust project detected.\n";
  }

  stdout += printSection("VCS Config");
  const vc = vcsConfig("resolve", cwd);
  if (vc.ok) {
    stdout += `workspace: ${String(vc.workspace_name ?? "none")}\n`;
    stdout += `provider: ${String(vc.provider ?? "gitlab")}\n`;
  } else {
    // RL-01: never report silent defaults for malformed vcs.json — surface the
    // exact-path diagnostic instead.
    stdout += `vcs: unreadable (malformed) — ${String(vc.error ?? "cannot read vcs.json")}\n`;
  }
  // B4: the shell printed only workspace:/provider: (the summary dump was
  // discarded). Keep that concise shape — no raw summary JSON in the context.
  if (!vcsConfig("summary", cwd).ok) {
    stdout += "vcs: not configured — run /wk-init action vcs_scaffold\n";
  }

  stdout += printSection("Merged PR Style");
  const style = mergedPrStyle(6, cwd);
  stdout += JSON.stringify(style, null, 2) + "\n";

  return { stdout, stderr: "", exitCode: 0, cwd };
}

const CHANGELOG_RULES = `- Use an [Unreleased] section.
- Use Added, Changed, Deprecated, Removed, Fixed, Security.
- Entries should be human-readable and user-facing.
- Do not use raw commit messages as changelog bullets.
- MERGE into existing ### Category under [Unreleased] — never append a second ### Added / ### Fixed block.
- Apply with the native workflow_changelog_apply tool only (not hand-edits under Unreleased).
- If Unreleased already has duplicate category headings, normalize_only first.`;

/** Port of changelog-context.sh — changelog update context. */
export function changelogContext(root: string, range?: string): ContextResult {
  const cwd = path.resolve(repoRoot(root));
  const resolvedRange = rangeArgOrDefault(range, cwd);
  let stdout = "";

  stdout += printSection("Repository");
  stdout += `root: ${cwd}\n`;
  stdout += `branch: ${currentBranch(cwd)}\n`;
  stdout += `range: ${resolvedRange}\n`;

  stdout += printSection("Keep a Changelog Rules");
  stdout += CHANGELOG_RULES + "\n";

  stdout += printSection("Existing CHANGELOG.md");
  const changelogPath = path.join(cwd, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    stdout += readTrimmed(changelogPath, 260) + "\n";
  } else {
    stdout += "CHANGELOG.md not found.\n";
  }

  stdout += printSection("Commits");
  stdout += commitLogForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Diff Stat");
  stdout += diffStatForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Changed Files");
  stdout += changedFilesForRange(cwd, resolvedRange) + "\n";

  return { stdout, stderr: "", exitCode: 0, cwd };
}

/** Port of docs-refresh-context.sh — documentation refresh context. */
export function docsRefreshContext(root: string, range?: string): ContextResult {
  const cwd = path.resolve(repoRoot(root));
  const resolvedRange = rangeArgOrDefault(range, cwd);
  let stdout = "";

  stdout += printSection("Repository");
  stdout += `root: ${cwd}\n`;
  stdout += `branch: ${currentBranch(cwd)}\n`;
  stdout += `range: ${resolvedRange}\n`;

  stdout += printSection("Changed Files");
  stdout += changedFilesForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Documentation Files");
  stdout += documentationFiles(cwd).join("\n") + "\n";

  stdout += printSection("README Preview");
  const readme = path.join(cwd, "README.md");
  if (existsSync(readme)) {
    stdout += readTrimmed(readme, 220) + "\n";
  } else {
    stdout += "README.md not found.\n";
  }

  stdout += printSection("Package Scripts");
  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      stdout +=
        JSON.stringify({ name: pkg.name, version: pkg.version, scripts: pkg.scripts }, null, 2) +
        "\n";
    } catch {
      /* unreadable package.json */
    }
  } else {
    stdout += "package.json not found.\n";
  }

  return { stdout, stderr: "", exitCode: 0, cwd };
}

/** Port of release-notes-context.sh — tags + commits + files for a range. */
export function releaseNotesContext(root: string, rangeOrTag: string): ContextResult {
  const cwd = path.resolve(repoRoot(root));
  if (!rangeOrTag) {
    return { stdout: "", stderr: "ERROR: release tag or range required\n", exitCode: 1, cwd };
  }
  const resolvedRange = rangeArgOrDefault(rangeOrTag, cwd);
  let stdout = "";

  stdout += printSection("Repository");
  stdout += `root: ${cwd}\n`;
  stdout += `branch: ${currentBranch(cwd)}\n`;
  stdout += `requested: ${rangeOrTag}\n`;
  stdout += `range: ${resolvedRange}\n`;

  stdout += printSection("Tags");
  const tags = runGit(cwd, ["tag", "--sort=-creatordate"]);
  if (tags.exitCode === 0) stdout += tags.stdout.split("\n").slice(0, 20).join("\n") + "\n";

  stdout += printSection("Commits");
  stdout += commitLogForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Diff Stat");
  stdout += diffStatForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Changed Files");
  stdout += changedFilesForRange(cwd, resolvedRange) + "\n";

  stdout += printSection("Existing Release Files");
  for (const rel of ["CHANGELOG.md", "RELEASE_NOTES.md", ".github/releases.md"]) {
    if (existsSync(path.join(cwd, rel))) stdout += rel + "\n";
  }

  return { stdout, stderr: "", exitCode: 0, cwd };
}
