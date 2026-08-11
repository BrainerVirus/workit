import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
  runInIsolation,
} from "../shared/helpers/packages";

// Task 14 packed gate: the CLI setup flow runs against EXTRACTED tarballs with
// the repository node_modules unavailable. buildSetupPreview/applySetupPreview
// are imported from the extracted @brainervirus/workit-core package and resolve
// the adapter packages as node_modules siblings; the CLI binary is exercised as
// a subprocess for the non-interactive surface (help, non-TTY guidance, doctor).

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

const PREVIEW_VALUES = {
  platforms: ["opencode", "cursor"],
  locale: "en",
  timezone: "UTC",
  branchPreset: "gitflow",
  branchAllowed: "feature/*",
  branchProtected: "main",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: true,
} as const;

type PackedPreview = {
  ok: boolean;
  blocked: string[];
  platforms: string[];
};
type PackedResult = {
  ok: boolean;
  exitCode: number;
  entries: { platform: string; file: string; status: string; detail?: string }[];
  doctor: {
    host: string;
    exitCode: number;
    checks: { id: string; status: string; detail: string }[];
  }[];
};
type PackedSetup = {
  buildSetupPreview: (
    values: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => PackedPreview;
  applySetupPreview: (preview: PackedPreview, opts: Record<string, unknown>) => PackedResult;
};

async function loadSetup(nm: string): Promise<PackedSetup> {
  return (await import(
    pathToFileURL(path.join(nm, CORE, "src/core/setup.ts")).href
  )) as PackedSetup;
}

test("packed CLI setup flow configures OpenCode + Cursor and doctor verifies it", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CORE));
    installPackedPackage(nm, byName(packs, OPENCODE));
    installPackedPackage(nm, byName(packs, CURSOR));
    installPackedPackage(nm, byName(packs, CLI));
    const setup = await loadSetup(nm);

    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    const project = path.join(install, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });

    const preview = setup.buildSetupPreview(PREVIEW_VALUES, { dir: configDir, cwd: project, env });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const result = setup.applySetupPreview(preview, { home, configDir, cwd: project, env });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.entries.some((e) => e.status === "Failed")).toBe(false);

    // OpenCode: package-native file:// pin to the extracted adapter's dist entry
    const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
    const oc = JSON.parse(readFileSync(opencodeCfg, "utf8"));
    expect(oc.plugin).toContain(`file://${path.join(nm, OPENCODE, "dist", "plugin.js")}`);

    // Cursor: settings + mcp + the plugin package copied package-locally
    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workflow-toolkit");
    const cursorSettings = path.join(home, ".cursor", "settings.json");
    const settings = JSON.parse(readFileSync(cursorSettings, "utf8"));
    expect(settings.enabled_plugins?.["workflow-toolkit"]).toBe(true);
    expect(settings.plugin_dirs).toContain(pluginDir);
    for (const rel of ["package.json", "mcp/run-server.sh", "dist/mcp-server.js"]) {
      expect(existsSync(path.join(pluginDir, rel)), `${pluginDir}/${rel}`).toBe(true);
    }
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    const mcp = JSON.parse(readFileSync(cursorMcp, "utf8"));
    expect(mcp.mcpServers?.workit?.command).toBe("node");

    // packaged hygiene applied from the extracted package's own templates
    expect(readFileSync(path.join(project, "CHANGELOG.md"), "utf8")).toContain("# Changelog");
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toContain("docs/*/sdd/");

    // doctor verified both registrations offline
    expect(result.doctor.length).toBe(2);
    for (const report of result.doctor) {
      expect(report.exitCode, `${report.host}: ${JSON.stringify(report.checks)}`).toBe(0);
    }

    // idempotent re-apply: every config file Skipped, bytes untouched
    const files = [
      path.join(configDir, "config.json"),
      opencodeCfg,
      cursorSettings,
      cursorMcp,
      path.join(project, ".gitignore"),
      path.join(project, "CHANGELOG.md"),
    ];
    const before: Record<string, string> = Object.fromEntries(
      files.map((f) => [f, readFileSync(f, "utf8")]),
    );
    const again = setup.applySetupPreview(preview, { home, configDir, cwd: project, env });
    expect(again.ok, JSON.stringify(again.entries)).toBe(true);
    for (const file of files) {
      const entry = again.entries.find((e) => e.file === file);
      expect(entry?.status).toBe("Skipped");
      expect(readFileSync(file, "utf8")).toBe(before[file]);
    }
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI partial failure exits nonzero with a Failed entry", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-partial-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CORE));
    installPackedPackage(nm, byName(packs, OPENCODE)); // cursor deliberately absent
    installPackedPackage(nm, byName(packs, CLI));
    const setup = await loadSetup(nm);

    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    mkdirSync(configDir, { recursive: true });
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });

    const preview = setup.buildSetupPreview(PREVIEW_VALUES, {
      dir: configDir,
      cwd: install,
      env,
    });
    const result = setup.applySetupPreview(preview, { home, configDir, cwd: install, env });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.entries.some((e) => e.platform === "cursor" && e.status === "Failed")).toBe(true);
    // the healthy platform is still registered and verified
    expect(existsSync(path.join(home, ".config", "opencode", "opencode.json"))).toBe(true);
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI: non-TTY init gives guidance + nonzero; --help exits 0", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-bin-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    const home = path.join(install, "home");
    mkdirSync(home, { recursive: true });
    const env = isolatedEnv(home);
    const entry = path.join(cliDir, "dist", "index.js");

    const help = runInIsolation(install, "node", [entry, "--help"], env);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("workit");

    const init = runInIsolation(install, "node", [entry, "init"], env);
    expect(init.status, init.stdout + init.stderr).toBe(1);
    expect(init.stdout).toContain("interactive terminal");
    expect(init.stdout).toContain("workit doctor");
    expect(init.stdout).toContain("/wk-status");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI ships completion guidance and hygiene templates", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-assets-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    // /wk-status + doctor completion guidance are compiled into the shipped CLI
    const bundle = readFileSync(path.join(cliDir, "dist", "index.js"), "utf8");
    expect(bundle).toContain("/wk-status");
    expect(bundle).toContain("workit doctor");
    // hygiene templates ship package-locally under the CLI assets
    expect(existsSync(path.join(cliDir, "assets", "templates", "hygiene", "CHANGELOG.md"))).toBe(
      true,
    );
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);
