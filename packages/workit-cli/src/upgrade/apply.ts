import {
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  cpSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { claudeWorkitInstalls } from "../admin/host-install";
import { readSetupState } from "../admin/setup-state";
import { type HostCommandResult } from "../admin/host-install";
import { recordHookNode } from "../admin/hook-node";
import {
  applySetupPreview,
  planHostOnlyInstall,
  type ApplySetupOptions,
  type SetupPreview,
  type SetupResult,
} from "../admin/setup";
import { writeFileAtomic } from "@workit-dev/core/src/core/safe-write";
import { stateDir as workitStateDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import { describeInstall, describeInstallAt, listInstalls } from "../install/discover";
import { leftLines, migrateCopies, migrationCopies } from "../install/migrate";
import { resolveInstallNode } from "../install/node";
import { installOwned, writeLaunchers } from "../install/owned";
import { realpathOr, shellQuote } from "../install/paths";
import { pathResolvedWorkit } from "../install/verify";
import { createProgress, type StepStatus } from "../progress";
import { codexInventory } from "./codex-inventory";
import { classifyProcess, describe, listProcesses } from "./processes";
import {
  OPENCODE_NOT_READY,
  OPENCODE_STALE,
  waitForOpencodePlugin,
  waitForOpencodeVersion,
} from "./opencode";
import {
  CLI_FIX,
  CODEX_MARKETPLACE,
  LIVE_HOSTS,
  digest,
  errorText,
  object,
  objectOrNull,
  piInstalledVersion,
  failureReason,
  stderrTail,
  asyncRunner,
  upgradePaths,
  versionAtLeast,
  type HostOutcome,
  type PlanEntry,
  type UpgradeDeps,
  type UpgradePlan,
} from "./shared";
import { CODEX_LEGACY_MARKETPLACE } from "./codex-marketplace";

/**
 * Apply a host-only setup preview: its host commands run on the async runner
 * (so the spinner keeps moving), then setup's synchronous installer replays
 * their recorded results and goes on with the file steps.
 */
const applyInstallPreview = async (
  preview: SetupPreview,
  runAsync: ReturnType<typeof asyncRunner>,
  options: ApplySetupOptions,
): Promise<SetupResult> => {
  const recorded = new Map<object, HostCommandResult>();
  let history = "";
  for (const command of preview.mutations.flatMap((mutation) =>
    mutation.type === "install-host" ? mutation.commands : [],
  )) {
    if (command.skipWhenOutputIncludes && history.includes(command.skipWhenOutputIncludes))
      continue;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- the install commands are ordered: each needs the one before it, and the first failure stops the rest.
    const outcome = await runAsync(command.command, command.args);
    const result = {
      exitCode: outcome.status ?? 1,
      stdout: outcome.stdout,
      stderr: outcome.stderr ?? "",
    };
    recorded.set(command, result);
    history += `\n${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) break;
  }
  return applySetupPreview(preview, {
    ...options,
    runHostCommand: (command) =>
      recorded.get(command) ?? { exitCode: 1, stdout: "", stderr: "command did not run" },
  });
};

/** Repair a registered-but-broken host with its host-only install, then prove it: a second plan is empty. */
const applyRepair = async (
  entry: PlanEntry,
  preview: SetupPreview,
  context: { runAsync: ReturnType<typeof asyncRunner>; paths: ReturnType<typeof upgradePaths> },
): Promise<HostOutcome> => {
  const { home, env, configDir, opencodeConfig } = context.paths;
  const options = { home, env, cwd: home, dir: configDir, opencodeConfig };
  const fail = (reason: string): HostOutcome => ({
    host: entry.host,
    status: "failed",
    reason,
    fix: entry.fix,
  });
  const result = await applyInstallPreview(preview, context.runAsync, options);
  const problems = result.entries
    .filter((one) => one.status === "Failed")
    .map((one) => briefDetail(one.detail ?? `${one.file} failed`));
  if (problems.length) return fail(`repair failed: ${problems.join("; ")}`);
  const left = planHostOnlyInstall(entry.host, options);
  if (left.preview.mutations.length)
    return fail(
      `the repair ran, but ${entry.host} still needs: ${[...left.diff.files, ...left.diff.commands].join("; ")}`,
    );
  return {
    host: entry.host,
    status: "updated",
    reason:
      entry.host === "opencode"
        ? `re-registered Workit in ${preview.mutations.map((mutation) => mutation.path).join(", ")}`
        : `reinstalled missing plugin files (${entry.latest})`,
  };
};

/** A setup entry's detail: its first line, then the last five when it ran long. */
const briefDetail = (detail: string): string => {
  const lines = detail.split(/\r?\n/).filter((line) => line.trim());
  return (lines.length > 6 ? [lines[0], ...lines.slice(-5)] : lines).join(" | ");
};

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

const CLI_INSTALL_TIMEOUT_MS = 300_000;

export type UpgradeResult = {
  ok: boolean;
  /** The exit code of the new CLI that finished the upgrade after the CLI step. */
  handedOff?: number;
  backup?: string;
  error?: string;
  hosts: HostOutcome[];
};

/**
 * OpenCode's row from the plugin version before the update, after it, and the
 * published target. V2 loads the update live but lists the old version for a
 * moment, so the reading after waits for the target (bounded). Only a version
 * that already equaled the target before the update is "already current"; a
 * version below the target is never current.
 */
const opencodeOutcome = async (
  before: string | undefined,
  target: string | undefined,
  runAsync: ReturnType<typeof asyncRunner>,
  home: string,
  ready: UpgradeDeps["opencodeReady"],
): Promise<HostOutcome> => {
  const below = (version: string | undefined) =>
    target !== undefined && (version === undefined || !versionAtLeast(version, target));
  const after = await waitForOpencodeVersion(runAsync, home, target, ready);
  const live = "OpenCode V2 loads it live";
  if (before && target && versionAtLeast(before, target))
    return { host: "opencode", status: "current", reason: `already current (${before})` };
  if (after && below(after))
    return {
      host: "opencode",
      status: "updated",
      reason: `${OPENCODE_STALE} ${after} (published ${target}); the doctor below checks its package cache`,
    };
  if (before && after && after !== before)
    return { host: "opencode", status: "updated", reason: `${before} -> ${after}; ${live}` };
  // Same version and no target to compare with (the registry did not answer).
  if (before && after)
    return {
      host: "opencode",
      status: "current",
      reason: `unchanged (${after}); the published version could not be read`,
    };
  if (after) return { host: "opencode", status: "updated", reason: `now ${after}; ${live}` };
  return { host: "opencode", status: "updated", reason: `scoped update ran; ${live}` };
};

/** Apply one plan entry; any thrown error stays this host's failure. */
const applyEntry = async (
  entry: PlanEntry,
  context: {
    runAsync: ReturnType<typeof asyncRunner>;
    paths: ReturnType<typeof upgradePaths>;
    configDir: string;
    opencodeReady?: UpgradeDeps["opencodeReady"];
  },
): Promise<HostOutcome> => {
  const { runAsync, paths, configDir } = context;
  const { home, env } = paths;
  const fail = (reason: string): HostOutcome => ({
    host: entry.host,
    status: "failed",
    reason,
    fix: entry.fix,
  });
  if (entry.install) return applyRepair(entry, entry.install.preview, context);
  if (entry.host === "cursor") {
    // The init wizard's installer: setup's install-host + install-adapter
    // mutations, scoped to Cursor; workspaces and other config stay untouched.
    const commands = entry.commands.map((command) => ({
      ...command,
      purpose: command.purpose ?? "Upgrade Cursor",
    }));
    const cursorSettings = path.join(home, ".cursor", "settings.json");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
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
          commands,
        },
        { type: "install-adapter", platform: "cursor", path: paths.cursorRoot },
        // The same registrations the init wizard writes: a stale or non-canonical
        // workit MCP entry is rewritten to the current launcher, other servers stay.
        { type: "register-platform", platform: "cursor", path: cursorSettings },
        { type: "register-platform", platform: "cursor", path: cursorMcp },
      ],
    };
    const result = await applyInstallPreview(preview, runAsync, {
      home,
      env,
      cwd: home,
      preferInstalledAdapter: true,
    });
    const installed = objectOrNull(path.join(paths.cursorRoot, "package.json"));
    const problems = result.entries
      .filter((one) => one.status === "Failed")
      .map((one) => one.detail ?? `${one.file} failed`);
    if (problems.length)
      return fail(`Cursor install failed: ${problems.map(briefDetail).join("; ")}`);
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
  let before: string | undefined;
  if (entry.host === "opencode") {
    // OpenCode's service activates plugins in the background: an update that
    // arrives first fails with `Plugin is not configured`. Wait until it lists Workit.
    const ready = await waitForOpencodePlugin(runAsync, home, context.opencodeReady);
    if (!ready) return fail(OPENCODE_NOT_READY);
    before = ready.version;
  }
  for (const command of entry.commands) {
    const where = command.cwd ? { cwd: command.cwd } : undefined;
    let result = await runAsync(command.command, command.args, where);
    // A cold package cache or a transient registry error fails `opencode plugin
    // update` once and succeeds moments later: retry it once before it reads FAILED.
    if (result.status !== 0 && entry.host === "opencode")
      result = await runAsync(command.command, command.args, where);
    if (result.status !== 0) return fail(failureReason(command, result));
  }
  if (entry.host === "opencode")
    return opencodeOutcome(before, entry.published, runAsync, home, context.opencodeReady);
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
    entry.host === "codex" ? await codexInventory(runAsync) : await runAsync("pi", ["list"]);
  if (verify.status !== 0)
    return fail(
      `update verification failed${stderrTail(verify.stderr) ? `: ${stderrTail(verify.stderr)}` : ""}`,
    );
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
    if (
      installed.some(
        (plugin) => plugin.name === "workit" && plugin.marketplaceName === CODEX_LEGACY_MARKETPLACE,
      )
    )
      return fail(
        `Codex still registers workit@${CODEX_LEGACY_MARKETPLACE}; its hooks would run twice`,
      );
  }
  if (entry.host === "pi" && piInstalledVersion(verify.stdout, entry.selector) !== entry.latest)
    return fail("Pi did not report the requested Workit package version");
  return {
    host: entry.host,
    status: "updated",
    reason: entry.repair
      ? `reinstalled missing plugin files (${entry.latest})`
      : `${entry.installedVersion ?? "?"} -> ${entry.latest}`,
  };
};

/** Codex agents live outside the plugin: its launcher copies them (doctor's codex_agents fix). */
const refreshCodexAgents = async (
  run: ReturnType<typeof asyncRunner>,
  codexHome: string,
): Promise<{ ok: boolean; note: string; fix?: string }> => {
  const root = codexPluginRoot(codexHome);
  const launcher = root && path.join(root, "dist", "launch-mcp.js");
  if (!launcher || !existsSync(launcher)) return { ok: true, note: "" };
  const fix = `node ${JSON.stringify(launcher)} --install-agents`;
  const refreshed = await run("node", [launcher, "--install-agents"]);
  return refreshed.status === 0
    ? { ok: true, note: "agents refreshed" }
    : {
        ok: false,
        note: `agent refresh failed${stderrTail(refreshed.stderr) ? `: ${stderrTail(refreshed.stderr)}` : ""}`,
        fix,
      };
};

export async function applyUpgrade(
  plan: UpgradePlan,
  deps: UpgradeDeps = {},
  options: {
    /** After the CLI updated: let the new CLI finish (its exit code), or undefined to go on here. */
    handoff?: (cli: HostOutcome) => Promise<number | undefined>;
    /** Back up and remove the other CLI installs (the y/N answer); false prints their commands. */
    removeCopies?: boolean;
  } = {},
): Promise<UpgradeResult> {
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
  const { configDir } = paths;
  // Hook launchers find a Node >= the floor from this record when the PATH node is older.
  recordHookNode(deps.env ?? process.env);
  const backup = path.join(
    workitStateDir(paths.env),
    "upgrades",
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
  const runAsync = asyncRunner(deps);
  const progress = deps.progress ?? createProgress({ json: true });
  const statusOf = (outcome: HostOutcome | undefined): StepStatus =>
    outcome?.status === "failed" ? "failed" : outcome?.status === "updated" ? "done" : "skipped";
  // The CLI goes first, so the host steps run with the new release's code:
  // the new CLI finishes them, or (a failed CLI install) this one does and says so.
  if (plan.cli) {
    let cli: HostOutcome;
    try {
      cli = await progress.run(
        "Updating the CLI",
        () =>
          applyCli(
            plan.cli!,
            // npm install of the CLI may outlast the 60 s host-command bound.
            asyncRunner(deps, CLI_INSTALL_TIMEOUT_MS),
            backup,
            deps,
            options.removeCopies ?? false,
          ),
        statusOf,
        { signals: true },
      );
    } catch (error) {
      cli = { host: "cli", status: "failed", reason: errorText(error), fix: CLI_FIX };
    }
    if (cli.status === "updated" && options.handoff) {
      const code = await options.handoff(cli);
      if (code !== undefined) return { ...done(backup), hosts: [...hosts, cli], handedOff: code };
      if (plan.entries.length)
        cli = {
          ...cli,
          reason: `${cli.reason}; the new CLI could not be started, hosts upgraded with workit ${pkg.version}`,
        };
    } else if (cli.status === "failed" && plan.entries.length)
      cli = { ...cli, reason: `${cli.reason}; hosts upgraded with workit ${pkg.version}` };
    hosts.push(cli);
  }
  // A failed backup fails only Cursor's row: never repair without one.
  let cursorBackupError: string | null = null;
  if (plan.entries.some((entry) => entry.host === "cursor") && existsSync(paths.cursorRoot))
    try {
      cpSync(paths.cursorRoot, path.join(backup, "cursor-package"), {
        recursive: true,
      });
    } catch (error) {
      cursorBackupError = `could not back up the Cursor plugin: ${errorText(error)}`;
    }
  const listed = plan.entries.length ? listProcesses(deps) : [];
  const running = (listed ?? []).flatMap((entry) => classifyProcess(entry) ?? []);
  for (const [index, entry] of plan.entries.entries()) {
    const before = hosts.length;
    const count = plan.entries.length > 1 ? `[${index + 1}/${plan.entries.length}] ` : "";
    const step = progress.start(`${count}Updating ${entry.host}`);
    try {
      if (entry.host === "cursor" && cursorBackupError) {
        hosts.push({
          host: "cursor",
          status: "failed",
          reason: cursorBackupError,
          fix: entry.fix,
        });
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
      // A running Codex app-server is left alone: it checks the installed plugin
      // version on each lookup, so new threads load a new version without a restart.
      let outcome: HostOutcome;
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- hosts upgrade one at a time on purpose: the per-step progress lines read in order and one host's failure never races another's.
        outcome = await applyEntry(entry, {
          runAsync,
          paths,
          configDir,
          opencodeReady: deps.opencodeReady,
        });
        if (entry.host === "codex" && outcome.status === "updated") {
          const agents = await refreshCodexAgents(runAsync, paths.codexHome);
          if (!agents.ok)
            outcome = {
              ...outcome,
              status: "failed",
              reason: `${outcome.reason}; ${agents.note}`,
              fix: agents.fix,
            };
          else
            outcome = {
              ...outcome,
              reason: `${outcome.reason}${agents.note ? `; ${agents.note}` : ""}; new Codex threads load it`,
            };
        }
      } catch (error) {
        outcome = {
          host: entry.host,
          status: "failed",
          reason: errorText(error),
          fix: entry.fix,
        };
      }
      if (entry.host === "opencode") {
        const servers = running.filter(
          (proc) => proc.host === "opencode" && proc.kind === "daemon",
        );
        // V2 loads an update live: a restart only for one it never listed.
        if (servers.length && outcome.reason.startsWith(OPENCODE_STALE))
          outcome = {
            ...outcome,
            reason: `${outcome.reason}; restart opencode serve (${servers.map(describe).join("; ")}) to load it`,
          };
      }
      hosts.push(outcome);
    } finally {
      const added = hosts.length > before ? hosts[hosts.length - 1] : undefined;
      step.end(statusOf(added), added && added.status !== "updated" ? added.reason : undefined);
    }
  }
  // Codex already current: its agent copies can still lag behind the plugin.
  if (hosts.some((entry) => entry.host === "codex" && entry.status === "current")) {
    let agents: Awaited<ReturnType<typeof refreshCodexAgents>>;
    try {
      agents = await refreshCodexAgents(runAsync, paths.codexHome);
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
  return done(backup);
}

const isSymbolicLink = (file: string): boolean => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The one command that makes PATH's `workit` the owned launcher: the left
 * copy's own removal command when that copy is what PATH runs; a foreign file
 * at the launcher's place moved into the backup and replaced by the link;
 * else the launcher's directory first on PATH.
 */
const pathFix = (
  seen: string | null,
  context: {
    launcher: string;
    linked: string;
    backup: string;
    left: { copy: { path: string }; command: string }[];
  },
): string => {
  const left = context.left.find((entry) => entry.copy.path === seen);
  if (left) return left.command;
  const { launcher, linked } = context;
  if (seen === linked && realpathOr(linked) !== realpathOr(launcher)) {
    const save = path.join(context.backup, "cli-copies", "launcher-place");
    return `mkdir -p ${shellQuote(save)} && mv ${shellQuote(linked)} ${shellQuote(save)}/ && ln -s ${shellQuote(launcher)} ${shellQuote(linked)}`;
  }
  if (seen === linked) return CLI_FIX;
  return `export PATH=${shellQuote(path.dirname(linked))}:"$PATH"`;
};

/**
 * The owned CLI install (#648): install the version under installRoot() with
 * a Node >= 24's own npm, swap `current`, write the launcher, migrate the
 * other copies (removed only when `removeCopies`), then require the
 * PATH-resolved `workit --version` to print the new version.
 */
const applyCli = async (
  cli: NonNullable<UpgradePlan["cli"]>,
  run: ReturnType<typeof asyncRunner>,
  backup: string,
  deps: UpgradeDeps,
  removeCopies: boolean,
): Promise<HostOutcome> => {
  const { env } = upgradePaths(deps);
  const fail = (reason: string, details?: string[], fix = CLI_FIX): HostOutcome => ({
    host: "cli",
    status: "failed",
    reason,
    fix,
    ...(details?.length ? { details } : {}),
  });
  const node = (deps.installNode ?? (() => resolveInstallNode(env)))();
  if (!node)
    return fail(
      "no Node 24+ with npm found to install the CLI with (WORKIT_NODE, the recorded node, fnm, nvm, volta, mise, asdf); install one (fnm install 24) and rerun",
    );
  if (cli.install) {
    const installed = await installOwned(cli.latest, { env, node, run });
    if (!installed.ok)
      return fail(
        `${installed.reason}; current still points to ${installed.previous ?? "nothing"} under ${cli.root}`,
      );
  }
  const launchers = writeLaunchers({ env, installNode: node.node });
  const migration = await migrateCopies(migrationCopies(env), {
    remove: removeCopies,
    backup,
    env,
    node,
    run,
  });
  // A foreign file at the launcher's place that migration did not replace stays visible.
  if (removeCopies && launchers.foreign) writeLaunchers({ env, installNode: node.node });
  const details = [
    ...migration.removed.map((copy) =>
      copy.kind === "wrapper" && isSymbolicLink(copy.path)
        ? `replaced with a link to ${launchers.launcher} (backup in ${backup}): ${describeInstall(copy)}`
        : `removed (backup in ${backup}): ${describeInstall(copy)}`,
    ),
    ...(migration.left.length
      ? [
          `other installs left in place; back them up and remove them with:`,
          ...leftLines(migration.left).flatMap((line) => line.split("\n")),
        ]
      : []),
  ];
  // The proof: `workit --version` as a new login shell resolves it (no npx cache dir).
  const seen = (deps.pathWorkit ?? (() => pathResolvedWorkit(env)))();
  if (seen.version !== cli.latest) {
    const listing = listInstalls(env).map(
      (install) => `  ${describeInstallAt(install, launchers.linked)}`,
    );
    const onPath = path.dirname(launchers.linked);
    return fail(
      seen.path
        ? `installed ${cli.latest} under ${cli.root}, but PATH runs ${seen.path} (${seen.version ?? seen.error ?? "unknown"}), not ${cli.latest}; \`workit\` does not reach the owned install until the fix below runs`
        : `installed ${cli.latest} under ${cli.root}, but ${seen.error ?? "no workit on PATH"}; put ${onPath} first on PATH (in your shell profile too)`,
      [`workit installs (which -a order, then other prefixes):`, ...listing, ...details],
      pathFix(seen.path, { ...launchers, backup, left: migration.left }),
    );
  }
  return {
    host: "cli",
    status: "updated",
    reason: cli.install ? `${cli.installed} -> ${cli.latest}` : `owned install ${cli.latest}`,
    details: [`PATH runs ${seen.path} (workit ${seen.version})`, ...details],
  };
};
