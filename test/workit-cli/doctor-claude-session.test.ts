import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runDoctor,
  type ClaudeProcess,
  type DoctorReport,
} from "@/packages/workit-cli/src/admin/doctor";

// A running Claude Code process loads its plugins once; `/resume` inside it
// keeps the old hook. The doctor compares each process's start with the
// install time of the installed Workit plugin and names the restart command.

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-session-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const INSTALLED = Date.parse("2026-10-23T12:29:17.304Z");
const SESSION = "5bc71a2b-f2ee-40e8-8ce6-68f9282b1608";

const doctorFor = (
  name: string,
  processes: ClaudeProcess[] | null,
  installed = true,
): DoctorReport => {
  const home = path.join(base, name, "home");
  const cwd = path.join(base, name, "cwd");
  mkdirSync(cwd, { recursive: true });
  if (installed) {
    const installPath = path.join(
      home,
      ".claude",
      "plugins",
      "cache",
      "workit",
      "workit",
      "8.26.1",
    );
    mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "workit", repository: "https://github.com/brainervirus/workit" }),
    );
    writeFileSync(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "workit@workit": [
            {
              scope: "user",
              installPath,
              version: "8.26.1",
              installedAt: "2026-10-06T15:13:43.856Z",
              lastUpdated: new Date(INSTALLED).toISOString(),
            },
          ],
        },
      }),
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of ["WORKFLOW_TOOLKIT_DEV", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
  return runDoctor({
    host: "cli",
    home,
    cwd,
    workspaceRoot: cwd,
    configDir: path.join(home, ".config", "workit"),
    stateDir: path.join(home, ".local", "state", "workit"),
    env,
    claudeProcesses: () => processes,
  });
};
const row = (report: DoctorReport) => report.checks.find((c) => c.id === "claude_session_plugin")!;

test.skipIf(process.platform === "win32")(
  "G a claude process started before the plugin install, W doctor runs, T it warns with pid, session and the restart command",
  () => {
    const result = row(
      doctorFor("stale", [
        { pid: 4242, startedMs: INSTALLED - 3_600_000, args: `claude --resume ${SESSION}` },
        { pid: 4343, startedMs: INSTALLED + 60_000, args: "claude" },
      ]),
    );
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("pid 4242");
    expect(result.detail).not.toContain("pid 4343");
    expect(result.detail).toContain(SESSION);
    expect(result.detail).toContain("Workit 8.26.1");
    expect(result.detail).toContain(`claude --resume ${SESSION}`);
    expect(result.detail).toContain("`/resume` keeps the old plugin");
  },
);

test.skipIf(process.platform === "win32")(
  "G a claude process whose one-second ps start is within 2 s of the install, W doctor runs, T it counts as started after it",
  () => {
    const sameSecond = Math.floor(INSTALLED / 1000) * 1000;
    expect(
      row(doctorFor("same-second", [{ pid: 9, startedMs: sameSecond, args: "claude" }])).status,
    ).toBe("info");
  },
);

test.skipIf(process.platform === "win32")(
  "G every claude process started after the install, or none run, or ps fails, or no plugin, W doctor runs, T the row is info and never fails",
  () => {
    for (const report of [
      doctorFor("fresh", [{ pid: 1, startedMs: INSTALLED + 1, args: "claude" }]),
      doctorFor("none", []),
      doctorFor("no-ps", null),
      doctorFor("no-plugin", [{ pid: 1, startedMs: 0, args: "claude" }], false),
    ])
      expect(row(report).status).toBe("info");
  },
);
