// Grants are read only from the OS account's default config dir (S16 review M3),
// never from $HOME or a config-dir override. Tests swap the grants home
// in-process (autonomy.grantsHome) and point the config override at the same
// directory, so grants and the rest of the config agree. Run grant-reading
// verbs in-process (main/run), never as a subprocess, so the swap applies.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE, sealDocument } from "@/packages/workit-core/src/core/grant-seal";
import { configDir as workitConfigDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

export type ConfigHome = {
  home: string;
  configDir: string;
  restore: () => void;
};

export const useConfigHome = (prefix: string): ConfigHome => {
  const previousConfig = process.env.WORKIT_CONFIG;
  const previousResolve = grantsHome.resolve;
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  // The grants dir for this home on this OS (APPDATA-style on Windows).
  const configDir = workitConfigDir({ HOME: home });
  mkdirSync(configDir, { recursive: true });
  grantsHome.resolve = () => home;
  process.env.WORKIT_CONFIG = configDir;
  return {
    home,
    configDir,
    restore: () => {
      grantsHome.resolve = previousResolve;
      if (previousConfig === undefined) delete process.env.WORKIT_CONFIG;
      else process.env.WORKIT_CONFIG = previousConfig;
      rmSync(home, { recursive: true, force: true });
    },
  };
};

/**
 * Seal the authority fields of `<configDir>/workspaces.json` as it is now
 * (#819), the way the user's terminal does; an absent file seals no entries.
 */
export const sealConfig = (configDir: string): void => {
  let entries: unknown[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path.join(configDir, "workspaces.json"), "utf8")) as {
      workspaces?: unknown[];
    };
    entries = parsed.workspaces ?? [];
  } catch {
    // No file: an empty list.
  }
  writeFileSync(
    path.join(configDir, SEAL_FILE),
    `${JSON.stringify(sealDocument(entries, new Date()), null, 2)}\n`,
  );
};
