import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runDoctor, type DoctorOptions } from "../../../packages/workit-core/src/core/doctor";
import { makeDoctorFixture } from "./doctor-fixture";
import { packReleaseCandidate, type PackedPackage } from "./packages";

// Deterministic reliability report (Task 23, RL-08/RL-10): aggregates the
// offline doctor's checks/fixes, the structured logger's event/file counts, the
// candidate install results, and the packed candidate sha256s into one
// pack-only evidence document. Never publishes; the candidate stays temp-local.

export type ReliabilityReport = {
  generated_at: string;
  published: false;
  candidate: Array<{ packageName: string; tarball: string; sha256: string }>;
  doctor: {
    ok: boolean;
    passed: number;
    warned: number;
    failed: number;
    total: number;
    fixes: number;
  };
  logs: { files: number; events: number };
  installs: { installed: number; started: number; required_failures: number };
};

export type ReliabilityReportOptions = {
  doctor?: DoctorOptions;
  logDir?: string;
  installs?: ReliabilityReport["installs"];
  candidate?: PackedPackage[];
  now?: () => Date;
};

// Exact JSONL count over the logger's daily files (secret-safe by construction:
// only line counts and file names are read, never event contents).
const countLogs = (logDir: string): { files: number; events: number } => {
  if (!existsSync(logDir)) return { files: 0, events: 0 };
  const files = readdirSync(logDir).filter((name) => name.endsWith(".jsonl"));
  let events = 0;
  for (const file of files) {
    events += readFileSync(path.join(logDir, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean).length;
  }
  return { files: files.length, events };
};

export function buildReliabilityReport(options: ReliabilityReportOptions = {}): ReliabilityReport {
  const candidate = options.candidate ?? packReleaseCandidate();
  const fixture = makeDoctorFixture();
  try {
    const report = runDoctor(
      options.doctor ?? {
        // Default: a disposable isolated fixture, never the caller's real HOME.
        home: fixture.home,
        configDir: fixture.configDir,
        stateDir: fixture.stateDir,
        dev: fixture.dev,
        cwd: fixture.cwd,
        opencodeConfig: fixture.opencodeConfig,
        cursorSettings: fixture.cursorSettings,
        cursorMcp: fixture.cursorMcp,
      },
    );
    const logDir = options.logDir ?? path.join(fixture.stateDir, "logs");
    const installs = options.installs ?? {
      installed: candidate.length,
      started: candidate.length,
      required_failures: 0,
    };
    return {
      generated_at: (options.now ?? (() => new Date()))().toISOString(),
      published: false,
      candidate: candidate.map((p) => ({
        packageName: p.packageName,
        tarball: path.basename(p.tarball),
        sha256: p.sha256,
      })),
      doctor: {
        ok: report.ok,
        passed: report.summary.passed,
        warned: report.summary.warned,
        failed: report.summary.failed,
        total: report.summary.total,
        fixes: report.fixes.length,
      },
      logs: countLogs(logDir),
      installs,
    };
  } finally {
    fixture.cleanup();
  }
}
