// Host presence detection uses actual CLI executables or supported desktop app
// locations; configuration directories alone never count as installation.
// Existing registrations reuse uninstall planning so the two paths agree.
import os from "node:os";
import { planUninstall, type UninstallPaths } from "./uninstall";
import {
  findHostExecutable,
  installedHostApp,
  isClaudeWorkitInstalled,
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

const HOSTS: HostId[] = ["opencode", "cursor", "codex", "pi", "claude-code"];

/** Hosts the setup wizard configures through their native install paths. */
const WIZARD_HOSTS: HostId[] = [...HOSTS];

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
    "claude-code": { detected: false, configured: false },
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
    // Claude Code ships as the `claude` CLI (the desktop app embeds it).
    const executable = host === "claude-code" ? "claude" : host;
    const detected =
      findHostExecutable(executable, { home, env }) !== null || installedHostApp(host, home, env);
    found[host] = {
      detected,
      configured:
        host === "codex"
          ? isCodexWorkitInstalled(home, env) || (configuredByHost.get(host) ?? false)
          : host === "pi"
            ? isPiWorkitInstalled(home, env) || (configuredByHost.get(host) ?? false)
            : host === "claude-code"
              ? isClaudeWorkitInstalled(home, env)
              : (configuredByHost.get(host) ?? false),
    };
  }
  return found;
}
