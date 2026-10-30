// Fixtures for the "PATH node is below the floor" launcher tests: an env with no
// version manager and an empty home (so a scan finds nothing on a developer
// machine), and a fake node that records how the launcher re-ran it.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const scratchDir = (prefix = "wk-hook-node-"): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const MANAGER_VARS = new Set([
  "WORKIT_NODE",
  "WORKIT_HOOK_REEXEC",
  "FNM_DIR",
  "NVM_DIR",
  "NVM_HOME",
  "VOLTA_HOME",
  "MISE_DATA_DIR",
  "ASDF_DATA_DIR",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
]);

/** process.env without version managers: HOME and the state dir are empty scratch dirs. */
export const bareNodeEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const home = scratchDir("wk-home-");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !MANAGER_VARS.has(key)) env[key] = value;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
    ...extra,
  };
};

/**
 * A stand-in for a Node >= 24: prints its argv after `ARGV`, copies stdin to
 * stdout, reports the guard and version env on stderr and exits 3.
 */
export const fakeNode = (dir = scratchDir("wk-fake-node-")): string => {
  const file = path.join(dir, "node");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'echo "ARGV $*"',
      "cat",
      'echo "guard=$WORKIT_HOOK_REEXEC version=${WORKIT_HOOK_NODE_VERSION-unset}" >&2',
      "exit 3",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
};
