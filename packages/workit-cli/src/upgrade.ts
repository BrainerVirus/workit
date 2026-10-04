import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  cpSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { isWorkitPlugin } from "./admin/registration";
import { readSetupState } from "./admin/setup-state";
import { type HostId } from "./admin/detect-hosts";
import {
  hostCommand,
  planHostInstall,
  runHostCommand,
  type HostInstallCommand,
} from "./admin/host-install";
import { applySetupPreview, type SetupPreview } from "./admin/setup";
import { OPENCODE_V1_FIX } from "./admin/doctor";
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";

const HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi"];
type Command = { command: string; args: string[]; purpose?: string } & Partial<HostInstallCommand>;
type CommandResult = { status: number | null; stdout: string };
export type UpgradeDeps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => CommandResult;
  activeHosts?: () => HostId[];
  out?: { write: (text: string) => void };
};
type Source = {
  host: HostId;
  selector: string;
  installedVersion?: string;
  kind: "floating" | "pinned" | "local";
};
export type UpgradePlan = {
  ok: boolean;
  blocked: string[];
  skipped: { host: HostId | "cli"; reason: string }[];
  entries: { host: HostId; selector: string; latest: string; commands: Command[] }[];
  configDigests: Record<string, string>;
  cli?: { latest: string; root: string };
  migrations: { id: string; file: string; description: string }[];
  /** Advisories that do not block the upgrade (e.g. an OpenCode 1.x host). */
  warnings?: string[];
};

const upgradePaths = (deps: UpgradeDeps) => {
  const home = deps.home ?? deps.env?.HOME ?? os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(deps.home || deps.env?.HOME
      ? {
          HOME: home,
          CODEX_HOME: path.join(home, ".codex"),
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
  return {
    home,
    env,
    configDir:
      env.WORKFLOW_TOOLKIT_CONFIG ?? env.WORKFLOW_TOOLKIT_CONFIG_DIR ?? path.join(xdg, "workit"),
    opencodeConfig: path.join(xdg, "opencode/opencode.json"),
    piSettings: path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"), "settings.json"),
    codexConfig: path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"),
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

// Read only owned registrations. A checkout or intentional exact pin is never
// converted into a floating package as a side effect of upgrading another host.
const sources = (
  paths: ReturnType<typeof upgradePaths>,
  run: ReturnType<typeof runner>,
  hosts: HostId[],
): Source[] => {
  const { home, opencodeConfig, piSettings } = paths;
  const result: Source[] = [];
  if (hosts.includes("opencode") && existsSync(opencodeConfig + "c"))
    throw new Error(
      "OpenCode JSONC config is present; inspect effective native configuration before updating",
    );
  const oc = hosts.includes("opencode") ? object(opencodeConfig) : null;
  if (oc && [oc.plugins, oc.plugin].some((value) => value !== undefined && !Array.isArray(value)))
    throw new Error("OpenCode plugin registrations must be arrays");
  const plugins = [...(oc?.plugins ?? []), ...(oc?.plugin ?? [])];
  for (const pin of plugins)
    if (typeof pin === "string" && isWorkitPlugin(pin)) result.push(classify("opencode", pin));
  const cursor = hosts.includes("cursor")
    ? object(path.join(home, ".cursor/plugins/local/workit/package.json"))
    : null;
  if (cursor?.name === "@brainervirus/workit-cursor") {
    const mcp = object(path.join(home, ".cursor/mcp.json"));
    const args: unknown[] = mcp?.mcpServers?.workit?.args ?? [];
    const selector = args.find((arg) => typeof arg === "string" && arg.startsWith("--package="));
    result.push(classify("cursor", typeof selector === "string" ? selector.slice(10) : "local"));
  }
  const pi = hosts.includes("pi") ? object(piSettings) : null;
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
    if (npm || local) result.push(classify("pi", source));
  }
  const listing = hosts.includes("codex")
    ? run("codex", ["plugin", "list", "--json"])
    : { status: 1, stdout: "" };
  if (hosts.includes("codex") && listing.status !== 0) {
    let available = false;
    try {
      hostCommand("codex", [], { home, env: paths.env });
      available = true;
    } catch {
      /* absent host */
    }
    if (available || existsSync(paths.codexConfig))
      throw new Error("Codex plugin inventory failed; inspect the native host before upgrading");
  }
  if (listing.status === 0) {
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
        plugin.marketplaceName === "workflow-toolkit" &&
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
  }
  for (const source of result) {
    if (source.host === "cursor") source.installedVersion = cursor?.version;
    if (source.host === "pi" && source.kind === "floating") {
      const inventory = run("pi", ["list"]);
      if (inventory.status === 0)
        source.installedVersion = piInstalledVersion(inventory.stdout, source.selector);
    }
  }
  return result;
};

// Pi lists the configured source followed by its resolved package directory.
// Confirm the package identity and version rather than accepting a source name alone.
const piInstalledVersion = (listing: string, selector: string): string | undefined => {
  const lines = listing.split(/\r?\n/).map((line) => line.trim());
  const index = lines.indexOf(selector);
  if (index < 0 || !lines[index + 1] || !path.isAbsolute(lines[index + 1])) return undefined;
  const pkg = object(path.join(lines[index + 1], "package.json"));
  return pkg?.name === "@brainervirus/workit-pi" ? pkg.version : undefined;
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

export function previewUpgrade(hosts: HostId[] = HOSTS, deps: UpgradeDeps = {}): UpgradePlan {
  const paths = upgradePaths(deps);
  const { home, configDir } = paths;
  const run = runner(deps);
  const state = readSetupState(configDir);
  const plan: UpgradePlan = {
    ok: true,
    blocked: [],
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
    path.join(home, ".cursor/plugins/local/workit/package.json"),
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
    const installedSources = sources(paths, run, hosts);
    // Workit 3 ships only the OpenCode V2 plugin entry: warn before an upgrade
    // leaves a 1.x host with a plugin it cannot load. Unknown versions stay quiet.
    if (installedSources.some((source) => source.host === "opencode")) {
      // Like the doctor probe: OpenCode logs under its XDG data dir even for
      // --version, so a preview must point those dirs at a throwaway place.
      const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-upgrade-opencode-"));
      let probe: CommandResult;
      try {
        probe = runner({
          ...deps,
          env: {
            ...deps.env,
            XDG_DATA_HOME: path.join(scratch, "data"),
            XDG_STATE_HOME: path.join(scratch, "state"),
            XDG_CACHE_HOME: path.join(scratch, "cache"),
          },
        })("opencode", ["--version"]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const installed = probe.status === 0 ? probe.stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
      if (installed && !versionAtLeast(installed, SUPPORT_MATRIX.opencode.minimum))
        (plan.warnings ??= []).push(`opencode ${installed}: ${OPENCODE_V1_FIX}`);
    }
    for (const host of ["opencode", "pi"] as const) {
      if (
        new Set(
          installedSources
            .filter((source) => source.host === host)
            .map((source) => source.selector),
        ).size > 1
      )
        plan.blocked.push(
          `${host}: conflicting Workit registrations; reconcile them in the native host before upgrading`,
        );
    }
    for (const source of installedSources.filter(
      (candidate, index, list) =>
        list.findIndex(
          (entry) => entry.host === candidate.host && entry.selector === candidate.selector,
        ) === index,
    )) {
      if (source.kind !== "floating") {
        plan.skipped.push({
          host: source.host,
          reason: `${source.kind} source preserved; change its source explicitly to upgrade`,
        });
        continue;
      }
      if (source.host === "opencode") {
        plan.skipped.push({
          host: source.host,
          reason:
            "OpenCode server plugin preserved: scoped native updates are unavailable in qualified 2.0.21; Workit never updates unrelated plugins",
        });
        continue;
      }
      const latest = run("npm", ["view", `@brainervirus/workit-${source.host}`, "version"]);
      if (latest.status !== 0 || !/^\d+\.\d+\.\d+$/.test(latest.stdout.trim())) {
        plan.blocked.push(
          `${source.host}: registry version unavailable; existing installation preserved`,
        );
        continue;
      }
      if (
        source.installedVersion &&
        versionAtLeast(source.installedVersion, latest.stdout.trim())
      ) {
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
            ? [{ command: "codex", args: ["plugin", "add", "workit@workflow-toolkit", "--json"] }]
            : planHostInstall("cursor", {
                home,
                env: deps.env,
                cwd: home,
                packageVersion: latest.stdout.trim(),
                targetDir: path.join(home, ".cursor/plugins/local/workit"),
              });
      plan.entries.push({
        host: source.host,
        selector: source.selector,
        latest: latest.stdout.trim(),
        commands,
      });
    }
  } catch (error) {
    plan.blocked.push(
      error instanceof Error ? error.message : "installed source could not be read",
    );
  }
  plan.ok = plan.blocked.length === 0;
  return plan;
}

export function applyUpgrade(
  plan: UpgradePlan,
  deps: UpgradeDeps = {},
): { ok: boolean; backup?: string; error?: string } {
  if (!plan.ok) return { ok: false, error: plan.blocked.join("; ") };
  if (!plan.entries.length && !plan.migrations.length && !plan.cli) return { ok: true };
  for (const [file, expected] of Object.entries(plan.configDigests))
    if (digest(file) !== expected)
      return { ok: false, error: `configuration changed; preview again: ${file}` };
  const { home, env, configDir } = upgradePaths(deps);
  const active = deps.activeHosts?.() ?? runningHosts(deps);
  if (plan.entries.some((entry) => active.includes(entry.host)))
    return {
      ok: false,
      error: "Stop the selected running hosts before upgrading their loaded plugins",
    };
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
      };
    delete value.trustedPaths;
    writeFileAtomic(migration.file, JSON.stringify(value, null, 2) + "\n", 0o600);
  }
  const run = runner(deps);
  const cursorRoot = path.join(home, ".cursor/plugins/local/workit");
  if (plan.entries.some((entry) => entry.host === "cursor") && existsSync(cursorRoot))
    cpSync(cursorRoot, path.join(backup, "cursor-package"), { recursive: true });
  for (const entry of plan.entries) {
    if (entry.host === "opencode")
      return {
        ok: false,
        backup,
        error: "Scoped OpenCode server-plugin updates are unsupported; registration preserved",
      };
    if (entry.host === "cursor") {
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
          {
            type: "install-adapter",
            platform: "cursor",
            path: path.join(home, ".cursor/plugins/local/workit"),
          },
        ],
      };
      const result = applySetupPreview(preview, {
        home,
        env,
        cwd: home,
        preferInstalledAdapter: true,
        runHostCommand: (command) => {
          const outcome = run(command.command, command.args);
          return { exitCode: outcome.status ?? 1, stdout: outcome.stdout, stderr: "" };
        },
      });
      const pkg = object(path.join(home, ".cursor/plugins/local/workit/package.json"));
      if (!result.ok || pkg?.version !== entry.latest)
        return {
          ok: false,
          backup,
          error:
            "Cursor update did not verify the requested package version; inspect the installer before retrying",
        };
      continue;
    }
    for (const command of entry.commands)
      if (run(command.command, command.args).status !== 0)
        return {
          ok: false,
          backup,
          error: `${entry.host}: update failed; inspect the native host before retrying`,
        };
    const verify =
      entry.host === "codex" ? run("codex", ["plugin", "list", "--json"]) : run("pi", ["list"]);
    if (verify.status !== 0)
      return { ok: false, backup, error: `${entry.host}: update verification failed` };
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
            plugin.marketplaceName === "workflow-toolkit" &&
            plugin.version === entry.latest,
        )
      )
        return { ok: false, backup, error: "Codex did not report the requested Workit version" };
    }
    if (entry.host === "pi" && piInstalledVersion(verify.stdout, entry.selector) !== entry.latest)
      return { ok: false, backup, error: "Pi did not report the requested Workit package version" };
  }
  if (plan.cli) {
    const currentRoot = run("npm", ["root", "--global"]);
    if (currentRoot.status !== 0 || currentRoot.stdout.trim() !== plan.cli.root)
      return { ok: false, backup, error: "Global npm location changed; preview again" };
    const cliBackup = path.join(backup, "cli-package");
    cpSync(path.join(plan.cli.root, "@brainervirus/workit-cli"), cliBackup, { recursive: true });
    if (
      run("npm", ["install", "--global", `@brainervirus/workit-cli@${plan.cli.latest}`]).status !==
      0
    )
      return {
        ok: false,
        backup,
        error: `CLI update failed; preserved package at ${cliBackup}; use npm to repair or run node ${path.join(cliBackup, "dist/index.js")}`,
      };
    const installed = object(path.join(plan.cli.root, "@brainervirus/workit-cli/package.json"));
    if (installed?.name !== "@brainervirus/workit-cli" || installed.version !== plan.cli.latest)
      return {
        ok: false,
        backup,
        error: `CLI update did not verify the requested version; preserved package at ${cliBackup}`,
      };
  }
  return { ok: true, backup };
}

export async function runUpgradeCommand(argv: string[], deps: UpgradeDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const flags = new Set(argv);
  const unknown = argv.filter(
    (arg) =>
      !["--apply", "--confirm", "--json", "--cli", "--preview"].includes(arg) &&
      !arg.startsWith("--hosts="),
  );
  const hostFlag = argv.find((arg) => arg.startsWith("--hosts="))?.slice(8);
  const raw = hostFlag === "none" ? [] : (hostFlag?.split(",") ?? HOSTS);
  // `--preview` names the default mode explicitly; it cannot be combined with --apply.
  if (
    unknown.length ||
    raw.some((host) => !HOSTS.includes(host as HostId)) ||
    (flags.has("--preview") && flags.has("--apply"))
  ) {
    out.write(
      "Usage: workit upgrade [--hosts=opencode,cursor,codex,pi|none] [--cli] [--preview | --apply --confirm] [--json]\n",
    );
    return 2;
  }
  const plan = previewUpgrade(raw as HostId[], deps);
  if (flags.has("--cli")) {
    const run = runner(deps);
    const root = run("npm", ["root", "--global"]);
    if (root.status !== 0 || !path.isAbsolute(root.stdout.trim())) {
      plan.blocked.push("Global npm location could not be verified");
    } else {
      const packageFile = path.join(root.stdout.trim(), "@brainervirus/workit-cli/package.json");
      const pkg = object(packageFile);
      if (
        pkg?.name !== "@brainervirus/workit-cli" ||
        lstatSync(path.dirname(packageFile)).isSymbolicLink()
      ) {
        plan.skipped.push({
          host: "cli",
          reason:
            "No managed global CLI install (local links preserved); use npx @brainervirus/workit-cli@latest",
        });
      } else {
        const latest = run("npm", ["view", "@brainervirus/workit-cli", "version"]);
        if (latest.status !== 0 || !/^\d+\.\d+\.\d+$/.test(latest.stdout.trim()))
          plan.blocked.push("CLI registry version unavailable; existing installation preserved");
        else if (!versionAtLeast(pkg.version, latest.stdout.trim())) {
          plan.cli = { latest: latest.stdout.trim(), root: root.stdout.trim() };
          plan.configDigests[packageFile] = digest(packageFile);
        } else plan.skipped.push({ host: "cli", reason: `already current (${pkg.version})` });
      }
    }
    plan.ok = plan.blocked.length === 0;
  }
  if (!flags.has("--apply")) {
    out.write(JSON.stringify(plan, null, 2) + "\n");
    return plan.ok ? 0 : 1;
  }
  if (!flags.has("--confirm")) {
    out.write("Apply requires --confirm after reviewing the upgrade preview.\n");
    return 2;
  }
  for (const warning of plan.warnings ?? []) out.write(`warning: ${warning}\n`);
  const result = applyUpgrade(plan, deps);
  out.write(JSON.stringify(result, null, 2) + "\n");
  return result.ok ? 0 : 1;
}

export async function runLaunchCommand(argv: string[], deps: UpgradeDeps = {}): Promise<number> {
  const [host, ...args] = argv;
  if (!HOSTS.includes(host as HostId)) {
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
    if (plan.ok) {
      for (const skipped of plan.skipped)
        (deps.out ?? process.stderr).write(`${skipped.host}: ${skipped.reason}\n`);
      const result = applyUpgrade(plan, deps);
      if (!result.ok) {
        (deps.out ?? process.stdout).write(`${result.error}\n`);
        return 1;
      }
    } else if (plan.blocked.every((reason) => reason.includes("registry version unavailable"))) {
      (deps.out ?? process.stderr).write(
        `Upgrade unavailable: ${plan.blocked.join("; ")}. Starting the unchanged host.\n`,
      );
    } else {
      (deps.out ?? process.stderr).write(`Upgrade blocked: ${plan.blocked.join("; ")}\n`);
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

const runningHosts = (deps: UpgradeDeps): HostId[] => {
  const run = runner(deps);
  const list =
    process.platform === "win32"
      ? run("tasklist", ["/fo", "csv", "/nh"])
      : run("ps", ["-eo", "comm="]);
  if (list.status !== 0) return HOSTS; // Cannot prove a stopped boundary.
  return HOSTS.filter((host) =>
    new RegExp(`(?:^|[\\/",\\s])${host}(?:\\.exe)?(?:[",\\s]|$)`, "im").test(list.stdout),
  );
};
