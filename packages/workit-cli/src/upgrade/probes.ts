import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HostId } from "../admin/detect-hosts";
import { CLI_PACKAGE } from "../update-check";
import {
  OPENCODE_PACKAGE,
  asyncRunner,
  upgradePaths,
  type CommandResult,
  type UpgradeDeps,
} from "./shared";

/** How long one planning probe may take before its host reads "could not check". */
const PROBE_TIMEOUT_MS = 20_000;

/** The probe results planning reads, keyed by `command args…`. */
export type ProbeCache = Map<string, CommandResult>;

export const probeKey = (command: string, args: string[]): string => [command, ...args].join(" ");

/** OpenCode logs to its XDG data/state/cache dirs even for --version: point them at a throwaway place. */
export const opencodeScratchEnv = (deps: UpgradeDeps, scratch: string): NodeJS.ProcessEnv => ({
  ...deps.env,
  XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_STATE_HOME: path.join(scratch, "state"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
});

const registry = (name: string): [string, string[]] => ["npm", ["view", name, "version"]];

/**
 * Every command planning would run for these hosts (and the CLI), started at
 * once on the async runner, each bounded by its own timeout: planning then
 * takes about as long as the slowest probe, and a probe that hangs becomes a
 * timed-out result (its host's could-not-check row), never a hang.
 */
export const runProbes = async (
  hosts: HostId[],
  cli: boolean,
  deps: UpgradeDeps,
): Promise<ProbeCache> => {
  const paths = upgradePaths(deps);
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const run = asyncRunner(deps, timeoutMs);
  const probes: [string, string[], ReturnType<typeof asyncRunner>][] = [];
  const add = (command: string, args: string[], runner = run) =>
    probes.push([command, args, runner]);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-upgrade-opencode-"));
  try {
    if (hosts.includes("opencode") && existsSync(paths.opencodeConfig)) {
      const opencode = asyncRunner({ ...deps, env: opencodeScratchEnv(deps, scratch) }, timeoutMs);
      add("opencode", ["--version"], opencode);
      add("opencode", ["plugin", "--help"], opencode);
      add(...registry(OPENCODE_PACKAGE));
    }
    if (hosts.includes("cursor")) add(...registry("@brainervirus/workit-cursor"));
    if (hosts.includes("codex")) {
      add("codex", ["plugin", "list", "--json"]);
      add(...registry("@brainervirus/workit-codex"));
    }
    if (hosts.includes("pi")) {
      if (existsSync(paths.piSettings)) add("pi", ["list"]);
      add(...registry("@brainervirus/workit-pi"));
    }
    if (cli) {
      add("npm", ["root", "--global"]);
      add(...registry(CLI_PACKAGE));
    }
    const results = await Promise.all(
      probes.map(async ([command, args, runner]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<CommandResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: null,
                stdout: "",
                stderr: `\`${probeKey(command, args)}\` timed out after ${Math.round(timeoutMs / 1000)} s`,
                timedOut: true,
              }),
            timeoutMs,
          );
        });
        try {
          const result = await Promise.race([
            runner(command, args).catch((error: unknown): CommandResult => ({
              status: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
            })),
            timedOut,
          ]);
          return [probeKey(command, args), result] as const;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return new Map(results);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
