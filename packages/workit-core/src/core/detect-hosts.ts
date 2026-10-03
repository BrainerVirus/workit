// Host presence detection uses actual CLI executables or supported desktop app
// locations; configuration directories alone never count as installation.
// Existing registrations reuse uninstall planning so the two paths agree.
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandOnPath } from "./doctor";
import { planUninstall, type UninstallPaths } from "./uninstall";
import {
  findHostExecutable,
  installedHostApp,
  isCodexWorkitInstalled,
  isPiWorkitInstalled,
  type HostId,
} from "./host-install";
export type { HostId } from "./host-install";

export type HostDetection = {
  /** Host executable or supported desktop application is present. */
  detected: boolean;
  /** A Workit registration is present for this host. */
  configured: boolean;
};

export type DetectHostsOptions = UninstallPaths;

const HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi"];

/** Hosts the setup wizard configures through their native install paths. */
export const WIZARD_HOSTS: HostId[] = [...HOSTS];

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
  const plan = planUninstall({ ...options, home, env });
  const configuredByHost = new Map(plan.hosts.map((h) => [h.host, h.installed]));
  const found = emptyDetection();
  for (const host of HOSTS) {
    const detected =
      findHostExecutable(host, { home, env }) !== null || installedHostApp(host, home, env);
    found[host] = {
      detected,
      configured:
        host === "codex"
          ? isCodexWorkitInstalled(home, env) || (configuredByHost.get(host) ?? false)
          : host === "pi"
            ? isPiWorkitInstalled(home, env) || (configuredByHost.get(host) ?? false)
            : (configuredByHost.get(host) ?? false),
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
