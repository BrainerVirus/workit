// workit doctor `heavy_scope` (issue #325): whether the per-run systemd scope
// really applies MemoryMax and CPUQuota, from a probe that reads the scope's
// own cgroup, not from what the unit file says.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { probeScope, type ScopeProbe } from "@/packages/workit-core/src/core/heavy-scope";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-scope-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

const scopeRow = (probe: ScopeProbe): DoctorCheck =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd: scratch,
    configDir: path.join(scratch, "config"),
    stateDir: path.join(scratch, "state"),
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
    scopeProbe: () => probe,
  }).checks.find((check) => check.id === "heavy_scope")!;

test("Given a probe scope whose cgroup reads the asked limits, When doctor runs, Then heavy_scope passes and shows them", () => {
  const row = scopeRow({
    effective: true,
    memoryMax: "268435456",
    cpuMax: "50000 100000",
    delegate: "Delegate=yes, DelegateControllers=cpu memory pids",
  });
  expect(row.status).toBe("pass");
  expect(row.detail).toContain("memory.max=268435456");
  expect(row.detail).toContain("Delegate=yes");
});

test("Given a scope that starts but does not get its limits, When doctor runs, Then heavy_scope warns with the delegation fix", () => {
  const row = scopeRow({
    effective: false,
    supported: true,
    reason: "the scope started but its cgroup reads memory.max=max cpu.max=max",
    delegate: "Delegate=no",
  });
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("memory.max=max");
  expect(row.fix).toContain("Delegate=cpu memory pids");
});

test("Given no systemd scopes on this machine, When doctor runs, Then heavy_scope is information, not a failure", () => {
  const row = scopeRow({
    effective: false,
    supported: false,
    reason: "systemd-run is not on PATH",
    delegate: null,
  });
  expect(row.status).toBe("info");
  expect(row.detail).toContain("without a memory/CPU scope: systemd-run is not on PATH");
});

test("Given no systemd-run on PATH, When the real probe runs, Then it reports unsupported without starting anything", () => {
  expect(probeScope({ HOME: scratch, PATH: emptyBin })).toMatchObject({
    effective: false,
    supported: false,
  });
});
