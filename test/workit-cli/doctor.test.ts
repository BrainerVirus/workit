import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorReport } from "../../packages/workit-core/src/core/doctor";
import { makeDoctorFixture } from "../shared/helpers/doctor-fixture";

// `workit doctor` and `workit doctor --json` (DG-07): JSON parses, the report's
// exitCode is reflected in the process exit status, broken fixtures fail, and no
// network is involved (the command completes offline).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = path.join(repoRoot, "packages/workit-cli/src/index.tsx");

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());

const runCli = (args: string[], cwd: string) =>
  spawnSync("bun", [cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: fixture.home,
      WORKFLOW_TOOLKIT_CONFIG: fixture.configDir,
      WORKFLOW_TOOLKIT_STATE: fixture.stateDir,
      WORKFLOW_TOOLKIT_DEV: fixture.dev,
    },
    encoding: "utf8",
  });

test("workit doctor --json prints a parseable report and exits with its exitCode", () => {
  const ok = runCli(["doctor", "--json"], fixture.cwd);
  expect(ok.status, ok.stderr).toBe(0);
  const report = JSON.parse(ok.stdout) as DoctorReport;
  expect(report.ok).toBe(true);
  expect(report.exitCode).toBe(0);
  expect(report.offline).toBe(true);
  expect(Array.isArray(report.checks)).toBe(true);
});

test("workit doctor --json reflects a broken fixture in the exit status", () => {
  mkdirSync(path.dirname(fixture.opencodeConfig), { recursive: true });
  writeFileSync(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["workit-opencode@git+file:///nonexistent/stale"] }),
  );
  try {
    const bad = runCli(["doctor", "--json"], fixture.cwd);
    expect(bad.status, bad.stderr).toBe(1);
    const report = JSON.parse(bad.stdout) as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.checks.some((c) => c.id === "stale_pin" && c.status === "fail")).toBe(true);
  } finally {
    rmSync(fixture.opencodeConfig, { force: true });
  }
});

test("workit doctor (text) prints per-check lines and no JSON to stdout", () => {
  const text = runCli(["doctor"], fixture.cwd);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("workit doctor");
  expect(() => JSON.parse(text.stdout)).toThrow();
  expect(text.stdout).toMatch(/stale_pin/);
});
