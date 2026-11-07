import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { opencodeReading, opencodeScratchEnv, probeKey, type ProbeCache } from "./probes";
import { CODEX_INVENTORY_ARGS, CODEX_INVENTORY_KEY, codexInventorySync } from "./codex-inventory";
import { OPENCODE_NOT_READY } from "./opencode";
import path from "node:path";
import os from "node:os";
import { isWorkitPlugin } from "../admin/registration";
import { readSetupState } from "../admin/setup-state";
import { type HostId } from "../admin/detect-hosts";
import { claudeWorkitInstalls, hostCommand, planHostInstall } from "../admin/host-install";
import { OPENCODE_V1_FIX } from "../admin/doctor";
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix";
import cliPackage from "../../package.json" with { type: "json" };
import { describeInstall, isOwnedWrapper } from "../install/discover";
import { migrationCopies } from "../install/migrate";
import { isOwnedLauncher } from "../install/owned";
import {
  NEW_CLI_PACKAGE_NAME,
  entryOf,
  ownedPackage,
  ownedPaths,
  ownedVersion,
  realpathOr,
  versionDir,
} from "../install/paths";
import { CLI_PACKAGE } from "../update-check";
import {
  codexScopeCommands,
  legacyPackage,
  newLatest,
  newPackage,
  packageNameAt,
  refuseScope,
  scopeEntry,
  scopeOf,
  scopeRelease,
  type ScopeRelease,
} from "./scope";
import {
  CODEX_LEGACY_MARKETPLACE,
  codexMigrationFix,
  codexMigrationSteps,
  codexPluginRegistered,
} from "./codex-marketplace";
import {
  CLAUDE_CODE_PACKAGE,
  CLI_FIX,
  CODEX_MARKETPLACE,
  HOSTS,
  OPENCODE_PACKAGE,
  OPENCODE_UPDATE,
  digest,
  errorText,
  fixFor,
  object,
  objectOrNull,
  piInstalledVersion,
  registryVersion,
  runner,
  upgradePaths,
  versionAtLeast,
  type Command,
  type CommandResult,
  type HostOutcome,
  type Source,
  type UpgradeDeps,
  type UpgradePlan,
} from "./shared";

/** A registration by its package name on either scope: floating, an exact pin, or a local path. */
const classify = (host: HostId, selector: string): Source => {
  const name = [legacyPackage(host), newPackage(host)].find((candidate) =>
    new RegExp(`^(?:npm:)?${candidate.replace("/", "\\/")}(?:@[^/]+)?$`).test(selector),
  );
  if (!name) return { host, selector, kind: "local" };
  const floating = [name, `${name}@latest`, `npm:${name}`, `npm:${name}@latest`].includes(selector);
  return {
    host,
    selector,
    kind: floating ? "floating" : "pinned",
    scope: scopeOf(name) ?? undefined,
  };
};

// Read only owned registrations. A checkout or intentional exact pin is never
// converted into a floating package as a side effect of upgrading another host.
// Each host is read on its own: one unreadable host fails only that host.
export const sources = (
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
    if (cursor?.name === newPackage("cursor")) {
      result.push({ host: "cursor", selector, kind: "floating", scope: "new" });
      return;
    }
    if (cursor?.name === legacyPackage("cursor")) {
      result.push({
        ...classify("cursor", selector),
        installedVersion: cursor.version,
        // The plugin directory decides the scope: mcp.json follows it.
        scope: "legacy",
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
    if (registered)
      result.push({
        host: "cursor",
        selector,
        kind: "repair",
        scope: scopeOf(selector) ?? "legacy",
      });
  });
  guard("pi", () => {
    const pi = object(paths.piSettings);
    if (pi?.packages !== undefined && !Array.isArray(pi.packages))
      throw new Error("Pi package registrations must be an array");
    for (const entry of pi?.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string") continue;
      const npm = /^(?:npm:)?(?:@brainervirus\/workit-pi|@workit-dev\/pi)(?:@[^/]+)?$/.test(source);
      const local =
        path.isAbsolute(source) &&
        source.replaceAll("\\", "/").endsWith("/packages/workit-pi") &&
        object(path.join(source, "package.json"))?.name === "@brainervirus/workit-pi";
      if (!npm && !local) continue;
      const found = classify("pi", source);
      if (found.kind === "floating" && found.scope === "legacy") {
        const inventory = run("pi", ["list"]);
        if (inventory.timedOut) throw new Error(`could not check: ${inventory.stderr}`);
        if (inventory.status === 0)
          found.installedVersion = piInstalledVersion(inventory.stdout, source);
      }
      result.push(found);
    }
  });
  guard("codex", () => {
    const listing = run("codex", CODEX_INVENTORY_ARGS);
    if (listing.timedOut) throw new Error(`could not check: ${listing.stderr}`);
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
    const fromNpm = (plugin: Record<string, any>) =>
      plugin.source?.source === "npm" &&
      [legacyPackage("codex"), newPackage("codex")].includes(plugin.source?.package);
    // An npm install under the old marketplace name is moved to workit@workit
    // as one migration, whatever else is registered.
    const legacy = installed.find(
      (plugin) =>
        plugin.name === "workit" &&
        plugin.marketplaceName === CODEX_LEGACY_MARKETPLACE &&
        fromNpm(plugin),
    );
    if (legacy || codexPluginRegistered(paths.codexConfig, CODEX_LEGACY_MARKETPLACE)) {
      result.push({
        host: "codex",
        selector: "@brainervirus/workit-codex",
        kind: legacy ? "floating" : "repair",
        migrate: true,
        scope: scopeOf(legacy?.source?.package ?? legacyPackage("codex")) ?? "legacy",
        ...(legacy?.version ? { installedVersion: legacy.version } : {}),
      });
      return;
    }
    for (const plugin of installed) {
      if (plugin.name !== "workit") continue;
      const source = plugin.source;
      // The old package moves whatever pin or source shape Codex recorded:
      // the marketplace, not the pin, decides what it installs next.
      if (source?.package === legacyPackage("codex")) {
        result.push({
          host: "codex",
          selector: legacyPackage("codex"),
          kind: "floating",
          scope: "legacy",
          ...(plugin.version ? { installedVersion: plugin.version } : {}),
        });
        continue;
      }
      const npm = plugin.marketplaceName === CODEX_MARKETPLACE && fromNpm(plugin);
      result.push({
        ...classify(
          "codex",
          npm ? `${source.package}${source.version ? `@${source.version}` : ""}` : "local",
        ),
        installedVersion: plugin.version,
      });
    }
    // Registered in config.toml but the plugin cache is missing, so the
    // inventory omits it: reinstall with Codex's own add command.
    if (
      !result.some((found) => found.host === "codex") &&
      codexPluginRegistered(paths.codexConfig, CODEX_MARKETPLACE)
    )
      result.push({
        host: "codex",
        selector: "@brainervirus/workit-codex",
        kind: "repair",
        scope: "legacy",
      });
  });
  guard("claude-code", () => {
    // User-scope installs only: a project install belongs to that project.
    for (const install of claudeWorkitInstalls(home, paths.env, null)) {
      // The installed package's name decides the scope; an unreadable one is the old.
      const name = packageNameAt(install.installPath);
      result.push({
        host: "claude-code",
        selector: install.id,
        kind: "floating",
        installedVersion: install.version ?? undefined,
        scope: name === newPackage("claude-code") ? "new" : "legacy",
      });
    }
  });
  return result;
};

/** Run an OpenCode probe with its XDG data/state/cache dirs in a throwaway
 *  place: OpenCode logs there even for --version and --help. */
const opencodeProbe = (deps: UpgradeDeps, args: string[], probes?: ProbeCache): CommandResult => {
  const cached = probes?.get(probeKey("opencode", args));
  if (cached) return cached;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-upgrade-opencode-"));
  try {
    return runner({ ...deps, env: opencodeScratchEnv(deps, scratch) })("opencode", args);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** The planning runner: a probe's result when `runProbes` already has it, else the command. */
export const probedRunner = (deps: UpgradeDeps, probes?: ProbeCache): ReturnType<typeof runner> => {
  const run = runner(deps);
  return (command, args) => {
    const key = probeKey(command, args);
    // The merged Codex inventory is no command of its own: unprobed, it is several.
    return (
      probes?.get(key) ??
      (key === CODEX_INVENTORY_KEY ? codexInventorySync(run) : run(command, args))
    );
  };
};

export function previewUpgrade(
  hosts: HostId[] = HOSTS,
  deps: UpgradeDeps = {},
  probes?: ProbeCache,
): UpgradePlan {
  const paths = upgradePaths(deps);
  const { home, configDir } = paths;
  const run = probedRunner(deps, probes);
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
  // Read once, when an old-scope registration needs it.
  let scope: ScopeRelease | undefined;
  // Workit 3 ships only the OpenCode V2 plugin entry: warn before an upgrade
  // leaves a 1.x host with a plugin it cannot load. Unknown versions stay quiet.
  let opencodeHelp: string | undefined;
  // A host that resolves its own update is skipped once it runs the published version.
  const current = (host: HostId, installed?: string, published?: string): boolean => {
    if (!installed || !published || !versionAtLeast(installed, published)) return false;
    plan.skipped.push({ host, reason: `already current (${installed})` });
    return true;
  };
  if (installedSources.some((source) => source.host === "opencode")) {
    const probe = opencodeProbe(deps, ["--version"], probes);
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
    // Moved to the new scope: its versions are another line (1.x), never compared with 14.x.
    if (source.scope === "new") {
      plan.skipped.push({
        host: source.host,
        reason: `already current (on ${newPackage(source.host)}; \`workit upgrade\` with the new CLI updates it)`,
      });
      continue;
    }
    if (source.scope === "legacy") {
      const release = (scope ??= scopeRelease(run));
      if (release.released) {
        planScopeMove(plan, source, release.version, { run, deps, paths });
        continue;
      }
      refuseScope(plan, release);
    }
    if (source.host === "claude-code") {
      const [market] = source.selector.split("@").slice(1);
      // The marketplace installs this npm package: its version is the target shown.
      const published = registryVersion(run, CLAUDE_CODE_PACKAGE);
      if (current(source.host, source.installedVersion, published)) continue;
      plan.entries.push({
        host: "claude-code",
        selector: source.selector,
        latest: "",
        ...(published ? { published } : {}),
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
      const help = opencodeProbe(deps, ["plugin", "--help"], probes);
      if (help.timedOut) {
        plan.failed.push({
          host: "opencode",
          status: "failed",
          reason: `could not check: ${help.stderr}`,
          fix: OPENCODE_UPDATE,
        });
        continue;
      }
      opencodeHelp ??= help.stdout;
      if (!/^\s*(?:opencode\s+plugin\s+)?update\b/m.test(opencodeHelp)) {
        plan.skipped.push({
          host: "opencode",
          reason:
            "this OpenCode has no `opencode plugin update`; upgrade OpenCode, then run the fix. Workit never updates unrelated plugins",
          fix: OPENCODE_UPDATE,
        });
        continue;
      }
      // OpenCode loads plugins in the background: a service that never listed
      // Workit would fail the update with `Plugin is not configured`.
      const reading = opencodeReading(probes);
      if (reading === null) {
        plan.failed.push({
          host: "opencode",
          status: "failed",
          reason: OPENCODE_NOT_READY,
          fix: OPENCODE_UPDATE,
        });
        continue;
      }
      const published = registryVersion(run, OPENCODE_PACKAGE);
      if (current("opencode", reading?.version, published)) continue;
      plan.entries.push({
        host: "opencode",
        selector: source.selector,
        latest: "",
        ...(published ? { published } : {}),
        ...(reading?.version ? { installedVersion: reading.version } : {}),
        // HOME's location: the one the readiness wait covered (see ./opencode).
        commands: [
          { command: "opencode", args: ["plugin", "update", OPENCODE_PACKAGE], cwd: home },
        ],
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
    if (
      !source.migrate &&
      source.installedVersion &&
      versionAtLeast(source.installedVersion, latest)
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
        : source.host === "codex" && source.migrate
          ? (
              codexMigrationSteps(paths.codexConfig, {
                json: true,
                installed: source.kind !== "repair",
              }) ?? []
            ).map((step) => ({
              command: "codex",
              args: step.args,
              purpose: step.purpose,
            }))
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
      fix: source.migrate
        ? codexMigrationFix(paths.codexConfig, source.kind !== "repair")
        : fixFor(source.host, source.selector),
    });
  }
  plan.ok = plan.blocked.length === 0 && plan.failed.length === 0;
  return plan;
}

/** One host's move to the new scope: the new package's version, then the host's commands. */
const planScopeMove = (
  plan: UpgradePlan,
  source: Source,
  version: string,
  context: {
    run: ReturnType<typeof runner>;
    deps: UpgradeDeps;
    paths: ReturnType<typeof upgradePaths>;
  },
): void => {
  const { run, deps, paths } = context;
  const host = source.host;
  const failed = (reason: string) =>
    plan.failed.push({
      host,
      status: "failed",
      reason: `${reason}; the ${legacyPackage(host)} install is kept`,
      fix: fixFor(host, source.selector),
    });
  const latest = newLatest(run, host);
  if (!latest) return void failed(`${newPackage(host)} registry version unavailable`);
  let commands: Command[];
  try {
    commands =
      host === "pi"
        ? [
            { command: "pi", args: ["install", `npm:${newPackage("pi")}`] },
            { command: "pi", args: ["remove", source.selector] },
          ]
        : host === "codex"
          ? source.migrate
            ? (
                codexMigrationSteps(paths.codexConfig, {
                  json: true,
                  installed: source.kind !== "repair",
                }) ?? []
              ).map((step) => ({ command: "codex", args: step.args, purpose: step.purpose }))
            : codexScopeCommands()
          : host === "claude-code"
            ? [
                { command: "claude", args: ["plugin", "marketplace", "update", "workit"] },
                { command: "claude", args: ["plugin", "update", source.selector] },
              ]
            : host === "cursor"
              ? planHostInstall("cursor", {
                  home: paths.home,
                  env: deps.env,
                  cwd: paths.home,
                  packageVersion: latest,
                  packageName: newPackage("cursor"),
                  targetDir: paths.cursorRoot,
                })
              : [];
  } catch (error) {
    return void failed(errorText(error));
  }
  plan.entries.push(
    scopeEntry(host, source.selector, latest, {
      installedVersion: source.installedVersion,
      commands,
      repair: source.kind === "repair",
    }),
  );
  plan.scope = { version };
};

/**
 * The CLI, part of every default upgrade: the Workit-owned install under
 * installRoot() (#648). Planned when the owned version is behind the
 * registry, when there is no owned install yet, when other copies (an npm
 * global in a version manager's prefix, a hand-written wrapper) are left to
 * migrate, or when the launcher is missing. A local checkout run with no
 * owned install and no copy is left alone.
 */
export const planCli = (
  plan: UpgradePlan,
  run: ReturnType<typeof runner>,
  deps: UpgradeDeps = {},
): void => {
  const { env } = upgradePaths(deps);
  const paths = ownedPaths(env);
  const owned = ownedVersion(env);
  const copies = migrationCopies(env);
  const script = deps.cliEntry ?? process.argv[1];
  const packaged = Boolean(
    script && /[\\/]node_modules[\\/]@brainervirus[\\/]workit-cli[\\/]/.test(realpathOr(script)),
  );
  // Already moved to the new scope: that CLI (1.x) upgrades itself; 14.x is never compared with it.
  const moved = ownedPackage(env);
  if (moved?.name === NEW_CLI_PACKAGE_NAME) {
    plan.skipped.push({
      host: "cli",
      reason: `already current (on ${NEW_CLI_PACKAGE_NAME} ${moved.version}; \`workit upgrade\` with it updates it)`,
    });
    return;
  }
  if (!owned && !copies.length && !packaged) {
    plan.skipped.push({
      host: "cli",
      reason: `running from a local checkout (links preserved); install the owned CLI with ${CLI_FIX}`,
    });
    return;
  }
  const release = scopeRelease(run);
  if (release.released) {
    plan.scope = { version: release.version };
    plan.cli = {
      latest: release.version,
      root: paths.root,
      installed: owned ?? newestOf(copies) ?? cliPackage.version,
      entry: entryOf(versionDir(paths.root, release.version), NEW_CLI_PACKAGE_NAME),
      install: true,
      copies: copies.map(describeInstall),
      package: NEW_CLI_PACKAGE_NAME,
    };
    return;
  }
  refuseScope(plan, release);
  const latest = registryVersion(run, CLI_PACKAGE);
  if (!latest) {
    plan.failed.push({
      host: "cli",
      status: "failed",
      reason: "CLI registry version unavailable; existing installation preserved",
      fix: CLI_FIX,
    });
    return;
  }
  const install = !owned || !versionAtLeast(owned, latest);
  // A hand-written wrapper at the launcher's place that execs the launcher is ready too.
  const launcherReady =
    isOwnedLauncher(paths.launcher) &&
    (realpathOr(paths.linked) === realpathOr(paths.launcher) || isOwnedWrapper(paths.linked, env));
  if (!install && !copies.length && launcherReady) {
    plan.skipped.push({ host: "cli", reason: `already current (${owned})` });
    return;
  }
  const target = install || !owned ? latest : owned;
  plan.cli = {
    latest: target,
    root: paths.root,
    installed: owned ?? newestOf(copies) ?? cliPackage.version,
    entry: entryOf(versionDir(paths.root, target)),
    install,
    copies: copies.map(describeInstall),
  };
};

/** The newest version among old-scope copies (all one package name, so comparable). */
const newestOf = (copies: { version: string | null }[]): string | undefined =>
  copies
    .map((copy) => copy.version)
    .filter((version): version is string => Boolean(version))
    .reduce<string | undefined>(
      (best, version) => (best && versionAtLeast(best, version) ? best : version),
      undefined,
    );
