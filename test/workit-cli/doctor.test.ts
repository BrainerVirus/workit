import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { localLockHost } from "@/packages/workit-core/src/core/store-lock";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorReport } from "@/packages/workit-core/src/core/doctor";
import { makeDoctorFixture } from "@/test/shared/helpers/doctor-fixture";

// `workit doctor` and `workit doctor --json` (DG-07): JSON parses, the report's
// exitCode is reflected in the process exit status, broken fixtures fail, and no
// network is involved (the command completes offline).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = path.join(repoRoot, "packages/workit-cli/src/main.ts");

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());

const runCli = (args: string[], cwd: string, extraEnv: Record<string, string> = {}) =>
  spawnSync("bun", [cliEntry, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
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

const deadPid = (): number =>
  Number(
    spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout,
  );

test("Given a stale lock left by a dead pid, When workit doctor runs, Then it warns and names --fix-lock", () => {
  const lockPath = path.join(fixture.cwd, ".workit", "metadata.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), processStart: "1", host: localLockHost(), nonce: "n" }),
  );
  try {
    const result = runCli(["doctor", "--json"], fixture.cwd);
    const report = JSON.parse(result.stdout) as DoctorReport;
    const check = report.checks.find((c) => c.id === "workspace_lock");
    expect(check).toMatchObject({ status: "warn", fix: "workit doctor --fix-lock" });
    expect(check?.detail).toContain("is not running");
    expect(existsSync(lockPath)).toBe(true);
  } finally {
    rmSync(path.join(fixture.cwd, ".workit"), { recursive: true, force: true });
  }
});

test("Given a stale lock and an abandoned reclaim guard, When workit doctor --fix-lock runs, Then both are cleared", () => {
  const lockPath = path.join(fixture.cwd, ".workit", "metadata.lock");
  mkdirSync(`${lockPath}.reclaim`, { recursive: true });
  utimesSync(`${lockPath}.reclaim`, new Date(0), new Date(0));
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), processStart: "1", host: localLockHost(), nonce: "n" }),
  );
  try {
    const result = runCli(["doctor", "--fix-lock"], fixture.cwd);
    expect(result.stdout).toContain("fix-lock: cleared stale lock");
    expect(result.stdout).toContain("removed abandoned reclaim guard");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(result.stdout).toMatch(/ok {3}workspace_lock — no metadata lock held/);
  } finally {
    rmSync(path.join(fixture.cwd, ".workit"), { recursive: true, force: true });
  }
});

test("Given a lock held by a live process, When workit doctor --fix-lock runs, Then the lock is kept", () => {
  const lockPath = path.join(fixture.cwd, ".workit", "metadata.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const bytes = JSON.stringify({
    pid: process.pid,
    processStart: null,
    host: localLockHost(),
    nonce: "live",
  });
  writeFileSync(lockPath, bytes);
  try {
    const result = runCli(["doctor", "--json", "--fix-lock"], fixture.cwd);
    const report = JSON.parse(result.stdout) as DoctorReport & { fixLock: { cleared: boolean } };
    expect(report.fixLock.cleared).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(bytes);
  } finally {
    rmSync(path.join(fixture.cwd, ".workit"), { recursive: true, force: true });
  }
});

test("Given WORKFLOW_WORKSPACE_ROOT points at another checkout, When workit doctor --fix-lock runs, Then it clears that checkout's stale lock", () => {
  const other = path.join(fixture.root, "other-workspace");
  const lockPath = path.join(other, ".workit", "metadata.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), processStart: "1", host: localLockHost(), nonce: "n" }),
  );
  try {
    const result = runCli(["doctor", "--fix-lock"], fixture.cwd, {
      WORKFLOW_WORKSPACE_ROOT: other,
    });
    expect(result.stdout).toContain(`cleared stale lock ${lockPath}`);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("Given a lock whose owner cannot be verified, When workit doctor --fix-lock --force runs without --yes or a TTY, Then it refuses and keeps the lock; with --yes it clears it", () => {
  const lockPath = path.join(fixture.cwd, ".workit", "metadata.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const bytes = JSON.stringify({ pid: 1, processStart: null, host: "elsewhere", nonce: "n" });
  writeFileSync(lockPath, bytes);
  try {
    const refused = runCli(["doctor", "--fix-lock", "--force"], fixture.cwd);
    expect(refused.status).toBe(3);
    expect(refused.stdout).toContain("held by pid 1 on elsewhere");
    expect(refused.stdout).toContain("refusing without --yes");
    expect(readFileSync(lockPath, "utf8")).toBe(bytes);
    const forced = runCli(["doctor", "--fix-lock", "--force", "--yes"], fixture.cwd);
    expect(forced.stdout).toContain("fix-lock: cleared lock");
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(path.join(fixture.cwd, ".workit"), { recursive: true, force: true });
  }
});

test("Given an unverifiable lock that has blocked writes for over 30s, When workit doctor runs, Then it warns with the exact force command; a fresh one passes", () => {
  const lockPath = path.join(fixture.cwd, ".workit", "metadata.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 1, processStart: null, host: "elsewhere", nonce: "n" }),
  );
  try {
    const fresh = JSON.parse(runCli(["doctor", "--json"], fixture.cwd).stdout) as DoctorReport;
    expect(fresh.checks.find((c) => c.id === "workspace_lock")?.status).toBe("pass");
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, minuteAgo, minuteAgo);
    const blocked = JSON.parse(runCli(["doctor", "--json"], fixture.cwd).stdout) as DoctorReport;
    expect(blocked.checks.find((c) => c.id === "workspace_lock")).toMatchObject({
      status: "warn",
      fix: "workit doctor --fix-lock --force --yes",
    });
  } finally {
    rmSync(path.join(fixture.cwd, ".workit"), { recursive: true, force: true });
  }
});
