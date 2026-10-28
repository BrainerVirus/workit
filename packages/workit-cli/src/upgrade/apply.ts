import { existsSync, readdirSync, mkdirSync, copyFileSync, chmodSync, cpSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { claudeWorkitInstalls } from "../admin/host-install";
import { readSetupState } from "../admin/setup-state";
import { applySetupPreview, type SetupPreview } from "../admin/setup";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
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
  runner,
  upgradePaths,
  versionAtLeast,
  type HostOutcome,
  type PlanEntry,
  type UpgradeDeps,
  type UpgradePlan,
} from "./shared";

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

/** The installed Workit OpenCode plugin version from `opencode plugin list`, if it prints one. */
const opencodeVersion = (run: ReturnType<typeof runner>): string | undefined => {
  const listing = run("opencode", ["plugin", "list"]);
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
  const before = entry.host === "opencode" ? opencodeVersion(run) : undefined;
  for (const command of entry.commands)
    if (run(command.command, command.args).status !== 0)
      return fail(`\`${command.command} ${command.args.join(" ")}\` failed`);
  if (entry.host === "opencode") {
    const after = opencodeVersion(run);
    if (before && after)
      return after === before
        ? {
            host: "opencode",
            status: "current",
            reason: `already current (${after})`,
          }
        : {
            host: "opencode",
            status: "updated",
            reason: `${before} -> ${after}; OpenCode V2 loads it live`,
          };
    return {
      host: "opencode",
      status: "updated",
      reason: "scoped update ran; OpenCode V2 loads it live",
    };
  }
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
    reason: entry.repair
      ? `reinstalled missing plugin files (${entry.latest})`
      : `${entry.installedVersion ?? "?"} -> ${entry.latest}`,
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
      cpSync(paths.cursorRoot, path.join(backup, "cursor-package"), {
        recursive: true,
      });
    } catch (error) {
      cursorBackupError = `could not back up the Cursor plugin: ${errorText(error)}`;
    }
  const listed = plan.entries.length ? listProcesses(deps) : [];
  const running = (listed ?? []).flatMap((entry) => classifyProcess(entry) ?? []);
  for (const entry of plan.entries) {
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
      hosts.push({
        host: "cli",
        status: "failed",
        reason: errorText(error),
        fix: CLI_FIX,
      });
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
