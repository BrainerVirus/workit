import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { configDir, isConfigObject, type BranchPreset } from "./config";

export type VcsProvider = "gitlab" | "github";

export type IntegrationMode = "pr" | "merge";

export type WorkspaceBranchPolicy = {
  preset: BranchPreset;
  developBranch?: string;
  prefixes?: { feature: string; bugfix: string; release: string; hotfix: string };
  allowed?: string[];
  protected?: string[];
  integration: IntegrationMode;
};

export type WorkspaceConfig = {
  name: string;
  glob: string;
  vcs?: { provider: VcsProvider; defaultTargetBranch?: string };
  youtrack?: { baseUrl?: string; link_issues?: boolean };
  issues?: { provider?: "github"; link_on_pr?: boolean };
  branchPolicy?: WorkspaceBranchPolicy;
};

export const workspacesPath = (): string => path.join(configDir(), "workspaces.json");

// RL-01: typed workspaces reader. Missing is a legitimate unconfigured state
// (empty list); malformed JSON is reported with the exact path so risky
// consumers (wizard/installer/doctor) can block instead of silently resetting.
export type WorkspacesResult = {
  status: "missing" | "valid" | "malformed";
  path: string;
  entries: WorkspaceConfig[];
  error?: string;
};

export const readWorkspacesResult = (dir: string = configDir()): WorkspacesResult => {
  const file = path.join(dir, "workspaces.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { status: "missing", path: file, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", path: file, entries: [], error: `${file} is not valid JSON` };
  }
  if (!isConfigObject(parsed)) {
    return { status: "malformed", path: file, entries: [], error: `${file} is not a JSON object` };
  }
  const list = (parsed as { workspaces?: unknown }).workspaces;
  return {
    status: "valid",
    path: file,
    entries: Array.isArray(list) ? (list as WorkspaceConfig[]) : [],
  };
};

/** Parse the workspaces.json list under an explicit config dir; [] when missing/malformed. */
export const loadWorkspacesFrom = (dir: string): WorkspaceConfig[] =>
  readWorkspacesResult(dir).entries;

// ponytail: only globstar (`**`) is supported; if more minimatch parity is needed
// (char classes, braces, `?`), swap this matcher for the minimatch dependency.
const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // **/ matches zero or more segments; a leading **/ also consumes the leading slash
          if (out === "") out += "/?";
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          // trailing ** also matches the bare parent: /x/y/** -> /x/y and /x/y/deep.
          // (?:/.*)? only when the prefix ends with / (POSIX absolute); otherwise
          // the trailing ** must match any remainder, e.g. a bare ** against a
          // drive-letter cwd like D:/a/x.
          if (i + 2 >= glob.length) {
            if (out.endsWith("/")) {
              out = out.slice(0, -1);
              out += "(?:/.*)?";
            } else {
              out += ".*";
            }
          } else {
            out += ".*";
          }
          i++;
        }
      } else {
        out += "[^/]*";
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
};

/** Shared authoritative workspace matcher (WZ-12): the wizard's pattern
 *  preview and resolveWorkspaceFrom both route through it. */
export const matchWorkspace = (glob: string, target: string): boolean =>
  globToRegExp(glob.replaceAll("\\", "/")).test(target.replaceAll("\\", "/"));

// RL-08: the matcher above implements `*` and `**` only. Classic glob
// metacharacters it would otherwise store as literals (char classes, `?`,
// brace expansion) are rejected at write time so a saved pattern never
// silently matches nothing (Task 15 advisory: unsupported patterns were
// accepted and shown as "no match").
const UNSUPPORTED_GLOB = /[?[\]{}]/;

// B3: `!`-negation and extglob prefixes (@(...), +(...), *(...)) are the same
// no-match trap — the matcher stores them as literals, so `!**` or `@(a|b)`
// silently matches nothing. Reject them at write time too; the Task 15 match
// preview still routes through matchWorkspace (literals -> no match) and is
// unchanged.
const UNSUPPORTED_EXTGLOB = /[@+*]\(|!/;

export type GlobValidation = { ok: true } | { ok: false; error: string };

export const validateWorkspaceGlob = (glob: string): GlobValidation => {
  const trimmed = glob.trim();
  if (!trimmed) return { ok: false, error: "workspace pattern is required" };
  const m = UNSUPPORTED_GLOB.exec(trimmed);
  if (m) {
    return {
      ok: false,
      error: `unsupported glob character ${JSON.stringify(m[0])} in workspace pattern ${JSON.stringify(glob)} — the matcher supports * and ** only (e.g. /work/**)`,
    };
  }
  const ext = UNSUPPORTED_EXTGLOB.exec(trimmed);
  if (ext) {
    const token = ext[0];
    const kind = token === "!" ? "negation (!)" : `extglob (${token})`;
    return {
      ok: false,
      error: `unsupported glob ${kind} in workspace pattern ${JSON.stringify(glob)} — the matcher supports * and ** only (e.g. /work/**)`,
    };
  }
  return { ok: true };
};

const realpathOf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Rebuild a glob with the realpath of its static prefix, so a config glob
// written with the logical path also matches a canonical target (and vice
// versa). The glob metacharacters themselves are left untouched.
const canonicalGlob = (glob: string): string => {
  const m = /[*?[\]{]/.exec(glob);
  const prefix = m ? glob.slice(0, m.index) : glob;
  const rest = m ? glob.slice(m.index) : "";
  if (!prefix) return glob;
  const real = realpathOf(prefix.replace(/\/+$/, "") || "/");
  return real + (prefix.endsWith("/") ? "/" : "") + rest;
};

/** Match a cwd against the workspaces.json under an explicit config dir. */
export const resolveWorkspaceFrom = (cwd: string, dir: string): WorkspaceConfig | null => {
  // macOS/Windows tmpdir symlinks (/var -> /private/var): git's
  // --show-toplevel returns the realpath while config globs are usually
  // written with the logical path, so a workspace would silently stop
  // matching on macOS. Match both forms on each side — same class as the
  // docs-migration escape-guard realpath comparison; on Linux both forms
  // are identical so behavior is unchanged.
  const targets = [cwd, realpathOf(cwd)].map((p) => p.replaceAll("\\", "/"));
  for (const entry of loadWorkspacesFrom(dir)) {
    if (!entry || typeof entry !== "object") continue;
    const ws = entry as WorkspaceConfig;
    if (typeof ws.glob !== "string" || !ws.glob) continue;
    const glob = ws.glob.replaceAll("\\", "/");
    const canonical = canonicalGlob(glob);
    for (const target of targets) {
      if (matchWorkspace(glob, target)) return ws;
      if (canonical !== glob && matchWorkspace(canonical, target)) return ws;
    }
  }
  return null;
};

export const resolveWorkspace = (cwd: string): WorkspaceConfig | null =>
  resolveWorkspaceFrom(cwd, configDir());
