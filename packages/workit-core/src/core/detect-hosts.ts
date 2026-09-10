// Host presence detection for the CLI setup wizard: which tools are installed
// (CLI on PATH or home config marker — never a subprocess probe) and which of
// the wizard-managed hosts already carry a workit registration. The configured
// signal reuses planUninstall's installed bit so detection and uninstall can
// never disagree; codex/pi are presence-only (their setup runs via cutover).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandOnPath } from "./doctor";
import { planUninstall, type UninstallPaths } from "./uninstall";

export type HostId = "opencode" | "cursor" | "codex" | "pi";

export type HostDetection = {
  /** CLI on PATH or a home config marker exists. */
  detected: boolean;
  /** A workit registration is present (opencode/cursor only; always false). */
  configured: boolean;
};

export type DetectHostsOptions = UninstallPaths;

const HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi"];

const HOME_MARKERS: Record<HostId, string[]> = {
  opencode: [path.join(".config", "opencode")],
  cursor: [".cursor"],
  codex: [".codex"],
  pi: [".pi"],
};

/** Hosts the wizard Apply path registers (codex/pi set up via cutover). */
export const WIZARD_HOSTS: HostId[] = ["opencode", "cursor"];

/** Detected hosts the wizard can preselect (presence ∩ wizard-managed). */
export function preselectedPlatforms(detection: Record<HostId, HostDetection>): string[] {
  return WIZARD_HOSTS.filter((host) => detection[host].detected);
}

export function emptyDetection(): Record<HostId, HostDetection> {
  return {
    opencode: { detected: false, configured: false },
    cursor: { detected: false, configured: false },
    codex: { detected: false, configured: false },
    pi: { detected: false, configured: false },
  };
}

export function detectHosts(options: DetectHostsOptions = {}): Record<HostId, HostDetection> {
  const env = options.env ?? process.env;
  // Same chain as uninstall path resolution: explicit home > env.HOME > homedir.
  const home = options.home ?? env.HOME ?? os.homedir();
  // Pure reader: classifies the installed state, never writes.
  const plan = planUninstall(options);
  const configuredByHost = new Map(plan.hosts.map((h) => [h.host, h.installed]));
  const found = emptyDetection();
  for (const host of HOSTS) {
    const detected =
      commandOnPath(host, env) || HOME_MARKERS[host].some((m) => existsSync(path.join(home, m)));
    found[host] = {
      detected,
      configured: WIZARD_HOSTS.includes(host) && (configuredByHost.get(host) ?? false),
    };
  }
  return found;
}
