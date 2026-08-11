import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../packages/workit-core/src/core/logger";
import { binDirWithRuntimes, makeDoctorFixture } from "../shared/helpers/doctor-fixture";
import { packReleaseCandidate } from "../shared/helpers/packages";
import { buildReliabilityReport } from "../shared/helpers/report";

// Task 23 reliability-report gate: buildReliabilityReport() aggregates the
// doctor checks/fixes, logger event/file counts, install results, and the
// candidate checksums into one deterministic, pack-only evidence document.

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

test("default report aggregates the deterministic candidate and an isolated doctor", () => {
  const report = buildReliabilityReport({ now: () => new Date(0) });
  expect(report.published).toBe(false);
  expect(report.generated_at).toBe("1970-01-01T00:00:00.000Z");
  expect(report.candidate.map((c) => c.packageName)).toEqual([CORE, OPENCODE, CURSOR, CLI]);
  for (const c of report.candidate) {
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  const packs = packReleaseCandidate();
  expect(report.candidate.map((c) => c.sha256)).toEqual(packs.map((p) => p.sha256));
  expect(report.doctor.total).toBe(11);
  expect(report.logs).toEqual({ files: 0, events: 0 });
  expect(report.installs).toEqual({ installed: 4, started: 4, required_failures: 0 });
});

test("report doctor counts are exact against a controlled isolated fixture", () => {
  const fixture = makeDoctorFixture();
  const bin = binDirWithRuntimes(fixture.root);
  try {
    const report = buildReliabilityReport({
      now: () => new Date(0),
      doctor: {
        home: fixture.home,
        configDir: fixture.configDir,
        stateDir: fixture.stateDir,
        dev: fixture.dev,
        cwd: fixture.cwd,
        opencodeConfig: fixture.opencodeConfig,
        cursorSettings: fixture.cursorSettings,
        cursorMcp: fixture.cursorMcp,
        env: { ...process.env, PATH: bin },
      },
    });
    // node+bun on PATH but no git: exactly the utility check fails.
    expect(report.doctor).toEqual({
      ok: false,
      passed: 10,
      warned: 0,
      failed: 1,
      total: 11,
      fixes: 1,
    });
  } finally {
    fixture.cleanup();
  }
});

test("report log counts reflect real logger writes", () => {
  const root = tmp("wk-report-log-");
  const stateDir = path.join(root, "state");
  const logDir = path.join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  try {
    const log = createLogger({ stateDir });
    log.info("alpha");
    log.warn("beta", { k: 1 });
    const report = buildReliabilityReport({ now: () => new Date(0), logDir });
    expect(report.logs).toEqual({ files: 1, events: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report install counts are exact and not hardcoded", () => {
  const defaulted = buildReliabilityReport({ now: () => new Date(0) });
  expect(defaulted.installs).toEqual({ installed: 4, started: 4, required_failures: 0 });

  const overridden = buildReliabilityReport({
    now: () => new Date(0),
    installs: { installed: 3, started: 2, required_failures: 1 },
  });
  expect(overridden.installs).toEqual({ installed: 3, started: 2, required_failures: 1 });
});
