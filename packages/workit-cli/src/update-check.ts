// The launch-time update check: like the Codex CLI, an interactive human
// launch of a stale Workit offers the full upgrade (`workit upgrade --yes`:
// the CLI and every host plugin together), or runs it when `updates` is
// `auto`. The command itself never waits on the network: the latest version
// comes from a cache in Workit state, refreshed by a detached, silent child
// once the 24 h window has passed. Every other launch (a pipe, CI, --json, an
// agent host's shell, a hook) skips all of it and stays byte-identical.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { isPromptAbort } from "./prompt";
import { createStyle, terminalMode, type TerminalStream } from "./style";
import { registryVersion, runner, versionAtLeast } from "./upgrade/shared";

export const CLI_PACKAGE = "@brainervirus/workit-cli";
/** How long a registry answer (or a failed lookup) is trusted, and how long "skip for now" lasts. */
export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Set on the re-executed command and on the refresh child: neither checks again. */
const QUIET_ENV = "WORKIT_UPDATE_CHECK";
/** Marks the detached child that refreshes the cache (main.ts runs only that). */
const REFRESH_ENV = "WORKIT_UPDATE_REFRESH";

import {
  readUpdateCache,
  readUpdatesMode,
  writeUpdateCache,
  writeUpdatesMode,
  type UpdateCache,
} from "./update-settings";

export { readUpdateCache, readUpdatesMode, writeUpdateCache, writeUpdatesMode, type UpdateCache };

/**
 * Environment markers of an agent host's shell or tool process. A human's own
 * terminal has none of them; the config-location variables a person may
 * export in a shell profile (CODEX_HOME, PI_CODING_AGENT_DIR) do not count.
 */
const AGENT_VARIABLES = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
const AGENT_PREFIXES = ["CODEX_", "OPENCODE", "CURSOR_", "PI_"];
const PROFILE_VARIABLES = new Set(["CODEX_HOME", "PI_CODING_AGENT_DIR"]);

export const agentHostMarker = (env: NodeJS.ProcessEnv): string | undefined =>
  Object.keys(env).find(
    (key) =>
      env[key] !== undefined &&
      !PROFILE_VARIABLES.has(key) &&
      (AGENT_VARIABLES.has(key) || AGENT_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );

/** Commands that never check: the upgrade itself, and the ones that load nothing. */
const SILENT_COMMANDS = new Set([
  undefined,
  "upgrade",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
]);

export type LaunchContext = {
  /** The command line exactly as typed (re-executed after an upgrade). */
  argv: readonly string[];
  command: string | undefined;
  json: boolean;
};

/** What the full upgrade reports back: its exit code and the rows that failed. */
export type UpgradeOutcome = { code: number; failed: { host: string; fix?: string }[] };

export type LaunchDeps = {
  env: NodeJS.ProcessEnv;
  stdin: { isTTY?: boolean };
  /** Any redirection (stdout included) makes the launch non-interactive. */
  stdout: { isTTY?: boolean };
  stderr: TerminalStream;
  write: (text: string) => void;
  now?: () => number;
  /** The running CLI version (test seam). */
  installed?: string;
  /** Start the detached cache refresh (default: a silent child process). */
  refresh?: () => void;
  /** Ask one line on the terminal. */
  ask?: (question: string) => Promise<string>;
  /** The full upgrade: `workit upgrade --yes`, its report on stderr. */
  upgrade?: () => Promise<UpgradeOutcome>;
  /** The CLI package version now on disk (test seam; default reads the entry's package.json). */
  cliOnDisk?: () => string | undefined;
  /** Run the original command with the upgraded binary; returns its exit code. */
  reexec?: (argv: readonly string[]) => number | undefined;
};

/** Only a person at a terminal is ever asked or upgraded. */
export const interactiveLaunch = (context: LaunchContext, deps: LaunchDeps): boolean =>
  !SILENT_COMMANDS.has(context.command) &&
  deps.env[QUIET_ENV] !== "0" &&
  deps.stdin.isTTY === true &&
  deps.stdout.isTTY === true &&
  deps.stderr.isTTY === true &&
  terminalMode({ stream: deps.stderr, env: deps.env, json: context.json }) !== "off" &&
  agentHostMarker(deps.env) === undefined;

/**
 * Run before the command. Returns the exit code of the re-executed command
 * after an upgrade, or undefined to run the command in this process as usual.
 */
export async function launchUpdateCheck(
  context: LaunchContext,
  deps: LaunchDeps,
): Promise<number | undefined> {
  if (!interactiveLaunch(context, deps)) return undefined;
  const mode = readUpdatesMode(deps.env);
  if (mode === "off") return undefined;
  const now = (deps.now ?? Date.now)();
  const cache = readUpdateCache(deps.env);
  if (cache.checkedAt === undefined || now - cache.checkedAt >= UPDATE_TTL_MS) {
    // Claim the window first so concurrent launches start one refresh, not many.
    writeUpdateCache(deps.env, { ...cache, checkedAt: now });
    (deps.refresh ?? (() => startRefresh(deps.env)))();
  }
  const installed = deps.installed ?? pkg.version;
  const latest = cache.latest;
  if (!latest || versionAtLeast(installed, latest)) return undefined;
  // "Skip for now", or an upgrade already tried in this window (an npx or
  // linked CLI that `workit upgrade` leaves alone): quiet until the TTL passes.
  if (cache.snoozedAt !== undefined && now - cache.snoozedAt < UPDATE_TTL_MS) return undefined;
  const style = createStyle({ stream: deps.stderr, env: deps.env });
  if (mode === "prompt") {
    if (cache.skipped === latest) return undefined;
    let answer: string;
    try {
      answer = await (deps.ask ?? defaultAsk)(
        `${style.bold("Workit update available:")} ${installed} -> ${style.ok(latest)}  ${style.command("[u]")}pgrade now / ${style.command("[s]")}kip for now / ${style.command("[n]")}ever for this version: `,
      );
    } catch (error) {
      // Ctrl-C or Ctrl-D: the user cancelled the launch itself (as prompt.ts).
      if (!isPromptAbort(error)) return undefined;
      deps.write("\nCancelled.\n");
      return CANCELLED_EXIT;
    }
    const choice = answer.trim().toLowerCase();
    if (choice === "n" || choice === "never") {
      writeUpdateCache(deps.env, {
        ...readUpdateCache(deps.env),
        skipped: latest,
      });
      return undefined;
    }
    if (choice !== "u" && choice !== "upgrade") {
      writeUpdateCache(deps.env, {
        ...readUpdateCache(deps.env),
        snoozedAt: now,
      });
      return undefined;
    }
  } else {
    deps.write(
      `${style.bold("Workit update:")} upgrading ${installed} -> ${latest} (CLI and host plugins; updates=auto)\n`,
    );
  }
  writeUpdateCache(deps.env, { ...readUpdateCache(deps.env), snoozedAt: now });
  const outcome = await (deps.upgrade ?? defaultUpgrade)();
  if (outcome.code !== 0 && outcome.failed.length)
    deps.write(
      `${style.warn("Upgrade incomplete:")} ${outcome.failed
        .map((row) => `${row.host} failed${row.fix ? ` (fix: ${row.fix})` : ""}`)
        .join("; ")}\n`,
    );
  // Re-execute only when the CLI package on disk really changed: an upgrade
  // that left it alone (a failure, an npx or linked CLI) never loops.
  const onDisk = (deps.cliOnDisk ?? defaultCliOnDisk)();
  if (!onDisk || onDisk === installed) {
    if (outcome.code !== 0)
      deps.write(
        `${style.warn("Upgrade did not finish;")} running your command with ${installed}.\n`,
      );
    return undefined;
  }
  return (deps.reexec ?? defaultReexec)(context.argv);
}

/** 128 + SIGINT, as prompt.ts uses for a cancelled question. */
const CANCELLED_EXIT = 130;

/** The version in the package.json of the running entry's package, as it is on disk now. */
const defaultCliOnDisk = (): string | undefined => {
  const script = process.argv[1];
  if (!script) return undefined;
  let dir = path.dirname(script);
  for (let depth = 0; depth < 4; depth += 1, dir = path.dirname(dir)) {
    try {
      const found = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (found.name === CLI_PACKAGE && typeof found.version === "string") return found.version;
    } catch {
      // not here; look one level up
    }
  }
  return undefined;
};

const defaultAsk = async (question: string): Promise<string> =>
  (await import("./prompt")).askLine(question, process.stderr);

/** `workit upgrade --yes` with its whole report on stderr: the command's stdout stays its own. */
const defaultUpgrade = async (): Promise<UpgradeOutcome> => {
  const failed: UpgradeOutcome["failed"] = [];
  const code = await (
    await import("./upgrade")
  ).runUpgradeCommand(["--yes"], {
    out: process.stderr,
    onResult: (hosts) => {
      for (const row of hosts)
        if (row.status === "failed") failed.push({ host: row.host, fix: row.fix });
    },
  });
  return { code, failed };
};

/** The same entry script, now the upgraded package on disk, with the same argv. */
const defaultReexec = (argv: readonly string[]): number | undefined => {
  const script = process.argv[1];
  if (!script) return undefined;
  const result = spawnSync(process.execPath, [script, ...argv], {
    stdio: "inherit",
    env: { ...process.env, [QUIET_ENV]: "0" },
  });
  return result.error ? undefined : (result.status ?? 1);
};

/** A detached child that asks the registry once and exits; no output, no wait. */
const startRefresh = (env: NodeJS.ProcessEnv): void => {
  const script = process.argv[1];
  if (!script) return;
  try {
    spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, [REFRESH_ENV]: "1", [QUIET_ENV]: "0" },
    }).unref();
  } catch {
    // silent by design
  }
};

/** The refresh child's whole job: one bounded `npm view`, one cache write. */
export const refreshUpdateCache = (
  env: NodeJS.ProcessEnv,
  options: { run?: ReturnType<typeof runner>; now?: () => number } = {},
): void => {
  let latest: string | undefined;
  try {
    latest = registryVersion(options.run ?? runner({ env }), CLI_PACKAGE);
  } catch {
    latest = undefined;
  }
  const cache = readUpdateCache(env);
  writeUpdateCache(env, {
    ...cache,
    checkedAt: (options.now ?? Date.now)(),
    ...(latest ? { latest } : {}),
  });
};
