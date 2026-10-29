import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { type HostId } from "../admin/detect-hosts";
import { hostCommand, runHostCommand, type HostInstallCommand } from "../admin/host-install";
import { type DoctorCheck } from "../admin/doctor";
import { type Progress } from "../progress";
import { workitConfigDir } from "../update-settings";

/** Hosts `workit launch` can start. */
export const LAUNCH_HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi"];
/** Hosts `workit upgrade` covers. */
export const HOSTS: HostId[] = [...LAUNCH_HOSTS, "claude-code"];
/** Hosts that load an updated plugin without a stopped boundary: OpenCode V2
 *  reloads plugins live; Claude Code loads the new version on its next session. */
export const LIVE_HOSTS = new Set<HostId>(["opencode", "claude-code"]);
export const OPENCODE_PACKAGE = "@brainervirus/workit-opencode";
export const OPENCODE_UPDATE = `opencode plugin update ${OPENCODE_PACKAGE}`;
export const CODEX_MARKETPLACE = "workflow-toolkit";
export const CLI_FIX = "npm install --global @brainervirus/workit-cli@latest";

export type Command = {
  command: string;
  args: string[];
  purpose?: string;
} & Partial<HostInstallCommand>;
export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr?: string;
  /** A planning probe that did not answer in time (its host reads "could not check"). */
  timedOut?: boolean;
};
export type UpgradeHost = HostId | "cli" | "permissions";

/** The last few lines of a command's stderr, for a failed row's reason. */
export const stderrTail = (text: string | undefined, lines = 5): string =>
  (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");

/** "`cmd args` failed" plus the stderr tail when the command printed one. */
export const failureReason = (
  command: { command: string; args: string[] },
  result: CommandResult,
): string => {
  const tail = stderrTail(result.stderr);
  return `\`${command.command} ${command.args.join(" ")}\` failed${tail ? `: ${tail}` : ""}`;
};
/** One process the OS lists: `ps -eo pid=,stat=,args=` (or tasklist on Windows). */
export type HostProcess = { pid: number; state: string; args: string };
/** What upgrade did for one host; the run ends with one row per host. */
export type HostOutcome = {
  host: UpgradeHost;
  status: "updated" | "current" | "skipped" | "failed";
  reason: string;
  /** The one command that finishes this host by hand. */
  fix?: string;
};
export type UpgradeDeps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => CommandResult;
  /** Async runner for the apply phase (test seam; defaults to `run`, else a bounded spawn). */
  runAsync?: (command: string, args: string[]) => Promise<CommandResult>;
  /** Legacy seam: hosts with an open interactive session. */
  activeHosts?: () => HostId[];
  /** Running processes (test seam; default reads `ps`; null = unreadable). */
  processes?: () => HostProcess[] | null;
  /** The one confirmation before applying (default asks on the terminal). */
  confirm?: (question: string) => Promise<boolean>;
  /** The closing verification (default: doctor's upgrade checks). */
  doctor?: (cliVersion: string) => { checks: DoctorCheck[] };
  out?: { write: (text: string) => void };
  /** Step feedback on stderr (default: none; the CLI passes a TTY spinner). */
  progress?: Progress;
  /** The per-host rows of an applied upgrade (the launch check names failed hosts). */
  onResult?: (hosts: HostOutcome[]) => void;
  /** How long one planning probe may run (test seam; default 20 s). */
  probeTimeoutMs?: number;
  /** The CLI version the running entry has on disk now (test seam; default reads its package.json). */
  cliOnDisk?: () => string | undefined;
  /** Run `workit upgrade <argv>` with the newly installed CLI and extra env; its exit code,
   *  or undefined when it could not start (test seam; default spawns the same entry script). */
  reexec?: (
    argv: string[],
    env: Record<string, string>,
  ) => number | undefined | Promise<number | undefined>;
};
export type Source = {
  host: HostId;
  selector: string;
  installedVersion?: string;
  kind: "floating" | "pinned" | "local" | "repair";
};
export type PlanEntry = {
  host: HostId;
  selector: string;
  /** Empty when the host resolves the version itself (Claude Code, OpenCode). */
  latest: string;
  /** OpenCode: the published version its own update resolves to, when the registry answered. */
  published?: string;
  commands: Command[];
  /** A registered host whose plugin files are missing: reinstall, never just update. */
  repair?: boolean;
  installedVersion?: string;
  fix: string;
};
export type UpgradePlan = {
  ok: boolean;
  /** Global stops: nothing is applied while one is present. */
  blocked: string[];
  /** Hosts whose state could not be read; the others still upgrade. */
  failed: HostOutcome[];
  skipped: { host: UpgradeHost; reason: string; fix?: string }[];
  entries: PlanEntry[];
  configDigests: Record<string, string>;
  cli?: { latest: string; root: string; installed: string };
  migrations: { id: string; file: string; description: string }[];
  /** Advisories that do not block the upgrade (e.g. an OpenCode 1.x host). */
  warnings?: string[];
};

export const fixFor = (host: UpgradeHost, selector = ""): string =>
  host === "pi"
    ? `pi update --extension ${selector || "npm:@brainervirus/workit-pi"}`
    : host === "codex"
      ? `codex plugin marketplace upgrade ${CODEX_MARKETPLACE} && codex plugin add workit@${CODEX_MARKETPLACE}`
      : host === "claude-code"
        ? "claude plugin marketplace update workit && claude plugin update workit@workit"
        : host === "opencode"
          ? OPENCODE_UPDATE
          : host === "cursor"
            ? "workit upgrade --hosts=cursor"
            : CLI_FIX;

export const upgradePaths = (deps: UpgradeDeps) => {
  const home = deps.home ?? deps.env?.HOME ?? os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(deps.home || deps.env?.HOME
      ? {
          HOME: home,
          CODEX_HOME: path.join(home, ".codex"),
          CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
          PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
          XDG_CONFIG_HOME: path.join(home, ".config"),
          WORKFLOW_TOOLKIT_CONFIG: undefined,
          WORKFLOW_TOOLKIT_CONFIG_DIR: undefined,
        }
      : {}),
    ...deps.env,
    HOME: home,
  };
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
  return {
    home,
    env,
    configDir: workitConfigDir(env),
    opencodeConfig: path.join(xdg, "opencode/opencode.json"),
    piSettings: path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"), "settings.json"),
    codexHome,
    codexConfig: path.join(codexHome, "config.toml"),
    cursorRoot: path.join(home, ".cursor/plugins/local/workit"),
  };
};

export const object = (file: string): Record<string, any> | null => {
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON; use the native host to inspect JSONC settings`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${file} is not a configuration object`);
  return data as Record<string, any>;
};
export const objectOrNull = (file: string): Record<string, any> | null => {
  try {
    return object(file);
  } catch {
    return null;
  }
};
export const digest = (file: string): string =>
  existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
export const runner = (deps: UpgradeDeps) =>
  deps.run ??
  ((command: string, args: string[]): CommandResult => {
    const { home, env } = upgradePaths(deps);
    let step: HostInstallCommand;
    try {
      step = hostCommand(command, args, { home, env });
    } catch (error) {
      return { status: 1, stdout: "", stderr: errorText(error) };
    }
    const result = runHostCommand(step, { home, env });
    return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  });

const COMMAND_TIMEOUT_MS = 60_000;

/**
 * The apply phase's runner: same result shape and the same 60 s bound as the
 * sync one, but a spawn, so the progress spinner keeps ticking while npm or a
 * host CLI works.
 */
export const asyncRunner = (
  deps: UpgradeDeps,
  timeoutMs = COMMAND_TIMEOUT_MS,
): ((command: string, args: string[]) => Promise<CommandResult>) => {
  if (deps.runAsync) return deps.runAsync;
  const injected = deps.run;
  if (injected) return async (command, args) => injected(command, args);
  return (command, args) => {
    const { home, env } = upgradePaths(deps);
    let step: HostInstallCommand;
    try {
      step = hostCommand(command, args, { home, env });
    } catch (error) {
      return Promise.resolve({ status: 1, stdout: "", stderr: errorText(error) });
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(step.command))
      return Promise.resolve({
        status: 1,
        stdout: "",
        stderr: `Cannot safely execute batch shim ${step.command}`,
      });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HOME: home };
    childEnv.CODEX_HOME = env.CODEX_HOME ?? path.join(home, ".codex");
    childEnv.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
    childEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
    childEnv.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    return new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(step.command, step.args, {
          cwd: step.cwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        resolve({ status: 1, stdout: "", stderr: errorText(error) });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(1);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
      child.on("error", (error) => {
        stderr += error.message;
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
  };
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "installed source could not be read";
}

// Pi lists the configured source followed by its resolved package directory.
// Confirm the package identity and version rather than accepting a source name alone.
export const piInstalledVersion = (listing: string, selector: string): string | undefined => {
  const lines = listing.split(/\r?\n/).map((line) => line.trim());
  const index = lines.indexOf(selector);
  if (index < 0 || !lines[index + 1] || !path.isAbsolute(lines[index + 1])) return undefined;
  const found = objectOrNull(path.join(lines[index + 1], "package.json"));
  return found?.name === "@brainervirus/workit-pi" ? found.version : undefined;
};

export const versionAtLeast = (installed: string, latest: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(installed)) return false;
  const current = installed.split(".").map(Number);
  const target = latest.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (current[index] !== target[index]) return current[index] > target[index];
  }
  return true;
};

export const registryVersion = (
  run: ReturnType<typeof runner>,
  name: string,
): string | undefined => {
  const latest = run("npm", ["view", name, "version"]);
  const version = latest.stdout.trim();
  return latest.status === 0 && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
};
