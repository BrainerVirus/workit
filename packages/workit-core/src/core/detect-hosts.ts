// Host presence detection for the CLI setup wizard: which tools are installed
// (CLI on PATH or home config marker — never a subprocess probe) and which of
// the wizard-managed hosts already carry a workit registration. The configured
// signal reuses planUninstall's installed bit so detection and uninstall can
// never disagree; codex/pi are presence-only (their setup runs via cutover).
import { existsSync, readdirSync } from "node:fs";
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
      cliFound(host, env, home) || HOME_MARKERS[host].some((m) => existsSync(path.join(home, m)));
    found[host] = {
      detected,
      configured: WIZARD_HOSTS.includes(host) && (configuredByHost.get(host) ?? false),
    };
  }
  return found;
}

/**
 * CLI lookup beyond ambient PATH: version-manager shims (fnm multishells,
 * nvm, asdf) and ~/.local/bin vanish from bare non-interactive PATHs, so a
 * tool installed under one is still present. Presence-only statSync reads —
 * never a subprocess probe.
 */
export function cliFound(name: string, env: NodeJS.ProcessEnv, home: string): boolean {
  if (commandOnPath(name, env)) return true;
  const extra = managerBinDirs(home);
  if (extra.length === 0) return false;
  return commandOnPath(name, {
    ...env,
    PATH: [...(env.PATH ?? "").split(path.delimiter), ...extra].join(path.delimiter),
  });
}

const managerBinDirs = (home: string): string[] => {
  const dirs = [path.join(home, ".local", "bin"), path.join(home, ".asdf", "shims")];
  // One-level layouts: fnm node-versions/<v>/installation/bin, nvm node/<v>/bin.
  const versioned: Array<[base: string, tail: string]> = [
    [path.join(home, ".local", "share", "fnm", "node-versions"), path.join("installation", "bin")],
    [path.join(home, ".nvm", "versions", "node"), "bin"],
  ];
  for (const [base, tail] of versioned) {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        if (entry.isDirectory()) dirs.push(path.join(base, entry.name, tail));
      } catch {
        /* keep scanning */
      }
    }
  }
  return dirs;
};
