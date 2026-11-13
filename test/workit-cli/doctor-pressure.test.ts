// workit doctor `pressure_gate` (issue #326): which source the heavy-check
// pressure gate reads (PSI, load sampling or CPU sampling), or that it is open
// because none is readable.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { readPressure, type PressureReading } from "@/packages/workit-core/src/core/pressure";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-pressure-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });
const noPsi = path.join(scratch, "no-psi");

const pressureRow = (reading: PressureReading): DoctorCheck =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd: scratch,
    configDir: path.join(scratch, "config"),
    stateDir: path.join(scratch, "state"),
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
    scopeProbe: () => ({ effective: false, supported: false, reason: "test", delegate: null }),
    pressureProbe: () => reading,
  }).checks.find((check) => check.id === "pressure_gate")!;

test("Given PSI, When doctor runs, Then pressure_gate passes and names PSI with its lines", () => {
  const psi = path.join(scratch, "psi");
  mkdirSync(psi, { recursive: true });
  writeFileSync(path.join(psi, "memory"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n");
  writeFileSync(path.join(psi, "cpu"), "some avg10=2.53 avg60=0.00 avg300=0.00 total=1\n");
  const row = pressureRow(readPressure({ platform: "linux", psiDir: psi }));
  expect(row.status).toBe("pass");
  expect(row.detail).toContain("pressure gate reads PSI (/proc/pressure");
  expect(row.detail).toContain("critical at 10% memory or 80% CPU");
});

test("Given no PSI (fixture), When doctor runs, Then pressure_gate says load sampling is used and why", () => {
  const row = pressureRow(
    readPressure({ platform: "linux", psiDir: noPsi, loadavg: () => [1, 1, 1], cpus: () => 4 }),
  );
  expect(row.status).toBe("info");
  expect(row.detail).toContain("pressure gate reads load sampling (1-minute load 0.25 per CPU");
  expect(row.detail).toContain("no PSI:");
});

test("Given an unreadable source, When doctor runs, Then pressure_gate says the gate is open", () => {
  const row = pressureRow(
    readPressure({ platform: "linux", psiDir: noPsi, loadavg: () => [Number.NaN] }),
  );
  expect(row.status).toBe("info");
  expect(row.detail).toContain("open: no pressure source is readable");
});

test("Given pressure over its critical line, When doctor runs, Then the row says heavy checks wait now, as information", () => {
  const row = pressureRow(
    readPressure({ platform: "darwin", loadavg: () => [30, 1, 1], cpus: () => 4 }),
  );
  expect(row.status).toBe("info");
  expect(row.detail).toContain("over its critical line now, so heavy checks wait");
});
