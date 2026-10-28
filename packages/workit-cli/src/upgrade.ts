import { spawnSync } from "node:child_process";
import pkg from "../package.json" with { type: "json" };
import { type HostId } from "./admin/detect-hosts";
import { hostCommand, type HostInstallCommand } from "./admin/host-install";
import { runDoctor } from "./admin/doctor";
import {
  applyHostPermissions,
  permissionDiff,
  planHostPermissions,
} from "./admin/host-permissions";
import { applyUpgrade } from "./upgrade/apply";
import { planCli, previewUpgrade } from "./upgrade/plan";
import { askConfirm, summary, table } from "./upgrade/report";
import { HOSTS, LAUNCH_HOSTS, runner, upgradePaths, type UpgradeDeps } from "./upgrade/shared";

export { applyUpgrade, type UpgradeResult } from "./upgrade/apply";
export { previewUpgrade } from "./upgrade/plan";
export { classifyProcess } from "./upgrade/processes";
export type { HostProcess, UpgradeDeps, UpgradePlan } from "./upgrade/shared";

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
