import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  cpSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import pkg from "../package.json" with { type: "json" };
import { isWorkitPlugin } from "./admin/registration";
import { readSetupState } from "./admin/setup-state";
import { type HostId } from "./admin/detect-hosts";
import {
  claudeWorkitInstalls,
  hostCommand,
  planHostInstall,
  runHostCommand,
  type HostInstallCommand,
} from "./admin/host-install";
import { applySetupPreview, type SetupPreview } from "./admin/setup";
import { OPENCODE_V1_FIX, runDoctor, type DoctorCheck } from "./admin/doctor";
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import {
  applyHostPermissions,
  permissionDiff,
  planHostPermissions,
} from "./admin/host-permissions";

/** Hosts `workit launch` can start. */
const LAUNCH_HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi"];
/** Hosts `workit upgrade` covers. */
const HOSTS: HostId[] = [...LAUNCH_HOSTS, "claude-code"];
/** Hosts that load an updated plugin without a stopped boundary: OpenCode V2
 *  reloads plugins live; Claude Code loads the new version on its next session. */
const LIVE_HOSTS = new Set<HostId>(["opencode", "claude-code"]);
const OPENCODE_PACKAGE = "@brainervirus/workit-opencode";
const OPENCODE_UPDATE = `opencode plugin update ${OPENCODE_PACKAGE}`;
const CODEX_MARKETPLACE = "workflow-toolkit";
const CLI_FIX = "npm install --global @brainervirus/workit-cli@latest";

type Command = {
  command: string;
  args: string[];
  purpose?: string;
} & Partial<HostInstallCommand>;
type CommandResult = { status: number | null; stdout: string };
type UpgradeHost = HostId | "cli";
/** One process the OS lists: `ps -eo pid=,stat=,args=` (or tasklist on Windows). */
export type HostProcess = { pid: number; state: string; args: string };
/** What upgrade did for one host; the run ends with one row per host. */
type HostOutcome = {
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
  /** Legacy seam: hosts with an open interactive session. */
  activeHosts?: () => HostId[];
  /** Running processes (test seam; default reads `ps`; null = unreadable). */
  processes?: () => HostProcess[] | null;
  /** The one confirmation before applying (default asks on the terminal). */
  confirm?: (question: string) => Promise<boolean>;
  /** The closing verification (default: doctor's upgrade checks). */
  doctor?: (cliVersion: string) => { checks: DoctorCheck[] };
  out?: { write: (text: string) => void };
};
type Source = {
  host: HostId;
  selector: string;
  installedVersion?: string;
  kind: "floating" | "pinned" | "local" | "repair";
};
type PlanEntry = {
  host: HostId;
  selector: string;
  /** Empty when the host resolves the version itself (Claude Code, OpenCode). */
  latest: string;
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

const fixFor = (host: UpgradeHost, selector = ""): string =>
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

const upgradePaths = (deps: UpgradeDeps) => {
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
    configDir:
      env.WORKFLOW_TOOLKIT_CONFIG ?? env.WORKFLOW_TOOLKIT_CONFIG_DIR ?? path.join(xdg, "workit"),
    opencodeConfig: path.join(xdg, "opencode/opencode.json"),
    piSettings: path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"), "settings.json"),
    codexHome,
    codexConfig: path.join(codexHome, "config.toml"),
    cursorRoot: path.join(home, ".cursor/plugins/local/workit"),
  };
};

const object = (file: string): Record<string, any> | null => {
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
const objectOrNull = (file: string): Record<string, any> | null => {
  try {
    return object(file);
  } catch {
    return null;
  }
};
const digest = (file: string): string =>
  existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
const runner = (deps: UpgradeDeps) =>
  deps.run ??
  ((command: string, args: string[]): CommandResult => {
    const { home, env } = upgradePaths(deps);
    let step: HostInstallCommand;
    try {
      step = hostCommand(command, args, { home, env });
    } catch {
      return { status: 1, stdout: "" };
    }
    const result = runHostCommand(step, { home, env });
    return { status: result.exitCode, stdout: result.stdout };
  });

const classify = (host: HostId, selector: string): Source => ({
  host,
  selector,
  kind:
    selector === `@brainervirus/workit-${host}` ||
    selector === `@brainervirus/workit-${host}@latest` ||
    selector === `npm:@brainervirus/workit-${host}` ||
    selector === `npm:@brainervirus/workit-${host}@latest`
      ? "floating"
      : new RegExp(`^(?:npm:)?@brainervirus/workit-${host}@[^/]+$`).test(selector)
        ? "pinned"
        : "local",
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "installed source could not be read";

// Read only owned registrations. A checkout or intentional exact pin is never
// converted into a floating package as a side effect of upgrading another host.
// Each host is read on its own: one unreadable host fails only that host.
const sources = (
  paths: ReturnType<typeof upgradePaths>,
  run: ReturnType<typeof runner>,
  hosts: HostId[],
  failed: HostOutcome[],
): Source[] => {
  const { home } = paths;
  const result: Source[] = [];
  const guard = (host: HostId, read: () => void) => {
    if (!hosts.includes(host)) return;
    try {
      read();
    } catch (error) {
      failed.push({
        host,
        status: "failed",
        reason: errorText(error),
        fix: fixFor(host),
      });
    }
  };
  guard("opencode", () => {
    if (existsSync(paths.opencodeConfig + "c"))
      throw new Error(
        "OpenCode JSONC config is present; inspect effective native configuration before updating",
      );
    const oc = object(paths.opencodeConfig);
    if (oc && [oc.plugins, oc.plugin].some((value) => value !== undefined && !Array.isArray(value)))
      throw new Error("OpenCode plugin registrations must be arrays");
    for (const pin of [...(oc?.plugins ?? []), ...(oc?.plugin ?? [])])
      if (typeof pin === "string" && isWorkitPlugin(pin)) result.push(classify("opencode", pin));
  });
  guard("cursor", () => {
    const cursor = objectOrNull(path.join(paths.cursorRoot, "package.json"));
    const mcp = objectOrNull(path.join(home, ".cursor/mcp.json"));
    const args: unknown[] = mcp?.mcpServers?.workit?.args ?? [];
    const arg = args.find((value) => typeof value === "string" && value.startsWith("--package="));
    const selector = typeof arg === "string" ? arg.slice(10) : "local";
    if (cursor?.name === "@brainervirus/workit-cursor") {
      result.push({
        ...classify("cursor", selector),
        installedVersion: cursor.version,
      });
      return;
    }
    // Registered (MCP server or plugin dir) but the plugin files are missing or
    // broken: reinstall them with the installer the init wizard uses.
    const settings = objectOrNull(path.join(home, ".cursor/settings.json"));
    const dirs: unknown[] = Array.isArray(settings?.plugin_dirs) ? settings.plugin_dirs : [];
    const registered =
      mcp?.mcpServers?.workit !== undefined ||
      dirs.some((dir) =>
        String(dir).replaceAll("\\", "/").replace(/\/+$/, "").endsWith("local/workit"),
      );
    if (registered) result.push({ host: "cursor", selector, kind: "repair" });
  });
  guard("pi", () => {
    const pi = object(paths.piSettings);
    if (pi?.packages !== undefined && !Array.isArray(pi.packages))
      throw new Error("Pi package registrations must be an array");
    for (const entry of pi?.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string") continue;
      const npm = /^(?:npm:)?@brainervirus\/workit-pi(?:@[^/]+)?$/.test(source);
      const local =
        path.isAbsolute(source) &&
        source.replaceAll("\\", "/").endsWith("/packages/workit-pi") &&
        object(path.join(source, "package.json"))?.name === "@brainervirus/workit-pi";
      if (!npm && !local) continue;
      const found = classify("pi", source);
      if (found.kind === "floating") {
        const inventory = run("pi", ["list"]);
        if (inventory.status === 0)
          found.installedVersion = piInstalledVersion(inventory.stdout, source);
      }
      result.push(found);
    }
  });
  guard("codex", () => {
    const listing = run("codex", ["plugin", "list", "--json"]);
    if (listing.status !== 0) {
      let available = false;
      try {
        hostCommand("codex", [], { home, env: paths.env });
        available = true;
      } catch {
        /* absent host */
      }
      if (available || existsSync(paths.codexConfig))
        throw new Error("Codex plugin inventory failed; inspect the native host before upgrading");
      return;
    }
    let installed: Record<string, any>[];
    try {
      installed = JSON.parse(listing.stdout).installed ?? [];
    } catch {
      throw new Error("Codex plugin inventory could not be parsed");
    }
    if (!Array.isArray(installed)) throw new Error("Codex plugin inventory is malformed");
    for (const plugin of installed) {
      if (plugin.name !== "workit") continue;
      const source = plugin.source;
      const npm =
        plugin.marketplaceName === CODEX_MARKETPLACE &&
        source?.source === "npm" &&
        source?.package === "@brainervirus/workit-codex";
      result.push({
        ...classify(
          "codex",
          npm ? `${source.package}${source.version ? `@${source.version}` : ""}` : "local",
        ),
        installedVersion: plugin.version,
      });
    }
  });
  guard("claude-code", () => {
    // User-scope installs only: a project install belongs to that project.
    for (const install of claudeWorkitInstalls(home, paths.env, null))
      result.push({
        host: "claude-code",
        selector: install.id,
        kind: "floating",
        installedVersion: install.version ?? undefined,
      });
  });
  return result;
};

// Pi lists the configured source followed by its resolved package directory.
// Confirm the package identity and version rather than accepting a source name alone.
const piInstalledVersion = (listing: string, selector: string): string | undefined => {
  const lines = listing.split(/\r?\n/).map((line) => line.trim());
  const index = lines.indexOf(selector);
  if (index < 0 || !lines[index + 1] || !path.isAbsolute(lines[index + 1])) return undefined;
  const found = objectOrNull(path.join(lines[index + 1], "package.json"));
  return found?.name === "@brainervirus/workit-pi" ? found.version : undefined;
};

const versionAtLeast = (installed: string, latest: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(installed)) return false;
  const current = installed.split(".").map(Number);
  const target = latest.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (current[index] !== target[index]) return current[index] > target[index];
  }
  return true;
};

/** Run an OpenCode probe with its XDG data/state/cache dirs in a throwaway
 *  place: OpenCode logs there even for --version and --help. */
const opencodeProbe = (deps: UpgradeDeps, args: string[]): CommandResult => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-upgrade-opencode-"));
  try {
    return runner({
      ...deps,
      env: {
        ...deps.env,
        XDG_DATA_HOME: path.join(scratch, "data"),
        XDG_STATE_HOME: path.join(scratch, "state"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
      },
    })("opencode", args);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const registryVersion = (run: ReturnType<typeof runner>, name: string): string | undefined => {
  const latest = run("npm", ["view", name, "version"]);
  const version = latest.stdout.trim();
  return latest.status === 0 && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
};

export function previewUpgrade(hosts: HostId[] = HOSTS, deps: UpgradeDeps = {}): UpgradePlan {
  const paths = upgradePaths(deps);
  const { home, configDir } = paths;
  const run = runner(deps);
  const state = readSetupState(configDir);
  const plan: UpgradePlan = {
    ok: true,
    blocked: [],
    failed: [],
    skipped: [],
    entries: [],
    configDigests: {},
    migrations: [],
  };
  for (const file of [state.config, state.workspaces, state.youtrack, state.vcs]) {
    if (file.status === "malformed") plan.blocked.push(file.error ?? file.file);
    plan.configDigests[file.file] = digest(file.file);
  }
  for (const file of [
    paths.opencodeConfig,
    paths.opencodeConfig + "c",
    path.join(home, ".cursor/settings.json"),
    path.join(home, ".cursor/mcp.json"),
    path.join(paths.cursorRoot, "package.json"),
    paths.codexConfig,
    paths.piSettings,
  ])
    plan.configDigests[file] = digest(file);
  try {
    const config = object(state.config.file);
    if (config && Object.hasOwn(config, "trustedPaths"))
      plan.migrations.push({
        id: "2.0-remove-ignored-trusted-paths",
        file: state.config.file,
        description: "Remove ignored Workit trustedPaths; native host permissions remain unchanged",
      });
  } catch (error) {
    plan.blocked.push(errorText(error));
  }
  const installedSources = sources(paths, run, hosts, plan.failed);
  // Workit 3 ships only the OpenCode V2 plugin entry: warn before an upgrade
  // leaves a 1.x host with a plugin it cannot load. Unknown versions stay quiet.
  let opencodeHelp: string | undefined;
  if (installedSources.some((source) => source.host === "opencode")) {
    const probe = opencodeProbe(deps, ["--version"]);
    const installed = probe.status === 0 ? probe.stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
    if (installed && !versionAtLeast(installed, SUPPORT_MATRIX.opencode.minimum))
      (plan.warnings ??= []).push(`opencode ${installed}: ${OPENCODE_V1_FIX}`);
  }
  for (const host of ["opencode", "pi"] as const) {
    if (
      new Set(
        installedSources.filter((source) => source.host === host).map((source) => source.selector),
      ).size > 1
    )
      plan.failed.push({
        host,
        status: "failed",
        reason:
          "conflicting Workit registrations; reconcile them in the native host before upgrading",
      });
  }
  const conflicted = new Set(plan.failed.map((entry) => entry.host));
  for (const source of installedSources.filter(
    (candidate, index, list) =>
      !conflicted.has(candidate.host) &&
      list.findIndex(
        (entry) => entry.host === candidate.host && entry.selector === candidate.selector,
      ) === index,
  )) {
    if (source.kind === "pinned" || source.kind === "local") {
      plan.skipped.push({
        host: source.host,
        reason: `${source.kind} source preserved; change its source explicitly to upgrade`,
      });
      continue;
    }
    if (source.host === "claude-code") {
      const [market] = source.selector.split("@").slice(1);
      plan.entries.push({
        host: "claude-code",
        selector: source.selector,
        latest: "",
        installedVersion: source.installedVersion,
        commands: [
          {
            command: "claude",
            args: ["plugin", "marketplace", "update", market ?? "workit"],
          },
          { command: "claude", args: ["plugin", "update", source.selector] },
        ],
        fix: `claude plugin marketplace update ${market ?? "workit"} && claude plugin update ${source.selector}`,
      });
      continue;
    }
    if (source.host === "opencode") {
      // OpenCode 2.2+ updates one named plugin (`opencode plugin update <pkg>`);
      // an OpenCode without it is skipped, never updated wholesale.
      opencodeHelp ??= opencodeProbe(deps, ["plugin", "--help"]).stdout;
      if (!/^\s*(?:opencode\s+plugin\s+)?update\b/m.test(opencodeHelp)) {
        plan.skipped.push({
          host: "opencode",
          reason:
            "this OpenCode has no `opencode plugin update`; upgrade OpenCode, then run the fix. Workit never updates unrelated plugins",
          fix: OPENCODE_UPDATE,
        });
        continue;
      }
      plan.entries.push({
        host: "opencode",
        selector: source.selector,
        latest: "",
        commands: [{ command: "opencode", args: ["plugin", "update", OPENCODE_PACKAGE] }],
        fix: OPENCODE_UPDATE,
      });
      continue;
    }
    const latest = registryVersion(run, `@brainervirus/workit-${source.host}`);
    if (!latest) {
      plan.failed.push({
        host: source.host,
        status: "failed",
        reason: "registry version unavailable; existing installation preserved",
        fix: fixFor(source.host, source.selector),
      });
      continue;
    }
    if (source.installedVersion && versionAtLeast(source.installedVersion, latest)) {
      plan.skipped.push({
        host: source.host,
        reason: `already current (${source.installedVersion})`,
      });
      continue;
    }
    const commands: Command[] =
      source.host === "pi"
        ? [{ command: "pi", args: ["update", "--extension", source.selector] }]
        : source.host === "codex"
          ? [
              {
                command: "codex",
                args: ["plugin", "marketplace", "upgrade", CODEX_MARKETPLACE],
              },
              {
                command: "codex",
                args: ["plugin", "add", `workit@${CODEX_MARKETPLACE}`, "--json"],
              },
            ]
          : planHostInstall("cursor", {
              home,
              env: deps.env,
              cwd: home,
              packageVersion: latest,
              targetDir: paths.cursorRoot,
            });
    plan.entries.push({
      host: source.host,
      selector: source.selector,
      latest,
      commands,
      installedVersion: source.installedVersion,
      ...(source.kind === "repair" ? { repair: true } : {}),
      fix: fixFor(source.host, source.selector),
    });
  }
  plan.ok = plan.blocked.length === 0 && plan.failed.length === 0;
  return plan;
}

/** A host process that matters to an upgrade: an interactive session Workit
 *  never kills, or a background daemon the host's own command can stop. */
type Running = HostProcess & { host: HostId; kind: "session" | "daemon" };

const PROCESS_HOSTS: Record<string, HostId> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
};

/** Classify one listed process. Zombies, and helpers that load no plugin
 *  (Codex's `app-server daemon pid-update-loop` watcher), are not running hosts. */
export const classifyProcess = (proc: HostProcess): Running | null => {
  if (proc.state.startsWith("Z") || proc.args.includes("<defunct>")) return null;
  const argv0 = proc.args.trim().split(/\s+/)[0] ?? "";
  const name = path
    .basename(argv0.replaceAll("\\", "/"))
    .replace(/^\[|\]$/g, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const host = PROCESS_HOSTS[name];
  if (!host) return null;
  if (host === "codex" && /\bapp-server\b/.test(proc.args))
    return /\bdaemon\s+pid-update-loop\b/.test(proc.args)
      ? null
      : { ...proc, host, kind: "daemon" };
  if (host === "opencode" && /\bserve\b/.test(proc.args)) return { ...proc, host, kind: "daemon" };
  return { ...proc, host, kind: "session" };
};

const listProcesses = (deps: UpgradeDeps): HostProcess[] | null => {
  if (deps.processes) return deps.processes();
  if (deps.activeHosts)
    return deps.activeHosts().map((host) => ({ pid: 0, state: "S", args: host }));
  const run = runner(deps);
  if (process.platform === "win32") {
    const list = run("tasklist", ["/fo", "csv", "/nh"]);
    if (list.status !== 0) return null;
    return list.stdout.split(/\r?\n/).flatMap((line) => {
      const [image, pid] = line.split('","').map((cell) => cell.replaceAll('"', ""));
      return image && /^\d+$/.test(pid ?? "")
        ? [{ pid: Number(pid), state: "R", args: image }]
        : [];
    });
  }
  const list = run("ps", ["-eo", "pid=,stat=,args="]);
  if (list.status !== 0) return null;
  return list.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), state: match[2], args: match[3] }] : [];
  });
};

const describe = (proc: Running): string =>
  `pid ${proc.pid}: ${proc.args.length > 120 ? `${proc.args.slice(0, 117)}...` : proc.args}`;

/** The newest Workit Codex plugin Codex cached (what its launcher installs agents from). */
const codexPluginRoot = (codexHome: string): string | null => {
  const dir = path.join(codexHome, "plugins", "cache", CODEX_MARKETPLACE, "workit");
  let versions: string[] = [];
  try {
    versions = readdirSync(dir).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  } catch {
    return null;
  }
  const newest = versions.reduce<string | null>(
    (best, version) => (best && versionAtLeast(best, version) ? best : version),
    null,
  );
  return newest ? path.join(dir, newest) : null;
};

export type UpgradeResult = {
  ok: boolean;
  backup?: string;
  error?: string;
  hosts: HostOutcome[];
};

/** Apply one plan entry; any thrown error stays this host's failure. */
const applyEntry = (
  entry: PlanEntry,
  context: {
    run: ReturnType<typeof runner>;
    paths: ReturnType<typeof upgradePaths>;
    configDir: string;
  },
): HostOutcome => {
  const { run, paths, configDir } = context;
  const { home, env } = paths;
  const fail = (reason: string): HostOutcome => ({
    host: entry.host,
    status: "failed",
    reason,
    fix: entry.fix,
  });
  if (entry.host === "cursor") {
    // The init wizard's installer: setup's install-host + install-adapter
    // mutations, scoped to Cursor; workspaces and other config stay untouched.
    const preview: SetupPreview = {
      ok: true,
      blocked: [],
      preserved: [],
      overrides: [],
      platforms: ["cursor"],
      state: readSetupState(configDir),
      mutations: [
        {
          type: "install-host",
          platform: "cursor",
          path: path.join(home, ".cursor/plugins/local/.workit-package-bootstrap"),
          commands: entry.commands.map((command) => ({
            ...command,
            purpose: command.purpose ?? "Upgrade Cursor",
          })),
        },
        { type: "install-adapter", platform: "cursor", path: paths.cursorRoot },
      ],
    };
    const result = applySetupPreview(preview, {
      home,
      env,
      cwd: home,
      preferInstalledAdapter: true,
      runHostCommand: (command) => {
        const outcome = run(command.command, command.args);
        return {
          exitCode: outcome.status ?? 1,
          stdout: outcome.stdout,
          stderr: "",
        };
      },
    });
    const installed = objectOrNull(path.join(paths.cursorRoot, "package.json"));
    if (!result.ok || installed?.version !== entry.latest)
      return fail(
        "Cursor install did not verify the requested package version; inspect the installer before retrying",
      );
    return {
      host: "cursor",
      status: "updated",
      reason: entry.repair
        ? `reinstalled missing plugin files (${entry.latest})`
        : `${entry.installedVersion ?? "?"} -> ${entry.latest}`,
    };
  }
  for (const command of entry.commands)
    if (run(command.command, command.args).status !== 0)
      return fail(`\`${command.command} ${command.args.join(" ")}\` failed`);
  if (entry.host === "opencode")
    return {
      host: "opencode",
      status: "updated",
      reason: "scoped update ran; OpenCode V2 loads it live",
    };
  if (entry.host === "claude-code") {
    const after = claudeWorkitInstalls(home, env, null).find(
      (install) => install.id === entry.selector,
    )?.version;
    return after && after === entry.installedVersion
      ? {
          host: "claude-code",
          status: "current",
          reason: `already current (${after})`,
        }
      : {
          host: "claude-code",
          status: "updated",
          reason: `${entry.installedVersion ?? "?"} -> ${after ?? "?"}; new sessions load it`,
        };
  }
  const verify =
    entry.host === "codex" ? run("codex", ["plugin", "list", "--json"]) : run("pi", ["list"]);
  if (verify.status !== 0) return fail("update verification failed");
  if (entry.host === "codex") {
    let installed: Record<string, any>[] = [];
    try {
      installed = JSON.parse(verify.stdout).installed ?? [];
    } catch {
      /* fail closed below */
    }
    if (
      !installed.some(
        (plugin) =>
          plugin.name === "workit" &&
          plugin.marketplaceName === CODEX_MARKETPLACE &&
          plugin.version === entry.latest,
      )
    )
      return fail("Codex did not report the requested Workit version");
  }
  if (entry.host === "pi" && piInstalledVersion(verify.stdout, entry.selector) !== entry.latest)
    return fail("Pi did not report the requested Workit package version");
  return {
    host: entry.host,
    status: "updated",
    reason: `${entry.installedVersion ?? "?"} -> ${entry.latest}`,
  };
};

/** Codex agents live outside the plugin: its launcher copies them (doctor's codex_agents fix). */
const refreshCodexAgents = (
  run: ReturnType<typeof runner>,
  codexHome: string,
): { ok: boolean; note: string; fix?: string } => {
  const root = codexPluginRoot(codexHome);
  const launcher = root && path.join(root, "dist", "launch-mcp.js");
  if (!launcher || !existsSync(launcher)) return { ok: true, note: "" };
  const fix = `node ${JSON.stringify(launcher)} --install-agents`;
  return run("node", [launcher, "--install-agents"]).status === 0
    ? { ok: true, note: "agents refreshed" }
    : { ok: false, note: "agent refresh failed", fix };
};

export function applyUpgrade(plan: UpgradePlan, deps: UpgradeDeps = {}): UpgradeResult {
  const hosts: HostOutcome[] = [...plan.failed];
  const done = (backup?: string): UpgradeResult => {
    const failures = hosts.filter((entry) => entry.status === "failed");
    return {
      ok: failures.length === 0,
      ...(backup ? { backup } : {}),
      ...(failures.length
        ? {
            error: failures.map((entry) => `${entry.host}: ${entry.reason}`).join("; "),
          }
        : {}),
      hosts,
    };
  };
  for (const skipped of plan.skipped)
    hosts.push({
      host: skipped.host,
      status: skipped.reason.startsWith("already current") ? "current" : "skipped",
      reason: skipped.reason,
      ...(skipped.fix ? { fix: skipped.fix } : {}),
    });
  if (plan.blocked.length) return { ok: false, error: plan.blocked.join("; "), hosts };
  if (!plan.entries.length && !plan.migrations.length && !plan.cli) return done();
  for (const [file, expected] of Object.entries(plan.configDigests))
    if (digest(file) !== expected)
      return {
        ok: false,
        error: `configuration changed; preview again: ${file}`,
        hosts,
      };
  const paths = upgradePaths(deps);
  const { home, configDir } = paths;
  const backup = path.join(
    home,
    ".local/state/workit/upgrades",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const file of Object.keys(plan.configDigests))
    if (existsSync(file)) {
      const target = path.join(
        backup,
        createHash("sha256").update(file).digest("hex").slice(0, 12) + "-" + path.basename(file),
      );
      copyFileSync(file, target);
      chmodSync(target, 0o600);
    }
  for (const migration of plan.migrations) {
    const value = object(migration.file);
    if (migration.id !== "2.0-remove-ignored-trusted-paths" || !value)
      return {
        ok: false,
        backup,
        error: "Unknown configuration migration; upgrade the CLI before applying",
        hosts,
      };
    delete value.trustedPaths;
    writeFileAtomic(migration.file, JSON.stringify(value, null, 2) + "\n", 0o600);
  }
  const run = runner(deps);
  // A failed backup fails only Cursor's row: never repair without one.
  let cursorBackupError: string | null = null;
  if (plan.entries.some((entry) => entry.host === "cursor") && existsSync(paths.cursorRoot))
    try {
      cpSync(paths.cursorRoot, path.join(backup, "cursor-package"), { recursive: true });
    } catch (error) {
      cursorBackupError = `could not back up the Cursor plugin: ${errorText(error)}`;
    }
  const listed = plan.entries.length ? listProcesses(deps) : [];
  const running = (listed ?? []).flatMap((entry) => classifyProcess(entry) ?? []);
  for (const entry of plan.entries) {
    if (entry.host === "cursor" && cursorBackupError) {
      hosts.push({ host: "cursor", status: "failed", reason: cursorBackupError, fix: entry.fix });
      continue;
    }
    if (!LIVE_HOSTS.has(entry.host)) {
      if (listed === null) {
        hosts.push({
          host: entry.host,
          status: "skipped",
          reason: `running processes could not be listed; close ${entry.host} and rerun`,
          fix: `workit upgrade --hosts=${entry.host}`,
        });
        continue;
      }
      const sessions = running.filter(
        (proc) => proc.host === entry.host && proc.kind === "session",
      );
      if (sessions.length) {
        hosts.push({
          host: entry.host,
          status: "skipped",
          reason: `close ${entry.host} (${sessions.map(describe).join("; ")}), then rerun`,
          fix: `workit upgrade --hosts=${entry.host}`,
        });
        continue;
      }
    }
    // Codex's app-server daemon holds the plugin: stop it with Codex's own
    // command and always start it again, whatever the update did.
    const daemons = running.filter((proc) => proc.host === "codex" && proc.kind === "daemon");
    const stopDaemon = entry.host === "codex" && daemons.length > 0;
    if (stopDaemon && run("codex", ["app-server", "daemon", "stop"]).status !== 0) {
      hosts.push({
        host: "codex",
        status: "failed",
        reason: `could not stop the Codex app-server daemon (${daemons.map(describe).join("; ")})`,
        fix: "codex app-server daemon stop && workit upgrade --hosts=codex",
      });
      continue;
    }
    // Everything between the daemon's stop and start is caught, so the start
    // below always runs.
    let outcome: HostOutcome;
    try {
      outcome = applyEntry(entry, { run, paths, configDir });
      if (entry.host === "codex" && outcome.status === "updated") {
        const agents = refreshCodexAgents(run, paths.codexHome);
        if (!agents.ok)
          outcome = {
            ...outcome,
            status: "failed",
            reason: `${outcome.reason}; ${agents.note}`,
            fix: agents.fix,
          };
        else if (agents.note) outcome = { ...outcome, reason: `${outcome.reason}; ${agents.note}` };
      }
    } catch (error) {
      outcome = {
        host: entry.host,
        status: "failed",
        reason: errorText(error),
        fix: entry.fix,
      };
    }
    if (stopDaemon) {
      const started = run("codex", ["app-server", "daemon", "start"]).status === 0;
      outcome = started
        ? {
            ...outcome,
            reason: `${outcome.reason}; app-server daemon stopped and started again`,
          }
        : {
            ...outcome,
            status: "failed",
            reason: `${outcome.reason}; the app-server daemon did not start again`,
            fix: "codex app-server daemon start",
          };
    }
    if (entry.host === "opencode") {
      const servers = running.filter((proc) => proc.host === "opencode" && proc.kind === "daemon");
      if (servers.length && outcome.status === "updated")
        outcome = {
          ...outcome,
          reason: `${outcome.reason}; restart opencode serve (${servers.map(describe).join("; ")}) to load it`,
        };
    }
    hosts.push(outcome);
  }
  // Codex already current: its agent copies can still lag behind the plugin.
  if (hosts.some((entry) => entry.host === "codex" && entry.status === "current")) {
    let agents: ReturnType<typeof refreshCodexAgents>;
    try {
      agents = refreshCodexAgents(run, paths.codexHome);
    } catch (error) {
      agents = {
        ok: false,
        note: `agent refresh failed: ${errorText(error)}`,
        fix: "workit upgrade --hosts=codex",
      };
    }
    const index = hosts.findIndex((entry) => entry.host === "codex" && entry.status === "current");
    if (!agents.ok)
      hosts[index] = {
        ...hosts[index],
        status: "failed",
        reason: agents.note,
        fix: agents.fix,
      };
    else if (agents.note)
      hosts[index] = {
        ...hosts[index],
        reason: `${hosts[index].reason}; ${agents.note}`,
      };
  }
  if (plan.cli)
    try {
      hosts.push(applyCli(plan.cli, run, backup));
    } catch (error) {
      hosts.push({ host: "cli", status: "failed", reason: errorText(error), fix: CLI_FIX });
    }
  return done(backup);
}

const applyCli = (
  cli: NonNullable<UpgradePlan["cli"]>,
  run: ReturnType<typeof runner>,
  backup: string,
): HostOutcome => {
  const fail = (reason: string): HostOutcome => ({
    host: "cli",
    status: "failed",
    reason,
    fix: CLI_FIX,
  });
  const currentRoot = run("npm", ["root", "--global"]);
  if (currentRoot.status !== 0 || currentRoot.stdout.trim() !== cli.root)
    return fail("Global npm location changed; preview again");
  const cliBackup = path.join(backup, "cli-package");
  cpSync(path.join(cli.root, "@brainervirus/workit-cli"), cliBackup, {
    recursive: true,
  });
  if (run("npm", ["install", "--global", `@brainervirus/workit-cli@${cli.latest}`]).status !== 0)
    return fail(
      `CLI update failed; preserved package at ${cliBackup}; use npm to repair or run node ${path.join(cliBackup, "dist/index.js")}`,
    );
  const installed = objectOrNull(path.join(cli.root, "@brainervirus/workit-cli/package.json"));
  if (installed?.name !== "@brainervirus/workit-cli" || installed.version !== cli.latest)
    return fail(
      `CLI update did not verify the requested version; preserved package at ${cliBackup}`,
    );
  return {
    host: "cli",
    status: "updated",
    reason: `${cli.installed} -> ${cli.latest}`,
  };
};

/** The global CLI, part of every default upgrade: only a managed npm global
 *  install is touched; a local link or npx use is left as it is. */
const planCli = (plan: UpgradePlan, run: ReturnType<typeof runner>): void => {
  const root = run("npm", ["root", "--global"]);
  if (root.status !== 0 || !path.isAbsolute(root.stdout.trim())) {
    plan.skipped.push({
      host: "cli",
      reason: "global npm location could not be verified",
      fix: CLI_FIX,
    });
    return;
  }
  const packageFile = path.join(root.stdout.trim(), "@brainervirus/workit-cli/package.json");
  const installed = objectOrNull(packageFile);
  if (
    installed?.name !== "@brainervirus/workit-cli" ||
    lstatSync(path.dirname(packageFile)).isSymbolicLink()
  ) {
    plan.skipped.push({
      host: "cli",
      reason:
        "no managed global CLI install (local links preserved); use npx @brainervirus/workit-cli@latest",
    });
    return;
  }
  const latest = registryVersion(run, "@brainervirus/workit-cli");
  if (!latest)
    plan.failed.push({
      host: "cli",
      status: "failed",
      reason: "CLI registry version unavailable; existing installation preserved",
      fix: CLI_FIX,
    });
  else if (!versionAtLeast(installed.version, latest)) {
    plan.cli = {
      latest,
      root: root.stdout.trim(),
      installed: installed.version,
    };
    plan.configDigests[packageFile] = digest(packageFile);
  } else
    plan.skipped.push({
      host: "cli",
      reason: `already current (${installed.version})`,
    });
};

const pad = (text: string) => text.padEnd(12);

const summary = (plan: UpgradePlan, permissions: { host: string; file: string }[]): string => {
  const lines = ["Workit upgrade plan:"];
  if (plan.cli) lines.push(`  ${pad("cli")}update ${plan.cli.installed} -> ${plan.cli.latest}`);
  for (const entry of plan.entries) {
    const what = entry.repair
      ? `reinstall missing plugin files (${entry.latest})`
      : entry.latest
        ? `update ${entry.installedVersion ?? "?"} -> ${entry.latest}`
        : `update (${entry.commands.map((c) => `${c.command} ${c.args.join(" ")}`).join(" && ")})`;
    lines.push(`  ${pad(entry.host)}${what}`);
  }
  for (const skipped of plan.skipped)
    lines.push(
      `  ${pad(skipped.host)}${skipped.reason.startsWith("already current") ? "" : "skip: "}${skipped.reason}${skipped.fix ? ` (run: ${skipped.fix})` : ""}`,
    );
  for (const failed of plan.failed)
    lines.push(
      `  ${pad(failed.host)}cannot upgrade: ${failed.reason}${failed.fix ? ` (run: ${failed.fix})` : ""}`,
    );
  for (const migration of plan.migrations) lines.push(`  ${pad("config")}${migration.description}`);
  for (const change of permissions)
    lines.push(`  ${pad("permissions")}refresh the ${change.host} block in ${change.file}`);
  for (const blocked of plan.blocked) lines.push(`  blocked: ${blocked}`);
  for (const warning of plan.warnings ?? []) lines.push(`  warning: ${warning}`);
  return lines.join("\n") + "\n";
};

const LABEL: Record<HostOutcome["status"], string> = {
  updated: "updated",
  current: "already current",
  skipped: "skipped",
  failed: "FAILED",
};

const table = (hosts: HostOutcome[]): string =>
  [
    "Result:",
    ...hosts.map(
      (entry) =>
        `  ${pad(entry.host)}${LABEL[entry.status].padEnd(16)}${entry.reason}${
          entry.fix && entry.status !== "updated" && entry.status !== "current"
            ? `\n  ${pad("")}${"".padEnd(16)}fix: ${entry.fix}`
            : ""
        }`,
    ),
  ].join("\n") + "\n";

const askConfirm = async (question: string, out: { write: (text: string) => void }) => {
  if (!process.stdin.isTTY) {
    out.write("Not a terminal: rerun with --yes to apply.\n");
    return false;
  }
  const { askLine } = await import("./prompt");
  return /^y(?:es)?$/i.test((await askLine(question)).trim());
};

const USAGE =
  "Usage: workit upgrade [--hosts=opencode,cursor,codex,pi,claude-code|none] [--cli] [--preview | --yes | --apply --confirm] [--json]\n";

export async function runUpgradeCommand(argv: string[], deps: UpgradeDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const flags = new Set(argv);
  const unknown = argv.filter(
    (arg) =>
      !["--apply", "--confirm", "--json", "--cli", "--preview", "--yes"].includes(arg) &&
      !arg.startsWith("--hosts="),
  );
  const hostFlag = argv.find((arg) => arg.startsWith("--hosts="))?.slice(8);
  const raw = hostFlag === "none" ? [] : (hostFlag?.split(",") ?? HOSTS);
  // `--preview` is read-only: it cannot be combined with an apply flag.
  if (
    unknown.length ||
    raw.some((host) => !HOSTS.includes(host as HostId)) ||
    (flags.has("--preview") && (flags.has("--apply") || flags.has("--yes")))
  ) {
    out.write(USAGE);
    return 2;
  }
  if (flags.has("--apply") && !flags.has("--confirm")) {
    out.write("Apply requires --confirm after reviewing the upgrade preview.\n");
    return 2;
  }
  // `--apply --confirm` is the scripted alias of `--yes`; it keeps its JSON report.
  const legacy = flags.has("--apply");
  const json = flags.has("--json") || legacy;
  const run = runner(deps);
  const plan = previewUpgrade(raw as HostId[], deps);
  // The global CLI is part of the default upgrade; --hosts narrows it to hosts unless --cli.
  if (hostFlag === undefined || flags.has("--cli")) planCli(plan, run);
  plan.ok = plan.blocked.length === 0 && plan.failed.length === 0;
  // Issue #297: refresh a Workit permission block `workit setup` already
  // wrote (never add one, never set the shell); the diff is part of the plan.
  const { home, env } = upgradePaths(deps);
  const permissions = planHostPermissions({
    hosts: raw,
    refreshOnly: true,
    shell: false,
    home,
    env,
  });
  const permissionPreview = {
    changes: permissions.changes.map((c) => ({
      host: c.host,
      file: c.file,
      diff: permissionDiff(c),
    })),
    ...(permissions.refused ? { refused: permissions.refused } : {}),
  };
  const withPermissions = <T extends object>(value: T) =>
    permissions.changes.length ? { ...value, permissions: permissionPreview } : value;
  const applyCommand = `workit upgrade ${[...(hostFlag === undefined ? [] : [`--hosts=${hostFlag}`]), ...(flags.has("--cli") ? ["--cli"] : []), "--yes"].join(" ")}`;
  const nothingChanged = `preview only; nothing changed. Apply with: ${applyCommand}\n`;
  if (json && !legacy && !flags.has("--yes")) {
    // --json without an apply flag is the machine-readable preview.
    out.write(JSON.stringify(withPermissions(plan), null, 2) + "\n");
    return plan.blocked.length ? 1 : 0;
  }
  if (!json) out.write(summary(plan, permissions.changes));
  if (flags.has("--preview")) {
    out.write(nothingChanged);
    return plan.blocked.length ? 1 : 0;
  }
  if (plan.blocked.length) {
    out.write(`Upgrade blocked: ${plan.blocked.join("; ")}\nNothing changed.\n`);
    return 1;
  }
  const work =
    plan.entries.length + plan.migrations.length + (plan.cli ? 1 : 0) + permissions.changes.length;
  if (work > 0 && !flags.has("--yes") && !legacy) {
    const confirmed = await (deps.confirm ?? ((q: string) => askConfirm(q, out)))(
      "Apply this upgrade? [y/N] ",
    );
    if (!confirmed) {
      out.write(nothingChanged);
      return 0;
    }
  }
  if (json) for (const warning of plan.warnings ?? []) out.write(`warning: ${warning}\n`);
  const result = applyUpgrade(plan, deps);
  let permissionsOk = true;
  let written: ReturnType<typeof applyHostPermissions> | undefined;
  if (
    permissions.changes.length &&
    !permissions.refused &&
    !result.error?.startsWith("configuration changed")
  ) {
    written = applyHostPermissions(permissions, { home, env });
    permissionsOk = written.every((entry) => entry.status === "written");
    for (const entry of written)
      result.hosts.push({
        host: entry.host,
        status: entry.status === "written" ? "updated" : "failed",
        reason: `permission block ${entry.status === "written" ? "refreshed" : entry.status} in ${entry.file}`,
        ...(entry.status === "written" ? {} : { fix: `workit setup --hosts=${entry.host}` }),
      });
  }
  const failed = !result.ok || !permissionsOk;
  const cliVersion = result.hosts.some((h) => h.host === "cli" && h.status === "updated")
    ? plan.cli!.latest
    : pkg.version;
  const report = (
    deps.doctor ??
    ((version: string) => runDoctor({ home, env, cliVersion: version, only: "upgrade" }))
  )(cliVersion);
  const left = report.checks.filter((check) => check.status === "warn" || check.status === "fail");
  if (json) {
    out.write(
      JSON.stringify(
        {
          ...result,
          ok: !failed,
          ...(written
            ? { permissions: { changes: permissionPreview.changes, written } }
            : permissions.refused
              ? { permissions: permissionPreview }
              : {}),
          doctor: { clean: left.length === 0, left },
        },
        null,
        2,
      ) + "\n",
    );
    return failed ? 1 : 0;
  }
  if (result.error && result.hosts.every((h) => h.status !== "failed"))
    out.write(`Upgrade stopped: ${result.error}\n`);
  out.write(table(result.hosts));
  if (permissions.refused) out.write(`permissions: not refreshed: ${permissions.refused}\n`);
  if (result.backup) out.write(`Backup: ${result.backup}\n`);
  out.write(
    left.length === 0
      ? "Verified: workit doctor is clean for versions, assets, agents and permissions.\n"
      : `Left after upgrade (workit doctor):\n${left
          .map(
            (check) =>
              `  ${check.id}: ${check.detail}${check.fix ? `\n    fix: ${check.fix}` : ""}`,
          )
          .join("\n")}\n`,
  );
  return failed ? 1 : 0;
}

export async function runLaunchCommand(argv: string[], deps: UpgradeDeps = {}): Promise<number> {
  const [host, ...args] = argv;
  if (!LAUNCH_HOSTS.includes(host as HostId)) {
    (deps.out ?? process.stdout).write(
      "Usage: workit launch <opencode|cursor|codex|pi> [--auto-upgrade] [-- host arguments]\n",
    );
    return 2;
  }
  const auto = args[0] === "--auto-upgrade";
  const rest = auto ? args.slice(1) : args;
  const hostArgs = rest[0] === "--" ? rest.slice(1) : rest;
  const { home, env } = upgradePaths(deps);
  let launch: HostInstallCommand | undefined;
  if (!deps.run) {
    try {
      launch = hostCommand(host, hostArgs, { home, env });
    } catch (error) {
      (deps.out ?? process.stderr).write(
        `${error instanceof Error ? error.message : "Host executable unavailable"}\n`,
      );
      return 1;
    }
  }
  if (auto) {
    const plan = previewUpgrade([host as HostId], deps);
    const reasons = [...plan.blocked, ...plan.failed.map((entry) => entry.reason)];
    if (plan.ok) {
      for (const skipped of plan.skipped)
        (deps.out ?? process.stderr).write(
          `${skipped.host}: ${skipped.reason}${skipped.fix ? ` (run: ${skipped.fix})` : ""}\n`,
        );
      const result = applyUpgrade(plan, deps);
      if (!result.ok) {
        (deps.out ?? process.stdout).write(`${result.error}\n`);
        return 1;
      }
    } else if (
      plan.blocked.length === 0 &&
      reasons.every((reason) => reason.includes("registry version unavailable"))
    ) {
      (deps.out ?? process.stderr).write(
        `Upgrade unavailable: ${reasons.join("; ")}. Starting the unchanged host.\n`,
      );
    } else {
      (deps.out ?? process.stderr).write(`Upgrade blocked: ${reasons.join("; ")}\n`);
      return 1;
    }
  }
  if (deps.run) return deps.run(host, hostArgs).status ?? 1;
  return (
    spawnSync(launch!.command, launch!.args, {
      stdio: "inherit",
      env,
    }).status ?? 1
  );
}
