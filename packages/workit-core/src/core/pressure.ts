// The pressure gate for heavy checks (#326): over its critical line a heavy
// check waits even with budget free, and a dev server start is refused. Linux
// reads PSI (/proc/pressure/{memory,cpu} `some avg10`); without PSI (an old
// kernel, a container), Linux and macOS sample the 1-minute load per CPU, and
// Windows samples CPU busy time. A source that cannot be read leaves the gate
// open: the gate never blocks on what it cannot see. Only the CLI imports
// this module; hooks never do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** PSI memory `some avg10` (percent of time some task stalled on memory) at or over this is critical. */
export const PSI_MEMORY_CRITICAL = 10;
/** PSI cpu `some avg10` at or over this is critical. */
export const PSI_CPU_CRITICAL = 80;
/** The 1-minute load per CPU at or over this is critical (load sampling). */
export const LOAD_CRITICAL = 2;
/** CPU busy share (percent) at or over this is critical (Windows CPU sampling). */
export const CPU_SAMPLE_CRITICAL = 95;

export type PressureSource = "psi" | "load" | "cpu-sample" | "none";

export type PressureReading = {
  source: PressureSource;
  /** Memory pressure (PSI some avg10), or null where the source has none. */
  memory: number | null;
  /** CPU pressure: PSI some avg10, load per CPU, or busy percent. */
  cpu: number | null;
  /** The resource over its critical line, or null while the gate is open. */
  critical: { resource: "memory" | "cpu"; value: number; line: number } | null;
  /** Why the source fell back or is open (`none`), for doctor. */
  note: string | null;
};

export type PressureDeps = {
  platform?: NodeJS.Platform;
  /** Stands in for /proc/pressure (a test fixture dir). */
  psiDir?: string;
  readFile?: (file: string) => string;
  loadavg?: () => number[];
  cpus?: () => number;
  /** Cumulative CPU times (os.cpus()). */
  cpuTimes?: () => Array<{ idle: number; total: number }>;
};

/** `some avg10=<n>` from a PSI file, or null. */
export function psiSome(text: string): number | null {
  const match = /^some\b.*?\bavg10=(\d+(?:\.\d+)?)/mu.exec(text);
  return match ? Number(match[1]) : null;
}

const realCpuTimes = () =>
  os.cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));

let lastSample: { idle: number; total: number } | null = null;

/** Busy percent since the last sample (since boot on the first). */
function cpuBusy(times: Array<{ idle: number; total: number }>): number | null {
  const now = times.reduce(
    (sum, cpu) => ({ idle: sum.idle + cpu.idle, total: sum.total + cpu.total }),
    { idle: 0, total: 0 },
  );
  const before = lastSample && now.total > lastSample.total ? lastSample : { idle: 0, total: 0 };
  lastSample = now;
  const total = now.total - before.total;
  if (!(total > 0)) return null;
  return Math.round((1 - (now.idle - before.idle) / total) * 1000) / 10;
}

const over = (
  resource: "memory" | "cpu",
  value: number | null,
  line: number,
): PressureReading["critical"] =>
  value !== null && value >= line ? { resource, value, line } : null;

/** Read the gate's source once; never throws. */
export function readPressure(deps: PressureDeps = {}): PressureReading {
  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const cpus = Math.max(1, deps.cpus?.() ?? os.availableParallelism?.() ?? os.cpus().length);
  let note: string | null = null;
  if (platform === "linux") {
    const dir = deps.psiDir ?? "/proc/pressure";
    try {
      const memory = psiSome(read(path.join(dir, "memory")));
      const cpu = psiSome(read(path.join(dir, "cpu")));
      if (memory !== null && cpu !== null)
        return {
          source: "psi",
          memory,
          cpu,
          critical:
            over("memory", memory, PSI_MEMORY_CRITICAL) ?? over("cpu", cpu, PSI_CPU_CRITICAL),
          note: null,
        };
      note = `${dir} has no some avg10 line`;
    } catch (error) {
      note = `${dir} is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`;
    }
  }
  if (platform === "win32") {
    try {
      const busy = cpuBusy((deps.cpuTimes ?? realCpuTimes)());
      if (busy !== null)
        return {
          source: "cpu-sample",
          memory: null,
          cpu: busy,
          critical: over("cpu", busy, CPU_SAMPLE_CRITICAL),
          note,
        };
      note = "no CPU times to sample";
    } catch {
      note = "CPU times are unreadable";
    }
    return { source: "none", memory: null, cpu: null, critical: null, note };
  }
  try {
    const load = (deps.loadavg ?? os.loadavg)()[0];
    if (typeof load === "number" && Number.isFinite(load) && load >= 0) {
      const perCpu = Math.round((load / cpus) * 100) / 100;
      return {
        source: "load",
        memory: null,
        cpu: perCpu,
        critical: over("cpu", perCpu, LOAD_CRITICAL),
        note,
      };
    }
    note = [note, "the load average is unreadable"].filter(Boolean).join("; ");
  } catch {
    note = [note, "the load average is unreadable"].filter(Boolean).join("; ");
  }
  return { source: "none", memory: null, cpu: null, critical: null, note };
}

/** "memory pressure: PSI some avg10 34.5% (critical at 10%)" for a wait or refusal line. */
export function describePressure(reading: PressureReading): string | null {
  const critical = reading.critical;
  if (!critical) return null;
  const what = critical.resource === "memory" ? "memory pressure" : "CPU pressure";
  if (reading.source === "psi")
    return `${what}: PSI some avg10 ${critical.value}% (critical at ${critical.line}%)`;
  if (reading.source === "load")
    return `${what}: 1-minute load ${critical.value} per CPU (critical at ${critical.line})`;
  return `${what}: ${critical.value}% busy (critical at ${critical.line}%)`;
}

/** What the gate reads, for doctor's `pressure_gate` row. */
export function describeSource(reading: PressureReading): string {
  switch (reading.source) {
    case "psi":
      return `PSI (/proc/pressure: memory some avg10 ${reading.memory}%, cpu some avg10 ${reading.cpu}%; critical at ${PSI_MEMORY_CRITICAL}% memory or ${PSI_CPU_CRITICAL}% CPU)`;
    case "load":
      return `load sampling (1-minute load ${reading.cpu} per CPU; critical at ${LOAD_CRITICAL})${reading.note ? `, no PSI: ${reading.note}` : ""}`;
    case "cpu-sample":
      return `CPU sampling (${reading.cpu}% busy; critical at ${CPU_SAMPLE_CRITICAL}%)`;
    default:
      return `open: no pressure source is readable${reading.note ? ` (${reading.note})` : ""}, so heavy checks never wait on pressure`;
  }
}
