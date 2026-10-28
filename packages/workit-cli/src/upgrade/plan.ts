import { existsSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isWorkitPlugin } from "../admin/registration";
import { readSetupState } from "../admin/setup-state";
import { type HostId } from "../admin/detect-hosts";
import { claudeWorkitInstalls, hostCommand, planHostInstall } from "../admin/host-install";
import { OPENCODE_V1_FIX } from "../admin/doctor";
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix";
import {
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

/** The global CLI, part of every default upgrade: only a managed npm global
 *  install is touched; a local link or npx use is left as it is. */
export const planCli = (plan: UpgradePlan, run: ReturnType<typeof runner>): void => {
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
