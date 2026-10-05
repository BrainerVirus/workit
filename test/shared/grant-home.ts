// Grants are read only from $HOME/.config/workit (S16 review M3). Tests that
// configure workspaces point HOME at a temp directory and the config override
// at that same directory, so grants and the rest of the config agree.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConfigHome = { home: string; configDir: string; restore: () => void };

export const useConfigHome = (prefix: string): ConfigHome => {
  const previous = {
    HOME: process.env.HOME,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
  };
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(home, ".config", "workit");
  mkdirSync(configDir, { recursive: true });
  process.env.HOME = home;
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  return {
    home,
    configDir,
    restore: () => {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(home, { recursive: true, force: true });
    },
  };
};
