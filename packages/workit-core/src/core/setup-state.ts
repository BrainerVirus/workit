import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "./config";

// WZ-06: typed setup-state reader distinguishing missing from malformed
// configuration. Purely read-only — nothing here ever writes; Apply decision
// (Task 13/14) reads this state and refuses to proceed on malformed files.

export type FileState = {
  file: string;
  status: "missing" | "valid" | "malformed";
  error?: string;
};

export type SetupState = {
  configDir: string;
  config: FileState;
  youtrack: FileState;
  vcs: FileState;
  workspaces: FileState;
};

export const classifySetupFile = (dir: string, name: string): FileState => {
  const file = path.join(dir, name);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // An existing-but-unreadable file (EACCES) is NOT "missing": mutations must
    // never be generated against it. Report it as malformed so risky consumers
    // (wizard/installer/doctor) block on the exact path.
    if (existsSync(file)) {
      return { file, status: "malformed", error: `${file} is not readable` };
    }
    return { file, status: "missing" };
  }
  try {
    JSON.parse(raw);
  } catch {
    return { file, status: "malformed", error: `${file} is not valid JSON` };
  }
  return { file, status: "valid" };
};

export const readSetupState = (dir: string = resolveConfigDir()): SetupState => ({
  configDir: dir,
  config: classifySetupFile(dir, "config.json"),
  youtrack: classifySetupFile(dir, "youtrack.json"),
  vcs: classifySetupFile(dir, "vcs.json"),
  workspaces: classifySetupFile(dir, "workspaces.json"),
});
