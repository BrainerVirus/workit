import { readFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config";

export type VcsProvider = "gitlab" | "github";

export type WorkspaceConfig = {
  name: string;
  glob: string;
  vcs?: { provider: VcsProvider; defaultTargetBranch?: string };
  youtrack?: { baseUrl?: string; link_issues?: boolean };
  issues?: { provider?: "github"; link_on_pr?: boolean };
};

export const workspacesPath = (): string => path.join(configDir(), "workspaces.json");

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

/** Parse the workspaces.json list under an explicit config dir; [] when missing/malformed. */
export const loadWorkspacesFrom = (dir: string): WorkspaceConfig[] => {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "workspaces.json"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { workspaces?: unknown }).workspaces;
  return Array.isArray(list) ? (list as WorkspaceConfig[]) : [];
};

/** Shared authoritative workspace matcher (WZ-12): the wizard's pattern
 *  preview and resolveWorkspaceFrom both route through it. */
export const matchWorkspace = (glob: string, target: string): boolean =>
  globToRegExp(glob.replaceAll("\\", "/")).test(target.replaceAll("\\", "/"));

/** Match a cwd against the workspaces.json under an explicit config dir. */
export const resolveWorkspaceFrom = (cwd: string, dir: string): WorkspaceConfig | null => {
  const cwdPosix = cwd.replaceAll("\\", "/");
  for (const entry of loadWorkspacesFrom(dir)) {
    if (!entry || typeof entry !== "object") continue;
    const ws = entry as WorkspaceConfig;
    if (typeof ws.glob !== "string" || !ws.glob) continue;
    if (matchWorkspace(ws.glob, cwdPosix)) return ws;
  }
  return null;
};

export const resolveWorkspace = (cwd: string): WorkspaceConfig | null =>
  resolveWorkspaceFrom(cwd, configDir());
