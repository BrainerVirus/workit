// Grants are read only from the OS account's default config dir (S16 review M3),
// never from $HOME or a config-dir override. Tests swap the grants home
// in-process (autonomy.grantsHome) and point the config override at the same
// directory, so grants and the rest of the config agree. Run grant-reading
// verbs in-process (main/run), never as a subprocess, so the swap applies.
//
// Since a missing seal falls back to the D4 defaults (#819), a home seals
// itself by default: each time the grants home is read, the workspaces.json
// it holds is sealed as the user's terminal would, so a test that writes the
// file and reads grants sees them as written. A test about the seal itself
// passes `{ seal: "manual" }`, or calls sealConfig, which turns the
// self-sealing off for that home. In-process only: no env var seals.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE, sealDocument } from "@/packages/workit-core/src/core/grant-seal";
import { configDir as workitConfigDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

export type ConfigHome = { home: string; configDir: string; restore: () => void };

/** Config dirs whose seal the test manages itself (sealConfig, `seal: "manual"`). */
const manual = new Set<string>();
/** The workspaces.json text each self-sealing dir last sealed. */
const lastSealed = new Map<string, string>();

const selfSeal = (configDir: string): void => {
  if (manual.has(configDir)) return;
  let text: string;
  try {
    text = readFileSync(path.join(configDir, "workspaces.json"), "utf8");
  } catch {
    return; // No file: nothing above the defaults to seal.
  }
  if (lastSealed.get(configDir) === text && existsSync(path.join(configDir, SEAL_FILE))) return;
  writeSeal(configDir, text);
  lastSealed.set(configDir, text);
};

export const useConfigHome = (
  prefix: string,
  options: { seal?: "self" | "manual" } = {},
): ConfigHome => {
  const previousConfig = process.env.WORKIT_CONFIG;
  const previousResolve = grantsHome.resolve;
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  // The grants dir for this home on this OS (APPDATA-style on Windows).
  const configDir = workitConfigDir({ HOME: home });
  mkdirSync(configDir, { recursive: true });
  if (options.seal === "manual") manual.add(configDir);
  grantsHome.resolve = () => {
    selfSeal(configDir);
    return home;
  };
  process.env.WORKIT_CONFIG = configDir;
  return {
    home,
    configDir,
    restore: () => {
      grantsHome.resolve = previousResolve;
      manual.delete(configDir);
      lastSealed.delete(configDir);
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
  manual.add(configDir);
  let text = "";
  try {
    text = readFileSync(path.join(configDir, "workspaces.json"), "utf8");
  } catch {
    // No file: an empty list.
  }
  writeSeal(configDir, text);
};

const writeSeal = (configDir: string, text: string): void => {
  let entries: unknown[] = [];
  try {
    entries = (JSON.parse(text) as { workspaces?: unknown[] }).workspaces ?? [];
  } catch {
    // Unreadable: an empty list.
  }
  writeFileSync(
    path.join(configDir, SEAL_FILE),
    `${JSON.stringify(sealDocument(entries, new Date()), null, 2)}\n`,
  );
};
