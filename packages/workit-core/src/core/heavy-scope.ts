// The systemd user scope a heavy check runs in (issue #282), and the probe
// `workit doctor` uses to say whether its limits really apply (#325). Node
// built-ins only, so the doctor and the install-time doctor load it without
// the check runner or the hook graph.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export type ScopeSupport = { ok: true } | { ok: false; reason: string };

const onPath = (command: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

/**
 * Can heavy checks run in their own `systemd-run --user --scope`? Needs Linux,
 * `systemd-run` on PATH, a running user manager, and the memory and cpu
 * controllers delegated to it (cgroup v2).
 */
export function scopeSupport(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  read: (file: string) => string | null = readText,
): ScopeSupport {
  if (platform !== "linux") return { ok: false, reason: `no systemd scopes on ${platform}` };
  if (!onPath("systemd-run", env)) return { ok: false, reason: "systemd-run is not on PATH" };
  const uid = process.getuid?.() ?? 0;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!fs.existsSync(path.join(runtime, "systemd", "private")))
    return { ok: false, reason: "no user systemd manager is running" };
  const controllers = read(
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
  );
  if (controllers === null)
    return { ok: false, reason: "cgroup v2 is not mounted for the user manager" };
  const missing = ["memory", "cpu"].filter((name) => !controllers.split(/\s+/u).includes(name));
  if (missing.length)
    return { ok: false, reason: `the user manager is not delegated ${missing.join(" and ")}` };
  return { ok: true };
}

/** The `systemd-run` prefix that runs a command in its own limited scope. */
export function scopePrefix(unit: string, settings: { memoryMax: string; cpuQuota: string }) {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    "-p",
    `MemoryMax=${settings.memoryMax}`,
    "-p",
    `CPUQuota=${settings.cpuQuota}`,
    "--",
  ];
}

export type ScopeProbe =
  | { effective: true; memoryMax: string; cpuMax: string; delegate: string | null }
  | { effective: false; supported: boolean; reason: string; delegate: string | null };

const PROBE_MEMORY = "268435456";
const PROBE_CPU = "50%";
const PROBE_SCRIPT =
  'cg=$(sed -n "s/^0:://p" /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/cpu.max"';

/** `Delegate=` and `DelegateControllers=` of the user manager's unit, as systemd reports them. */
function userManagerDelegate(env: NodeJS.ProcessEnv): string | null {
  const uid = process.getuid?.() ?? 0;
  const shown = spawnSync(
    "systemctl",
    ["show", `user@${uid}.service`, "-p", "Delegate", "-p", "DelegateControllers"],
    { env, encoding: "utf8", timeout: 5000 },
  );
  const text = shown.status === 0 ? shown.stdout.trim().split(/\n/u).join(", ") : "";
  return text || null;
}

/**
 * Do heavy-check scopes really get their limits here? Starts a throwaway
 * scope the way a heavy check does (MemoryMax 256 MiB, CPUQuota 50%) and
 * reads the limits back from its own cgroup, so a manager that accepts the
 * properties but cannot apply them (no delegation) is told apart.
 */
export function probeScope(env: NodeJS.ProcessEnv = process.env): ScopeProbe {
  const support = scopeSupport(env);
  const delegate = process.platform === "linux" ? userManagerDelegate(env) : null;
  if (!support.ok) return { effective: false, supported: false, reason: support.reason, delegate };
  const unit = `workit-probe-${process.pid}-${Date.now().toString(36)}`;
  // The same `systemd-run …` prefix a heavy check runs under.
  const [runner, ...prefix] = scopePrefix(unit, { memoryMax: PROBE_MEMORY, cpuQuota: PROBE_CPU });
  const probe = spawnSync(runner, [...prefix, "sh", "-c", PROBE_SCRIPT], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0)
    return {
      effective: false,
      supported: true,
      reason: `systemd-run failed: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().split("\n")[0]}`,
      delegate,
    };
  const [memoryMax = "", cpuMax = ""] = probe.stdout.trim().split(/\n/u);
  if (memoryMax.trim() === PROBE_MEMORY && cpuMax.trim().startsWith("50000 "))
    return { effective: true, memoryMax: memoryMax.trim(), cpuMax: cpuMax.trim(), delegate };
  return {
    effective: false,
    supported: true,
    reason: `the scope started but its cgroup reads memory.max=${memoryMax.trim() || "?"} cpu.max=${cpuMax.trim() || "?"} (asked ${PROBE_MEMORY} and 50000 100000)`,
    delegate,
  };
}
