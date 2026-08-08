import { readFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config";

export type VcsProvider = "gitlab" | "github";

export type WorkspaceConfig = {
  name: string;
  glob: string;
  vcs?: { provider: VcsProvider; defaultTargetBranch?: string };
  youtrack?: { baseUrl?: string; link_issues?: boolean };
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
          // trailing ** also matches the bare parent: /x/y/** -> /x/y and /x/y/deep
          if (i + 2 >= glob.length) {
            if (out.endsWith("/")) out = out.slice(0, -1);
            out += "(?:/.*)?";
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

export const resolveWorkspace = (cwd: string): WorkspaceConfig | null => {
  let raw: string;
  try {
    raw = readFileSync(workspacesPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const list = (parsed as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return null;
  const cwdPosix = cwd.split(path.sep).join("/");
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const ws = entry as WorkspaceConfig;
    if (typeof ws.glob !== "string" || !ws.glob) continue;
    if (globToRegExp(ws.glob).test(cwdPosix)) return ws;
  }
  return null;
};
