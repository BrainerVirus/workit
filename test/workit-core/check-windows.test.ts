import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCheckConfig, matchesNamedCheck } from "@/packages/workit-core/src/check-config";
import { runCheckCommand } from "@/packages/workit-core/src/checks";

// Windows-only behavior of `workit check` runs (S9b review H1, M1). This file
// lives under test/workit-core so the Windows CI job runs it.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32")(
  "a configured .cmd shim resolves through PATH/PATHEXT and gets its arguments intact",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wk-cmd-"));
    dirs.push(root);
    writeFileSync(path.join(root, "fakecheck.cmd"), "@echo off\r\necho args:%*\r\nexit /b 3\r\n");
    const argv = ["fakecheck", "a b", "x&y", 'q"q'];
    writeFileSync(
      path.join(root, "workit.checks.json"),
      JSON.stringify({ checks: { test: argv } }),
    );
    // The argv is the configured one; only the spawn changes.
    expect(matchesNamedCheck(loadCheckConfig(root), "test", argv, ".")).toBe(true);
    const run = await runCheckCommand(argv, {
      cwd: root,
      env: { ...process.env, PATH: `${root};${process.env.PATH ?? ""}` },
    });
    expect(run.spawnError).toBeNull();
    expect(run.exitCode).toBe(3);
    expect(run.log).toContain('args:"a b" "x&y" "q\\"q"');
  },
);

test.skipIf(process.platform !== "win32")(
  "--timeout kills the whole process tree on Windows",
  async () => {
    const started = Date.now();
    const run = await runCheckCommand(["cmd", "/d", "/c", "ping -n 30 127.0.0.1 >nul"], {
      cwd: os.tmpdir(),
      timeoutMs: 500,
    });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);
