// `workit upgrade --check` (installed vs latest, nothing changed) and
// `workit upgrade --set-updates=<mode>` (the launch check's global setting).
import path from "node:path";
import { isUpdatesMode, UPDATES_MODES } from "@brainervirus/workit-core/src/core/config";
import pkg from "../../package.json" with { type: "json" };
import { createStyle } from "../style";
import {
  CLI_PACKAGE,
  readUpdateCache,
  readUpdatesMode,
  writeUpdateCache,
  writeUpdatesMode,
} from "../update-check";
import { sources } from "./plan";
import {
  HOSTS,
  registryVersion,
  runner,
  upgradePaths,
  versionAtLeast,
  type HostOutcome,
  type UpgradeDeps,
  type UpgradeHost,
} from "./shared";

type ComponentStatus = "current" | "update" | "unknown" | "unavailable" | "unreadable";
type Component = {
  component: UpgradeHost;
  package: string;
  installed: string | null;
  latest: string | null;
  status: ComponentStatus;
  reason?: string;
};

const APPLY = "workit upgrade --yes";
const SET_USAGE = `Usage: workit upgrade --set-updates=${UPDATES_MODES.join("|")}\n`;

const statusOf = (installed: string | undefined, latest: string | undefined): ComponentStatus =>
  !latest
    ? "unavailable"
    : !installed
      ? "unknown"
      : versionAtLeast(installed, latest)
        ? "current"
        : "update";

const LABEL: Record<ComponentStatus, string> = {
  current: "current",
  update: "update available",
  unknown: "installed version unknown",
  unavailable: "registry unavailable",
  unreadable: "could not be read",
};

export function runUpdateCheck(json: boolean, deps: UpgradeDeps): number {
  const out = deps.out ?? process.stdout;
  const paths = upgradePaths(deps);
  const run = runner(deps);
  const latest = (name: string) => registryVersion(run, name);
  const cliLatest = latest(CLI_PACKAGE);
  // The launch check reads this cache; a check that reached the registry refreshes it.
  if (cliLatest)
    writeUpdateCache(paths.env, {
      ...readUpdateCache(paths.env),
      checkedAt: Date.now(),
      latest: cliLatest,
    });
  const components: Component[] = [
    {
      component: "cli",
      package: CLI_PACKAGE,
      installed: pkg.version,
      latest: cliLatest ?? null,
      status: statusOf(pkg.version, cliLatest),
    },
  ];
  const failed: HostOutcome[] = [];
  const installed = sources(paths, run, HOSTS, failed);
  const unreadableBy = new Map(failed.map((entry) => [entry.host, entry]));
  const versionBy = new Map<string, string | undefined>();
  for (const source of installed)
    if (!versionBy.has(source.host) || source.installedVersion)
      versionBy.set(source.host, versionBy.get(source.host) ?? source.installedVersion);
  for (const host of HOSTS) {
    const name = `@brainervirus/workit-${host}`;
    const unreadable = unreadableBy.get(host);
    if (unreadable) {
      components.push({
        component: host,
        package: name,
        installed: null,
        latest: null,
        status: "unreadable",
        reason: unreadable.reason,
      });
      continue;
    }
    if (!versionBy.has(host)) continue;
    const version = versionBy.get(host);
    const newest = latest(name);
    components.push({
      component: host,
      package: name,
      installed: version ?? null,
      latest: newest ?? null,
      status: statusOf(version, newest),
    });
  }
  const pending = components.some(
    (entry) => entry.status === "update" || entry.status === "unknown",
  );
  const updates = readUpdatesMode(paths.env);
  if (json) {
    out.write(
      JSON.stringify({ updates, components, apply: pending ? APPLY : null }, null, 2) + "\n",
    );
    return 0;
  }
  const style = createStyle({
    stream: out === process.stdout ? process.stdout : undefined,
    env: paths.env,
  });
  const width = Math.max(...components.map((entry) => entry.component.length));
  const rows = components.map((entry) => {
    const label = LABEL[entry.status];
    const paint =
      entry.status === "current" ? style.ok : entry.status === "update" ? style.warn : style.dim;
    return `  ${entry.component.padEnd(width)}  ${entry.installed ?? "-"} -> ${entry.latest ?? "?"}  ${paint(label)}${entry.reason ? ` (${entry.reason})` : ""}\n`;
  });
  out.write(
    `${style.bold("Workit versions")} (updates: ${updates}; change with ${style.command(`workit upgrade --set-updates=${UPDATES_MODES.join("|")}`)})\n${rows.join("")}`,
  );
  out.write(
    pending
      ? `Apply with: ${style.command(APPLY)} (upgrades the CLI and every host plugin together)\n`
      : `${style.ok("Everything is current.")}\n`,
  );
  out.write(`${style.dim("check only; nothing changed.")}\n`);
  return 0;
}

export function runSetUpdates(value: string, deps: UpgradeDeps): number {
  const out = deps.out ?? process.stdout;
  if (!isUpdatesMode(value)) {
    out.write(SET_USAGE);
    return 2;
  }
  const { env, configDir } = upgradePaths(deps);
  const error = writeUpdatesMode(env, value);
  if (error) {
    out.write(`updates not changed: ${error}\n`);
    return 1;
  }
  out.write(`updates: ${value} (saved in ${path.join(configDir, "config.json")})\n`);
  return 0;
}
