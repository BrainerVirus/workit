import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { type HostId } from "./admin/detect-hosts";
import { hostCommand, type HostInstallCommand } from "./admin/host-install";
import { runDoctor } from "./admin/doctor";
import {
  applyHostPermissions,
  permissionDiff,
  planHostPermissions,
} from "./admin/host-permissions";
import { createProgress } from "./progress";
import { createStyle } from "./style";
import { applyUpgrade } from "./upgrade/apply";
import { runUpdateCheck, runSetUpdates } from "./upgrade/check";
import { planCli, previewUpgrade, probedRunner } from "./upgrade/plan";
import { runProbes } from "./upgrade/probes";
import { askConfirm, summary, table } from "./upgrade/report";
import {
  HOSTS,
  LAUNCH_HOSTS,
  upgradePaths,
  type HostOutcome,
  type UpgradeDeps,
} from "./upgrade/shared";

export { applyUpgrade } from "./upgrade/apply";
export { previewUpgrade } from "./upgrade/plan";
export { classifyProcess } from "./upgrade/processes";
export type { HostProcess, UpgradeDeps } from "./upgrade/shared";

const USAGE =
  "Usage: workit upgrade [--hosts=opencode,cursor,codex,pi,claude-code|none] [--cli] [--preview | --yes | --apply --confirm] [--json]\n       workit upgrade --check [--json]\n       workit upgrade --set-updates=prompt|auto|off\n";

export async function runUpgradeCommand(argv: string[], deps: UpgradeDeps = {}): Promise<number> {
  const { env } = upgradePaths(deps);
  const handBack = env[CONTINUE_ENV] !== undefined ? env[ROWS_ENV] : undefined;
  const handed: { rows?: HostOutcome[] } = {};
  const code = await upgradeOnce(argv, deps, handed);
  if (!handBack) return code;
  // Re-executed by the older CLI: it reports the exit code (and the one failure
  // line under it), so this process hands both back and exits 0.
  try {
    writeFileSync(handBack, JSON.stringify({ code, rows: handed.rows ?? [] }));
    return 0;
  } catch {
    return code;
  }
}

async function upgradeOnce(
  argv: string[],
  deps: UpgradeDeps,
  handed: { rows?: HostOutcome[] },
): Promise<number> {
  const out = deps.out ?? process.stdout;
  // Read-only and settings forms: one flag each (plus --json for --check).
  const setting = argv.find((arg) => arg.startsWith("--set-updates="));
  if (argv.includes("--check") || setting) {
    const extra = argv.filter((arg) => arg !== "--check" && arg !== "--json" && arg !== setting);
    if (extra.length || (setting && argv.length > 1)) {
      out.write(USAGE);
      return 2;
    }
    return setting
      ? runSetUpdates(setting.slice("--set-updates=".length), deps)
      : await runUpdateCheck(argv.includes("--json"), deps);
  }
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
  const { home, env } = upgradePaths(deps);
  // Set by an older CLI that just installed this one: the CLI is done, finish the hosts.
  const continued = env[CONTINUE_ENV] !== undefined ? priorRows(env[CONTINUE_ENV]) : undefined;
  const progress = deps.progress ?? createProgress({ stream: process.stderr, json });
  // The global CLI is part of the default upgrade; --hosts narrows it to hosts unless --cli.
  const withCli = !continued && (hostFlag === undefined || flags.has("--cli"));
  const checking = raw.length + (withCli ? 1 : 0);
  const plan = await progress.run(
    `Checking ${checking} ${checking === 1 ? "host" : "hosts"}`,
    async () => {
      // Every registry and inventory probe at once; planning then reads their results.
      const probes = await runProbes(raw as HostId[], withCli, deps);
      const planned = previewUpgrade(raw as HostId[], deps, probes);
      if (withCli) planCli(planned, probedRunner(deps, probes));
      return planned;
    },
  );
  plan.ok = plan.blocked.length === 0 && plan.failed.length === 0;
  // Issue #297: refresh a Workit permission block `workit setup` already
  // wrote (never add one, never set the shell); the diff is part of the plan.
  // Color only when the report goes to the real stdout or stderr (the launch
  // check's upgrade); an injected `out` stays plain.
  const style = createStyle({
    stream:
      out === process.stdout ? process.stdout : out === process.stderr ? process.stderr : undefined,
    env,
    json,
  });
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
  const nothingChanged = `${style.dim("preview only; nothing changed.")} Apply with: ${style.command(applyCommand)}\n`;
  if (json && !legacy && !flags.has("--yes")) {
    // --json without an apply flag is the machine-readable preview.
    out.write(JSON.stringify(withPermissions(plan), null, 2) + "\n");
    return plan.blocked.length ? 1 : 0;
  }
  if (!json)
    out.write(
      continued
        ? `Continuing the upgrade with the new CLI (workit ${pkg.version}).\n`
        : summary(plan, permissions.changes, style),
    );
  if (flags.has("--preview")) {
    out.write(nothingChanged);
    return plan.blocked.length ? 1 : 0;
  }
  if (plan.blocked.length) {
    out.write(`${style.fail("Upgrade blocked:")} ${plan.blocked.join("; ")}\nNothing changed.\n`);
    return 1;
  }
  const work =
    plan.entries.length + plan.migrations.length + (plan.cli ? 1 : 0) + permissions.changes.length;
  if (work > 0 && !flags.has("--yes") && !legacy) {
    const confirmed = await (deps.confirm ?? ((q: string) => askConfirm(q, out)))(
      `${style.bold("Apply this upgrade?")} [y/N] `,
    );
    if (!confirmed) {
      out.write(nothingChanged);
      return 0;
    }
  }
  if (json) for (const warning of plan.warnings ?? []) out.write(`warning: ${warning}\n`);
  // After the CLI updated, the new CLI finishes: the same flags, narrowed to the hosts.
  // An injected host runner without a re-exec seam is a test: it finishes here.
  const reexec =
    deps.reexec ??
    (deps.run && !deps.cliEntry
      ? undefined
      : spawnUpgrade({
          entry: deps.cliEntry ?? process.argv[1],
          out,
          toStderr: out === process.stderr,
          json,
        }));
  const handoff = async (cli: HostOutcome): Promise<number | undefined> => {
    if (!reexec || (deps.cliOnDisk ?? runningCliVersion)() !== plan.cli?.latest) return undefined;
    const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-upgrade-"));
    const rowsFile = path.join(scratch, "rows.json");
    try {
      const code = await reexec(
        [
          ...(legacy ? ["--apply", "--confirm"] : ["--yes"]),
          ...(flags.has("--json") ? ["--json"] : []),
          `--hosts=${raw.length ? raw.join(",") : "none"}`,
        ],
        {
          [CONTINUE_ENV]: JSON.stringify([cli]),
          [ROWS_ENV]: rowsFile,
          WORKIT_UPDATE_CHECK: "0",
        },
      );
      if (code === undefined) return undefined;
      const back = handedBack(readText(rowsFile));
      deps.onResult?.(back?.rows.length ? back.rows : [cli]);
      return back?.code ?? code;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const result = await applyUpgrade(
    plan,
    { ...deps, progress },
    continued || !reexec ? {} : { handoff },
  );
  if (result.handedOff !== undefined) return result.handedOff;
  if (continued?.length) {
    result.hosts.unshift(...continued);
    if (continued.some((row) => row.status === "failed")) result.ok = false;
  }
  let permissionsOk = true;
  let written: ReturnType<typeof applyHostPermissions> | undefined;
  if (
    permissions.changes.length &&
    !permissions.refused &&
    !result.error?.startsWith("configuration changed")
  ) {
    written = progress.runSync(
      "Refreshing the permission block",
      () => applyHostPermissions(permissions, { home, env }),
      (entries) => (entries.every((entry) => entry.status === "written") ? "done" : "failed"),
    );
    permissionsOk = written.every((entry) => entry.status === "written");
    for (const entry of written)
      result.hosts.push({
        host: "permissions",
        status: entry.status === "written" ? "updated" : "failed",
        reason: `${entry.host} block ${entry.status === "written" ? "refreshed" : entry.status} in ${entry.file}`,
        ...(entry.status === "written" ? {} : { fix: `workit setup --hosts=${entry.host}` }),
      });
  }
  deps.onResult?.(result.hosts);
  handed.rows = result.hosts;
  const failed = !result.ok || !permissionsOk;
  const cliVersion =
    plan.cli && result.hosts.some((h) => h.host === "cli" && h.status === "updated")
      ? plan.cli.latest
      : pkg.version;
  const report = progress.runSync("Checking the result with workit doctor", () =>
    (
      deps.doctor ??
      ((version: string) => runDoctor({ home, env, cliVersion: version, only: "upgrade" }))
    )(cliVersion),
  );
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
    out.write(`${style.fail("Upgrade stopped:")} ${result.error}\n`);
  out.write(table(result.hosts, style));
  if (permissions.refused)
    out.write(`permissions: ${style.warn("not refreshed:")} ${permissions.refused}\n`);
  if (result.backup) out.write(`Backup: ${style.path(result.backup)}\n`);
  out.write(
    left.length === 0
      ? `${style.ok("Verified:")} workit doctor is clean for versions, assets, agents, stale installs and permissions.\n`
      : `${style.warn("Left after upgrade (workit doctor):")}\n${left
          .map(
            (check) =>
              `  ${style.bold(check.id)}: ${check.detail}${check.fix ? `\n    fix: ${style.command(check.fix)}` : ""}`,
          )
          .join("\n")}\n`,
  );
  return failed ? 1 : 0;
}

/** Marks the upgrade the older CLI re-executes: the rows it already has (JSON). */
const CONTINUE_ENV = "WORKIT_UPGRADE_CONTINUE";
/** Where the re-executed upgrade writes its rows for the older CLI's caller. */
const ROWS_ENV = "WORKIT_UPGRADE_ROWS";

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Rows handed between the two CLIs; anything unreadable is no rows. */
const priorRows = (text: string | undefined): HostOutcome[] | undefined => {
  if (text === undefined) return undefined;
  try {
    const rows: unknown = JSON.parse(text);
    return Array.isArray(rows)
      ? rows.filter(
          (row): row is HostOutcome =>
            typeof row?.host === "string" &&
            typeof row?.status === "string" &&
            typeof row?.reason === "string",
        )
      : [];
  } catch {
    return [];
  }
};

/** What the re-executed upgrade hands back: its exit code and rows. */
const handedBack = (
  text: string | undefined,
): { code: number | undefined; rows: HostOutcome[] } | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as { code?: unknown; rows?: unknown };
    return {
      code: typeof value.code === "number" ? value.code : undefined,
      rows: priorRows(JSON.stringify(value.rows ?? [])) ?? [],
    };
  } catch {
    return undefined;
  }
};

/** The version in the running entry's package.json as it is on disk now. */
const runningCliVersion = (): string | undefined => {
  const script = process.argv[1];
  if (!script) return undefined;
  let dir = path.dirname(script);
  for (let depth = 0; depth < 4; depth += 1, dir = path.dirname(dir)) {
    const found = cliPackageVersion(readText(path.join(dir, "package.json")));
    if (found) return found;
  }
  return undefined;
};

const cliPackageVersion = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  try {
    const found = JSON.parse(text) as { name?: unknown; version?: unknown };
    return found.name === pkg.name && typeof found.version === "string" ? found.version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `workit upgrade <argv>` from the same entry script, now the new package on
 * disk. Under --json its stdout is captured and passed on, so stdout stays one
 * JSON document; otherwise it goes where this run's report goes.
 */
const spawnUpgrade =
  (options: {
    entry: string | undefined;
    out: { write: (text: string) => void };
    toStderr: boolean;
    json: boolean;
  }) =>
  (argv: string[], extra: Record<string, string>): number | undefined => {
    if (!options.entry) return undefined;
    const result = spawnSync(process.execPath, [options.entry, "upgrade", ...argv], {
      stdio: ["inherit", options.json ? "pipe" : options.toStderr ? 2 : "inherit", "inherit"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...extra },
    });
    if (result.error) return undefined;
    if (options.json && result.stdout) options.out.write(result.stdout);
    return result.status ?? 1;
  };

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
      const result = await applyUpgrade(plan, deps);
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
