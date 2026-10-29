import { existsSync, readdirSync, mkdirSync, copyFileSync, chmodSync, cpSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { claudeWorkitInstalls } from "../admin/host-install";
import { readSetupState } from "../admin/setup-state";
import { type HostCommandResult } from "../admin/host-install";
import { applySetupPreview, type SetupPreview } from "../admin/setup";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import { createProgress, type StepStatus } from "../progress";
import { classifyProcess, describe, listProcesses } from "./processes";
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

export type UpgradeResult = {
  ok: boolean;
  /** The exit code of the new CLI that finished the upgrade after the CLI step. */
  handedOff?: number;
  backup?: string;
  error?: string;
  hosts: HostOutcome[];
};

/** The installed Workit OpenCode plugin version from `opencode plugin list`, if it prints one. */
const opencodeVersion = async (
  run: ReturnType<typeof asyncRunner>,
): Promise<string | undefined> => {
  const listing = await run("opencode", ["plugin", "list"]);
  if (listing.status !== 0) return undefined;
  // Table: `ID  VERSION  SOURCE`; the row whose last field is the Workit package.
  for (const line of listing.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const source = fields[fields.length - 1].replace(/^file:\/\//, "");
    const version = fields[fields.length - 2];
    if (
      /^(?:npm:)?@brainervirus\/workit-opencode(?:@[^/\s]+)?$/.test(source) &&
      /^\d+\.\d+\.\d+$/.test(version)
    )
      return version;
  }
  return undefined;
};

/**
 * OpenCode's row from the plugin version before the update, after it, and the
 * published target. `opencode plugin list` can report the old version for a
 * moment after the update rewrote the cache, so a reading below the target is
 * taken once more. Only a version that already equaled the target before the
 * update is "already current"; a version below the target is never current.
 */
const opencodeOutcome = async (
  before: string | undefined,
  target: string | undefined,
  runAsync: ReturnType<typeof asyncRunner>,
): Promise<HostOutcome> => {
  const below = (version: string | undefined) =>
    target !== undefined && (version === undefined || !versionAtLeast(version, target));
  let after = await opencodeVersion(runAsync);
  if (below(after)) after = (await opencodeVersion(runAsync)) ?? after;
  const live = "OpenCode V2 loads it live";
  if (before && target && versionAtLeast(before, target))
    return { host: "opencode", status: "current", reason: `already current (${before})` };
  if (after && below(after))
    return {
      host: "opencode",
      status: "updated",
      reason: `update ran, but OpenCode still lists ${after} (published ${target}); the doctor below checks its package cache`,
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
  if (entry.host === "cursor") {
    // The init wizard's installer: setup's install-host + install-adapter
    // mutations, scoped to Cursor; workspaces and other config stay untouched.
    const commands = entry.commands.map((command) => ({
      ...command,
      purpose: command.purpose ?? "Upgrade Cursor",
    }));
    // The host commands (npm) wait on the async runner so the spinner keeps
    // moving; setup's synchronous installer then replays their recorded results
    // and goes on with the file steps (copy, settings, mcp.json).
    const recorded = new Map<object, HostCommandResult>();
    let history = "";
    for (const command of commands) {
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
    const result = applySetupPreview(preview, {
      home,
      env,
      cwd: home,
      preferInstalledAdapter: true,
      runHostCommand: (command) =>
        recorded.get(command) ?? {
          exitCode: 1,
          stdout: "",
          stderr: "command did not run",
        },
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
  const before = entry.host === "opencode" ? await opencodeVersion(runAsync) : undefined;
  for (const command of entry.commands) {
    let result = await runAsync(command.command, command.args);
    // A cold package cache or a transient registry error fails `opencode plugin
    // update` once and succeeds moments later: retry it once before it reads FAILED.
    if (result.status !== 0 && entry.host === "opencode")
      result = await runAsync(command.command, command.args);
    if (result.status !== 0) return fail(failureReason(command, result));
  }
  if (entry.host === "opencode") return opencodeOutcome(before, entry.published, runAsync);
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
    entry.host === "codex"
      ? await runAsync("codex", ["plugin", "list", "--json"])
      : await runAsync("pi", ["list"]);
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
        () => applyCli(plan.cli!, runAsync, backup),
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
  for (const entry of plan.entries) {
    const before = hosts.length;
    const step = progress.start(`Updating ${entry.host}`);
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
      // Codex's app-server daemon holds the plugin: stop it with Codex's own
      // command and always start it again, whatever the update did.
      const daemons = running.filter((proc) => proc.host === "codex" && proc.kind === "daemon");
      const stopDaemon = entry.host === "codex" && daemons.length > 0;
      const stopped = stopDaemon
        ? // react-doctor-disable-next-line react-doctor/async-await-in-loop -- hosts upgrade one at a time on purpose: the Codex daemon must stop before its update and start after it, and the per-step progress lines read in order.
          await progress.run(
            "Stopping the Codex app-server daemon",
            () => runAsync("codex", ["app-server", "daemon", "stop"]),
            (result) => (result.status === 0 ? "done" : "failed"),
          )
        : null;
      if (stopped && stopped.status !== 0) {
        hosts.push({
          host: "codex",
          status: "failed",
          reason: `could not stop the Codex app-server daemon (${daemons.map(describe).join("; ")})${stderrTail(stopped.stderr) ? `: ${stderrTail(stopped.stderr)}` : ""}`,
          fix: "codex app-server daemon stop && workit upgrade --hosts=codex",
        });
        continue;
      }
      // Everything between the daemon's stop and start is caught, so the start
      // below always runs.
      let outcome: HostOutcome;
      try {
        outcome = await applyEntry(entry, { runAsync, paths, configDir });
        if (entry.host === "codex" && outcome.status === "updated") {
          const agents = await refreshCodexAgents(runAsync, paths.codexHome);
          if (!agents.ok)
            outcome = {
              ...outcome,
              status: "failed",
              reason: `${outcome.reason}; ${agents.note}`,
              fix: agents.fix,
            };
          else if (agents.note)
            outcome = {
              ...outcome,
              reason: `${outcome.reason}; ${agents.note}`,
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
      if (stopDaemon) {
        const started =
          (
            await progress.run(
              "Restarting the Codex app-server daemon",
              () => runAsync("codex", ["app-server", "daemon", "start"]),
              (result) => (result.status === 0 ? "done" : "failed"),
            )
          ).status === 0;
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
        const servers = running.filter(
          (proc) => proc.host === "opencode" && proc.kind === "daemon",
        );
        if (servers.length && outcome.status === "updated")
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

const applyCli = async (
  cli: NonNullable<UpgradePlan["cli"]>,
  run: ReturnType<typeof asyncRunner>,
  backup: string,
): Promise<HostOutcome> => {
  const fail = (reason: string): HostOutcome => ({
    host: "cli",
    status: "failed",
    reason,
    fix: CLI_FIX,
  });
  const currentRoot = await run("npm", ["root", "--global"]);
  if (currentRoot.status !== 0 || currentRoot.stdout.trim() !== cli.root)
    return fail("Global npm location changed; preview again");
  const cliBackup = path.join(backup, "cli-package");
  cpSync(path.join(cli.root, "@brainervirus/workit-cli"), cliBackup, {
    recursive: true,
  });
  const install = await run("npm", [
    "install",
    "--global",
    `@brainervirus/workit-cli@${cli.latest}`,
  ]);
  if (install.status !== 0)
    return fail(
      `CLI update failed${stderrTail(install.stderr) ? ` (${stderrTail(install.stderr)})` : ""}; preserved package at ${cliBackup}; use npm to repair or run node ${path.join(cliBackup, "dist/index.js")}`,
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
