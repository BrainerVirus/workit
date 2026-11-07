// The 14.x bridge: Workit moved from @brainervirus/workit-<name> to
// @workit-dev/<name>, and the new line restarted at 1.0.0. Every decision
// here goes by package NAME, never by version: an installed 14.x is above
// the new scope's 1.0.0, so a version comparison would read the old install
// as newer and keep it. Versions are only compared within one package name.
//
// Planning finds each host's registration on the old scope; applying moves
// it to the new package with the host's own commands (Pi, Codex, Claude
// Code), Workit's installer (Cursor, the owned CLI) or a pin rewrite
// (OpenCode). A second run finds every host on the new scope and changes
// nothing.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { copyPluginDir } from "../admin/setup";
import { type HostId } from "../admin/detect-hosts";
import { claudeWorkitInstalls, type HostInstallCommand } from "../admin/host-install";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import { codexInventory } from "./codex-inventory";
import {
  NEW_SCOPE,
  NEW_SCOPE_FLOOR,
  LEGACY_SCOPE,
  SCOPE_FIX,
  SCOPE_ROW,
  legacyPackage,
  movedOpencodePin,
  movedPiSource,
  newPackage,
  packageNameAt,
  scopeOf,
} from "./scope-names";
import { CODEX_MARKETPLACE } from "./codex-marketplace";
import {
  failureReason,
  objectOrNull,
  piInstalledVersion,
  registryVersion,
  versionAtLeast,
  type CommandResult,
  type HostOutcome,
  type PlanEntry,
  type RunOptions,
  type UpgradePlan,
  type runner,
  type upgradePaths,
} from "./shared";

export {
  LEGACY_SCOPE,
  NEW_SCOPE,
  NEW_SCOPE_FLOOR,
  SCOPE_FIX,
  SCOPE_ROW,
  legacyPackage,
  movedOpencodePin,
  movedPiSource,
  newPackage,
  packageNameAt,
  scopeOf,
  type ScopedName,
} from "./scope-names";

export type ScopeRelease =
  | { released: true; version: string }
  /** `quiet`: the registry has no answer (offline, or no package yet); no row is shown. */
  | { released: false; reason: string; quiet?: boolean };

/**
 * Whether the new scope has a real release to move to: `@workit-dev/cli`'s
 * latest must be at least 1.0.0. The 0.0.x placeholders that hold the names
 * for trusted publishing are never a target.
 */
export const scopeRelease = (run: ReturnType<typeof runner>): ScopeRelease => {
  const name = newPackage("cli");
  const result = run("npm", ["view", name, "version"]);
  const version = result.stdout.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version))
    return {
      released: false,
      reason: `the new scope is not released yet (${name} is not on the registry or it did not answer)`,
      quiet: true,
    };
  if (!versionAtLeast(version, NEW_SCOPE_FLOOR))
    return {
      released: false,
      reason: `the new scope is not released yet (${name} latest is ${version}, below ${NEW_SCOPE_FLOOR})`,
    };
  return { released: true, version };
};

/** One refusal row per plan, when there is an old-scope install to move and the registry answered. */
export const refuseScope = (plan: UpgradePlan, release: ScopeRelease): void => {
  if (release.released || release.quiet) return;
  const reason = release.reason;
  if (plan.skipped.some((row) => row.host === SCOPE_ROW)) return;
  plan.skipped.push({
    host: SCOPE_ROW,
    reason: `not moving to ${NEW_SCOPE}/*: ${reason}; staying on ${LEGACY_SCOPE}/workit-*`,
  });
};

/** The move one host's plan entry makes. */
export type ScopeMove = { from: string; to: string };

/**
 * The plan entry that moves one host's old-scope registration. `latest` is the
 * new package's registry version (the version shown and, for Cursor, staged).
 */
export const scopeEntry = (
  host: HostId,
  selector: string,
  latest: string,
  context: {
    installedVersion?: string;
    commands: PlanEntry["commands"];
    repair?: boolean;
  },
): PlanEntry => {
  const from = selector.replace(/@latest$/, "");
  const to = host === "pi" ? movedPiSource() : (movedOpencodePin(selector) ?? newPackage(host));
  const fix =
    host === "pi"
      ? `pi install ${to} && pi remove ${selector}`
      : host === "opencode"
        ? `replace ${selector} with ${to} in opencode.json`
        : host === "codex"
          ? `codex plugin marketplace upgrade ${CODEX_MARKETPLACE} && codex plugin remove workit@${CODEX_MARKETPLACE} && codex plugin add workit@${CODEX_MARKETPLACE}`
          : host === "claude-code"
            ? `claude plugin marketplace update workit && claude plugin uninstall ${selector} && claude plugin install workit@workit --scope user`
            : SCOPE_FIX;
  return {
    host,
    selector,
    latest,
    commands: context.commands,
    ...(context.installedVersion ? { installedVersion: context.installedVersion } : {}),
    ...(context.repair ? { repair: true } : {}),
    scope: { from, to: host === "opencode" ? to : to.replace(/@latest$/, "") },
    fix,
  };
};

/** Commands that move a Codex install: refresh the marketplace, reinstall from it. */
export const codexScopeCommands = (): PlanEntry["commands"] => [
  { command: "codex", args: ["plugin", "marketplace", "upgrade", CODEX_MARKETPLACE] },
  { command: "codex", args: ["plugin", "remove", `workit@${CODEX_MARKETPLACE}`] },
  { command: "codex", args: ["plugin", "add", `workit@${CODEX_MARKETPLACE}`, "--json"] },
];

/** Planning: the new package's registry version, or a failed row's reason. */
export const newLatest = (run: ReturnType<typeof runner>, host: HostId): string | undefined =>
  registryVersion(run, newPackage(host));

type AsyncRun = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>;

/** The moved row: `<from> -> <to> <version>`. */
const moved = (entry: PlanEntry, version: string, note = ""): HostOutcome => ({
  host: entry.host,
  status: "updated",
  reason: `${entry.scope!.from} -> ${entry.scope!.to} ${version}${note ? `; ${note}` : ""}`,
});

/** Rewrite OpenCode's plugin pins; other entries and keys are left as they are. */
const moveOpencode = (entry: PlanEntry, file: string): HostOutcome => {
  const fail = (reason: string): HostOutcome => ({
    host: "opencode",
    status: "failed",
    reason,
    fix: entry.fix,
  });
  const config = objectOrNull(file);
  if (!config) return fail(`${file} could not be read`);
  let changed = false;
  for (const key of ["plugins", "plugin"] as const) {
    if (!Array.isArray(config[key])) continue;
    config[key] = config[key].map((pin: unknown) => {
      const next = typeof pin === "string" ? movedOpencodePin(pin) : null;
      if (!next) return pin;
      changed = true;
      return next;
    });
    // One Workit pin per key: the move can meet an entry already on the new scope.
    config[key] = config[key].filter(
      (pin: unknown, index: number, list: unknown[]) =>
        typeof pin !== "string" || scopeOf(pin) !== "new" || list.indexOf(pin) === index,
    );
  }
  if (changed) writeFileAtomic(file, JSON.stringify(config, null, 2) + "\n", 0o600);
  const text = readFileSync(file, "utf8");
  if (/@brainervirus\/workit-opencode(?:@latest)?"/.test(text))
    return fail(`${file} still registers ${legacyPackage("opencode")}`);
  return moved(
    entry,
    entry.latest,
    "OpenCode installs it on its next start (restart a running opencode)",
  );
};

/** Install the new Pi package, prove Pi lists it, then remove the old source. */
const movePi = async (entry: PlanEntry, run: AsyncRun): Promise<HostOutcome> => {
  const fail = (reason: string): HostOutcome => ({
    host: "pi",
    status: "failed",
    reason,
    fix: entry.fix,
  });
  const to = entry.scope!.to;
  const install = { command: "pi", args: ["install", to] };
  const added = await run(install.command, install.args);
  if (added.status !== 0) return fail(failureReason(install, added));
  const listed = await run("pi", ["list"]);
  const version = piInstalledVersion(listed.stdout, to, newPackage("pi"));
  if (listed.status !== 0 || !version)
    return fail(`Pi did not list ${to} after installing it; the old ${entry.selector} stays`);
  const remove = { command: "pi", args: ["remove", entry.selector] };
  const removed = await run(remove.command, remove.args);
  if (removed.status !== 0)
    return fail(`${failureReason(remove, removed)}; ${to} ${version} is installed beside it`);
  return moved(entry, version);
};

/** Codex: reinstall from the refreshed marketplace, then require the new package in its inventory. */
const moveCodex = async (
  entry: PlanEntry,
  run: AsyncRun,
  paths: ReturnType<typeof upgradePaths>,
): Promise<HostOutcome> => {
  for (const command of entry.commands) {
    const result = await run(command.command, command.args);
    if (result.status !== 0)
      return {
        host: "codex",
        status: "failed",
        reason: failureReason(command, result),
        fix: entry.fix,
      };
  }
  const inventory = await codexInventory(run);
  let installed: Record<string, any>[] = [];
  try {
    installed = JSON.parse(inventory.stdout).installed ?? [];
  } catch {
    /* fail below */
  }
  const plugin = installed.find(
    (row) => row.name === "workit" && row.marketplaceName === CODEX_MARKETPLACE,
  );
  if (plugin?.source?.package !== newPackage("codex"))
    return {
      host: "codex",
      status: "failed",
      reason: `Codex installs ${plugin?.source?.package ?? "no Workit plugin"} from the ${CODEX_MARKETPLACE} marketplace, not ${newPackage("codex")}`,
      fix: entry.fix,
    };
  const removed = removeOldCodexCache(paths.codexHome);
  return moved(
    entry,
    plugin.version ?? entry.latest,
    `new Codex threads load it${removed ? `; removed ${removed} old cached ${removed === 1 ? "version" : "versions"}` : ""}`,
  );
};

/**
 * Codex caches each plugin version under plugins/cache/workit/workit/<version>;
 * the newest by number is what loads, so a 14.x left there would win over
 * 1.0.0. Remove every cached version whose package is the old one.
 */
const removeOldCodexCache = (codexHome: string): number => {
  const dir = path.join(codexHome, "plugins", "cache", CODEX_MARKETPLACE, "workit");
  let removed = 0;
  let versions: string[] = [];
  try {
    versions = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const version of versions) {
    const root = path.join(dir, version);
    if (packageNameAt(root) !== legacyPackage("codex")) continue;
    rmSync(root, { recursive: true, force: true });
    removed++;
  }
  return removed;
};

/**
 * Claude Code: refresh the marketplace and update. Claude may keep a 14.x
 * install as "newer" than 1.0.0, so a plugin still on the old package is
 * uninstalled and installed again from the refreshed marketplace.
 */
const moveClaude = async (
  entry: PlanEntry,
  run: AsyncRun,
  paths: ReturnType<typeof upgradePaths>,
): Promise<HostOutcome> => {
  const fail = (reason: string): HostOutcome => ({
    host: "claude-code",
    status: "failed",
    reason,
    fix: entry.fix,
  });
  const install = () =>
    claudeWorkitInstalls(paths.home, paths.env, null).find((one) => one.id === entry.selector);
  const onNew = () => {
    const found = install();
    return found && packageNameAt(found.installPath) === newPackage("claude-code") ? found : null;
  };
  for (const command of entry.commands) {
    const result = await run(command.command, command.args);
    if (result.status !== 0) return fail(failureReason(command, result));
  }
  if (!onNew()) {
    const steps = [
      { command: "claude", args: ["plugin", "uninstall", entry.selector] },
      { command: "claude", args: ["plugin", "install", "workit@workit", "--scope", "user"] },
    ];
    for (const step of steps) {
      const result = await run(step.command, step.args);
      if (result.status !== 0) return fail(failureReason(step, result));
    }
  }
  const after = onNew();
  if (!after)
    return fail(
      `the workit marketplace still installs ${packageNameAt(install()?.installPath ?? "") ?? "no Workit plugin"}, not ${newPackage("claude-code")}`,
    );
  return moved(entry, after.version ?? entry.latest, "new sessions load it");
};

/**
 * Cursor: stage the new adapter with npm, copy it over the managed plugin
 * directory (backed up by the caller), then point mcp.json's npx runtime at
 * the new package. The old plugin stays until the new one is staged and copied.
 */
const moveCursor = async (
  entry: PlanEntry,
  run: AsyncRun,
  paths: ReturnType<typeof upgradePaths>,
): Promise<HostOutcome> => {
  const fail = (reason: string): HostOutcome => ({
    host: "cursor",
    status: "failed",
    reason,
    fix: entry.fix,
  });
  let staged: string | undefined;
  for (const command of entry.commands as (PlanEntry["commands"][number] &
    Partial<HostInstallCommand>)[]) {
    const result = await run(command.command, command.args);
    if (result.status !== 0) return fail(failureReason(command, result));
    if (command.packageRoot) staged = command.packageRoot;
  }
  if (!staged || packageNameAt(staged) !== newPackage("cursor"))
    return fail(`npm did not stage ${newPackage("cursor")}; the old plugin stays`);
  try {
    copyPluginDir(staged, paths.cursorRoot);
  } catch (error) {
    return fail(`adapter copy failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const file of [
    path.join(paths.home, ".cursor/mcp.json"),
    path.join(paths.cursorRoot, "mcp.json"),
  ]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const next = text.replaceAll(
      /@brainervirus\/workit-cursor@[^"\s]*/g,
      `${newPackage("cursor")}@latest`,
    );
    if (next !== text) writeFileAtomic(file, next, 0o600);
  }
  const version = objectOrNull(path.join(paths.cursorRoot, "package.json"))?.version;
  if (packageNameAt(paths.cursorRoot) !== newPackage("cursor"))
    return fail(`${paths.cursorRoot} does not hold ${newPackage("cursor")} after the copy`);
  return moved(
    entry,
    typeof version === "string" ? version : entry.latest,
    "restart Cursor to load it",
  );
};

/** Apply one scope move (plan entries with `scope`). */
export const applyScopeEntry = async (
  entry: PlanEntry,
  context: { runAsync: AsyncRun; paths: ReturnType<typeof upgradePaths> },
): Promise<HostOutcome> => {
  const { runAsync, paths } = context;
  if (entry.host === "opencode") return moveOpencode(entry, paths.opencodeConfig);
  if (entry.host === "pi") return movePi(entry, runAsync);
  if (entry.host === "codex") return moveCodex(entry, runAsync, paths);
  if (entry.host === "claude-code") return moveClaude(entry, runAsync, paths);
  return moveCursor(entry, runAsync, paths);
};
