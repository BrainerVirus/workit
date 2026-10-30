import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HostId } from "../admin/detect-hosts";
import { CLI_PACKAGE } from "../update-check";
import { CODEX_INVENTORY_ARGS, codexInventory } from "./codex-inventory";
import { OPENCODE_NOT_READY, waitForOpencodePlugin, type OpencodePlugin } from "./opencode";
import {
  CLAUDE_CODE_PACKAGE,
  OPENCODE_PACKAGE,
  asyncRunner,
  objectOrNull,
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

/** The cache key of OpenCode's readiness reading (see `opencodeReading`). */
const OPENCODE_READY_KEY = "opencode-ready";

/**
 * What the readiness probe learned: the Workit plugin as OpenCode reports it,
 * null when OpenCode never listed it in time, undefined when it was not probed.
 */
export const opencodeReading = (probes?: ProbeCache): OpencodePlugin | null | undefined => {
  const result = probes?.get(OPENCODE_READY_KEY);
  if (!result) return undefined;
  return result.status === 0 ? (JSON.parse(result.stdout) as OpencodePlugin) : null;
};

/** A Workit npm registration in opencode.json (a local checkout has no package to wait for). */
const opencodeRegistersWorkit = (file: string): boolean => {
  const config = objectOrNull(file);
  return [config?.plugins, config?.plugin]
    .flatMap((value: unknown) => (Array.isArray(value) ? value : []))
    .some(
      (pin: unknown) =>
        typeof pin === "string" &&
        /^(?:npm:)?@brainervirus\/workit-opencode(?:@[^/\s]+)?$/.test(pin),
    );
};

export type ProbeOptions = {
  /** `workit upgrade --check`: versions only, no OpenCode --version/--help probes. */
  check?: boolean;
};

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
  options: ProbeOptions = {},
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
      if (!options.check) {
        const opencode = asyncRunner(
          { ...deps, env: opencodeScratchEnv(deps, scratch) },
          timeoutMs,
        );
        add("opencode", ["--version"], opencode);
        add("opencode", ["plugin", "--help"], opencode);
      }
      add(...registry(OPENCODE_PACKAGE));
    }
    if (hosts.includes("claude-code")) add(...registry(CLAUDE_CODE_PACKAGE));
    if (hosts.includes("cursor")) add(...registry("@brainervirus/workit-cursor"));
    if (hosts.includes("codex")) {
      // The inventory merges several local commands: one probe, one timeout.
      add("codex", CODEX_INVENTORY_ARGS, () => codexInventory(run));
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
    // OpenCode's service: the real env (its plugin commands talk to the running
    // service), and its own readiness bound instead of the one-probe timeout.
    const ready =
      hosts.includes("opencode") && opencodeRegistersWorkit(paths.opencodeConfig)
        ? waitForOpencodePlugin(
            (command, args, where) =>
              run(command, args, where).catch((error: unknown): CommandResult => ({
                status: 1,
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
              })),
            paths.home,
            deps.opencodeReady,
          ).then((reading): [string, CommandResult] => [
            OPENCODE_READY_KEY,
            reading
              ? { status: 0, stdout: JSON.stringify(reading) }
              : { status: 1, stdout: "", stderr: OPENCODE_NOT_READY },
          ])
        : undefined;
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
    return new Map([...results, ...(ready ? [await ready] : [])]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
