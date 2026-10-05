// Grants are read only from the OS account's ~/.config/workit (S16 review M3),
// never from $HOME or a config-dir override. Tests swap the grants home
// in-process (autonomy.grantsHome) and point the config override at the same
// directory, so grants and the rest of the config agree. Run grant-reading
// verbs in-process (main/run), never as a subprocess, so the swap applies.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";

export type ConfigHome = { home: string; configDir: string; restore: () => void };

export const useConfigHome = (prefix: string): ConfigHome => {
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousResolve = grantsHome.resolve;
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(home, ".config", "workit");
  mkdirSync(configDir, { recursive: true });
  grantsHome.resolve = () => home;
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  return {
    home,
    configDir,
    restore: () => {
      grantsHome.resolve = previousResolve;
      if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
      rmSync(home, { recursive: true, force: true });
    },
  };
};
