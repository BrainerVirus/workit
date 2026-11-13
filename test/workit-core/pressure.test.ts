// Issue #326: the pressure gate's source. Linux reads PSI `some avg10`;
// without PSI it samples the load per CPU (macOS too), Windows samples CPU
// busy time, and an unreadable source leaves the gate open.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describePressure,
  describeSource,
  psiSome,
  readPressure,
} from "@/packages/workit-core/src/core/pressure";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const psi = (memory: string, cpu: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-psi-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "memory"), memory);
  writeFileSync(path.join(dir, "cpu"), cpu);
  return dir;
};
const line = (some: number) =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

test("psiSome reads the some avg10 field and nothing else", () => {
  expect(psiSome(line(2.53))).toBe(2.53);
  expect(psiSome("full avg10=9.00 avg60=0 avg300=0 total=0\n")).toBeNull();
});

test("Given PSI under its critical lines, Then the source is psi and the gate is open; over a line, it names that resource", () => {
  const calm = readPressure({ platform: "linux", psiDir: psi(line(0.5), line(12)) });
  expect(calm).toMatchObject({ source: "psi", memory: 0.5, cpu: 12, critical: null });
  expect(describeSource(calm)).toContain("PSI (/proc/pressure: memory some avg10 0.5%");
  const memory = readPressure({ platform: "linux", psiDir: psi(line(10), line(1)) });
  expect(memory.critical).toEqual({ resource: "memory", value: 10, line: 10 });
  const cpu = readPressure({ platform: "linux", psiDir: psi(line(1), line(91.5)) });
  expect(describePressure(cpu)).toBe("CPU pressure: PSI some avg10 91.5% (critical at 80%)");
});

test("Given Linux without PSI, Then the load per CPU is sampled and the note says why", () => {
  const reading = readPressure({
    platform: "linux",
    psiDir: path.join(os.tmpdir(), "wk-no-psi-here"),
    loadavg: () => [3, 2, 1],
    cpus: () => 4,
  });
  expect(reading).toMatchObject({ source: "load", cpu: 0.75, critical: null });
  expect(describeSource(reading)).toMatch(
    /^load sampling \(1-minute load 0\.75 per CPU; critical at 2\), no PSI: .*wk-no-psi-here is unreadable \(ENOENT\)$/u,
  );
});

test("Given macOS, Then load sampling; given Windows, Then CPU sampling between reads", () => {
  expect(
    readPressure({ platform: "darwin", loadavg: () => [16, 1, 1], cpus: () => 8 }).critical,
  ).toEqual({ resource: "cpu", value: 2, line: 2 });
  let idle = 0;
  let total = 0;
  const cpuTimes = () => [{ idle, total }];
  idle = 100;
  total = 1000;
  readPressure({ platform: "win32", cpuTimes });
  idle = 101;
  total = 1100;
  const busy = readPressure({ platform: "win32", cpuTimes });
  expect(busy).toMatchObject({ source: "cpu-sample", cpu: 99, memory: null });
  expect(busy.critical?.resource).toBe("cpu");
});

test("Given no readable source, Then the gate is open and says so", () => {
  const reading = readPressure({
    platform: "linux",
    psiDir: path.join(os.tmpdir(), "wk-no-psi-here"),
    loadavg: () => {
      throw new Error("no load");
    },
  });
  expect(reading).toMatchObject({ source: "none", critical: null });
  expect(describeSource(reading)).toContain("open: no pressure source is readable");
  expect(describeSource(reading)).toContain("the load average is unreadable");
  expect(
    readPressure({
      platform: "win32",
      cpuTimes: () => {
        throw new Error("no times");
      },
    }),
  ).toMatchObject({ source: "none", note: "CPU times are unreadable" });
});
