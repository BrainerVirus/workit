import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installedHostApp,
  isCodexWorkitInstalled,
  isPiWorkitInstalled,
  planHostInstall,
  resolveWindowsShimEntry,
  runHostCommand,
  runHostInstall,
} from "@/packages/workit-core/src/core/host-install";

const temp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const executable = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/usr/bin/env node\n", { mode: 0o755 });
};

test("Codex setup uses the registered marketplace and stops duplicate registration", () => {
  const home = temp("workit-codex-install-home-");
  const bin = temp("workit-codex-install-bin-");
  try {
    executable(path.join(bin, "node"));
    executable(path.join(bin, "codex"));
    const commands = planHostInstall("codex", { home, cwd: home, env: { HOME: home, PATH: bin } });
    expect(commands.slice(1).map((command) => command.args.slice(-3))).toEqual([
      ["plugin", "marketplace", "list"],
      ["marketplace", "add", "https://github.com/BrainerVirus/workit.git"],
      ["plugin", "add", "workit@workflow-toolkit"],
    ]);
    const ran: string[] = [];
    const result = runHostInstall(commands, (command) => {
      ran.push(command.purpose);
      return {
        exitCode: 0,
        stdout: command.purpose.includes("already registered") ? "workflow-toolkit" : "",
        stderr: "",
      };
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual([
      "Check the Node.js 24+ package runtime requirement",
      "Check whether the Workit marketplace is already registered",
      "Install the Workit Codex plugin",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Pi install preserves an existing canonical package pin, not similarly named packages", () => {
  const home = temp("workit-pi-install-home-");
  const bin = temp("workit-pi-install-bin-");
  const settings = path.join(home, ".pi", "agent", "settings.json");
  try {
    executable(path.join(bin, "node"));
    executable(path.join(bin, "pi"));
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ packages: ["npm:@brainervirus/workit-pi-extra@2.0.2"] }),
    );
    const options = { home, cwd: home, env: { HOME: home, PATH: bin } };
    expect(planHostInstall("pi", options).some((command) => command.args.includes("install"))).toBe(
      true,
    );
    writeFileSync(settings, JSON.stringify({ packages: ["npm:@brainervirus/workit-pi@2.0.1"] }));
    expect(planHostInstall("pi", options)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("OpenCode keeps native setup but refuses an unqualified scoped upgrade", () => {
  expect(planHostInstall("opencode")).toEqual([]);
  expect(() => planHostInstall("opencode", { mode: "upgrade" })).toThrow(
    /cannot target the Workit server plugin for a scoped update.*registration was preserved/,
  );
});

test("host install stops after a failed native command", () => {
  const result = runHostInstall(
    [
      { command: "codex", args: ["plugin", "marketplace", "add"], purpose: "marketplace" },
      { command: "codex", args: ["plugin", "add"], purpose: "plugin" },
    ],
    (command) => ({
      exitCode: command.purpose === "marketplace" ? 1 : 0,
      stdout: "",
      stderr: "offline",
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.results).toHaveLength(1);
});

test("desktop detection checks installed app paths without treating config directories as hosts", () => {
  const seen: string[] = [];
  const mac = installedHostApp("codex", "/Users/example", {}, "darwin", (candidate) => {
    seen.push(candidate);
    return candidate === "/Applications/Codex.app";
  });
  expect(mac).toBe(true);
  expect(seen).toContain("/Applications/Codex.app");

  const windows = installedHostApp(
    "cursor",
    "C:\\Users\\example",
    {
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
    },
    "win32",
    (candidate) => candidate === "C:\\Users\\example\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
  );
  expect(windows).toBe(true);
});

test("Windows npm shims resolve a known JavaScript entrypoint without invoking cmd.exe", () => {
  const shim = "C:\\Users\\example\\AppData\\Roaming\\npm\\pi.cmd";
  const expected =
    "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
  const source = `@echo off\r\n"%~dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n`;
  const entry = resolveWindowsShimEntry(source, shim, (candidate) => candidate === expected);
  expect(entry).toBe(expected);
});

test("native registration verification follows Codex version caches and Pi object sources", () => {
  const home = temp("workit-host-verify-home-");
  const codexHome = path.join(home, ".codex");
  const codexPackage = path.join(
    codexHome,
    "plugins",
    "cache",
    "workflow-toolkit",
    "workit",
    "2.0.2",
  );
  const piSettings = path.join(home, ".pi", "agent", "settings.json");
  try {
    mkdirSync(path.join(codexPackage, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(codexPackage, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "workit", repository: "https://github.com/BrainerVirus/workit" }),
    );
    mkdirSync(path.dirname(piSettings), { recursive: true });
    writeFileSync(
      piSettings,
      JSON.stringify({ packages: [{ source: "npm:@brainervirus/workit-pi@2.0.1" }] }),
    );
    expect(isCodexWorkitInstalled(home, { CODEX_HOME: codexHome })).toBe(true);
    expect(isPiWorkitInstalled(home, { PI_CODING_AGENT_DIR: path.dirname(piSettings) })).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native command context routes HOME and host data directories into the injected home", () => {
  const home = temp("workit-host-run-home-");
  try {
    const result = runHostCommand(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify([process.env.HOME,process.env.CODEX_HOME,process.env.PI_CODING_AGENT_DIR,process.env.XDG_CONFIG_HOME]))",
        ],
        purpose: "test isolated environment",
      },
      { home },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      home,
      path.join(home, ".codex"),
      path.join(home, ".pi", "agent"),
      path.join(home, ".config"),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
