import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HANDOFF_DESTINATION_MARKER } from "../../packages/workit-core/src/core/menu";
import {
  copyHoistedDeps,
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
  readTarballFile,
  runInIsolation,
} from "../shared/helpers/packages";

// Task 14 packed gate: the CLI setup flow runs against EXTRACTED tarballs with
// the repository node_modules unavailable. buildSetupPreview/applySetupPreview
// are imported from the extracted @brainervirus/workit-core package and resolve
// the adapter packages as node_modules siblings; the CLI binary is exercised as
// a subprocess for the non-interactive surface (help, non-TTY guidance, doctor).

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CLI = "@brainervirus/workit-cli";

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

// AR-03: install a packed package plus ONLY the closure its packed manifest
// declares — workspace packages from their packed tarballs, third-party deps
// from the hoisted offline copy. No manual adapter extraction.
function installDeclaredClosure(
  nm: string,
  packs: ReturnType<typeof packWorkspacePackages>,
  root: ReturnType<typeof packWorkspacePackages>[number],
): void {
  const queue = [root];
  const installed = new Set<string>();
  const hoisted = new Set<string>();
  while (queue.length) {
    const pack = queue.shift()!;
    if (installed.has(pack.packageName)) continue;
    installed.add(pack.packageName);
    const meta = JSON.parse(readTarballFile(pack.tarball, "package.json"));
    for (const [name, spec] of Object.entries(meta.dependencies ?? {})) {
      if (name.startsWith("@brainervirus/")) {
        queue.push(byName(packs, name));
      } else {
        hoisted.add(name);
        void spec;
      }
    }
  }
  for (const name of installed) installPackedPackage(nm, byName(packs, name));
  if (hoisted.size > 0) copyHoistedDeps(nm, [...hoisted]);
}

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
  preserved: string[];
  mutations: { type: string; path: string; entries?: { name: string }[] }[];
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
    // only what the packed CLI manifest declares: core + adapters + third-party
    installDeclaredClosure(nm, packs, byName(packs, CLI));
    const setup = await loadSetup(nm);

    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    const project = path.join(install, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });

    // workspace draft added through the extracted preview (WZ-12 apply path)
    const wsEntry = {
      name: "demo",
      glob: path.join(project, "**").split(path.sep).join("/"),
      vcs: { provider: "gitlab" },
    };
    const preview = setup.buildSetupPreview(
      { ...PREVIEW_VALUES, workspaces: [wsEntry] },
      { dir: configDir, cwd: project, env },
    );
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const wsMutation = preview.mutations.find((m) => m.type === "update-workspaces");
    expect(wsMutation).toBeDefined();
    expect(wsMutation!.entries).toEqual([wsEntry]);
    const result = setup.applySetupPreview(preview, { home, configDir, cwd: project, env });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.entries.some((e) => e.status === "Failed")).toBe(false);
    const wsWritten = JSON.parse(readFileSync(path.join(configDir, "workspaces.json"), "utf8"));
    expect(wsWritten.workspaces).toEqual([wsEntry]);

    // OpenCode: package-native file:// pin to the extracted adapter's dist entry
    const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
    const oc = JSON.parse(readFileSync(opencodeCfg, "utf8"));
    expect(oc.plugin).toContain(`file://${path.join(nm, OPENCODE, "dist", "plugin.js")}`);

    // Cursor: settings + mcp + the plugin package copied package-locally
    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
    const cursorSettings = path.join(home, ".cursor", "settings.json");
    const settings = JSON.parse(readFileSync(cursorSettings, "utf8"));
    expect(settings.enabled_plugins?.["workit"]).toBe(true);
    expect(settings.plugin_dirs).toContain(pluginDir);
    for (const rel of ["package.json", "dist/mcp-server.js"]) {
      expect(existsSync(path.join(pluginDir, rel)), `${pluginDir}/${rel}`).toBe(true);
    }
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    const mcp = JSON.parse(readFileSync(cursorMcp, "utf8"));
    expect(mcp.mcpServers?.workit?.command).toBe("npx");
    expect(mcp.mcpServers?.workit?.args).toEqual([
      "-y",
      "--package=@brainervirus/workit-cursor@0.8.0",
      "workit-cursor-mcp",
      "${workspaceFolder}",
    ]);

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
      path.join(configDir, "workspaces.json"),
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

test("packed CLI: identical workspaces emit no update-workspaces mutation", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-ws-parity-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CORE));
    const setup = await loadSetup(nm);

    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    mkdirSync(configDir, { recursive: true });
    const wsEntry = {
      name: "demo",
      glob: "/home/**/demo/**",
      vcs: { provider: "gitlab" },
    };
    writeFileSync(
      path.join(configDir, "workspaces.json"),
      JSON.stringify({ workspaces: [wsEntry] }, null, 2) + "\n",
      "utf8",
    );
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });
    // draft identical to disk: the extracted preview must not claim a rewrite
    const preview = setup.buildSetupPreview(
      { ...PREVIEW_VALUES, workspaces: [wsEntry] },
      { dir: configDir, cwd: install, env },
    );
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.mutations.some((m) => m.type === "update-workspaces")).toBe(false);
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

test("packed CLI: custom credential paths and canary bytes survive preview/apply rerun (CA-39)", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-creds-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installDeclaredClosure(nm, packs, byName(packs, CLI));
    const setup = await loadSetup(nm);

    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(path.join(configDir, "secrets"), { recursive: true });
    const customYt = path.join(configDir, "secrets", "yt.token");
    const customGl = path.join(configDir, "secrets", "gl.token");
    writeFileSync(
      path.join(configDir, "youtrack.json"),
      JSON.stringify({ baseUrl: "https://org.example.com", tokenFile: customYt }),
      "utf8",
    );
    writeFileSync(customYt, "canary-yt-packed\n", { mode: 0o600 });
    writeFileSync(
      path.join(configDir, "vcs.json"),
      JSON.stringify({ provider: "gitlab", gitlab: { tokenFile: customGl }, github: {} }),
      "utf8",
    );
    writeFileSync(customGl, "canary-gl-packed\n", { mode: 0o600 });
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });

    const preview = setup.buildSetupPreview(
      { ...PREVIEW_VALUES, baseUrl: "https://yt.example.com", vcsProvider: "gitlab" },
      { dir: configDir, cwd: install, env },
    );
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    // truthful preview: the host registrations and the adapter copy are listed
    expect(preview.mutations.some((m) => m.type === "register-platform")).toBe(true);
    expect(preview.mutations.some((m) => m.type === "install-adapter")).toBe(true);
    // custom credential files preserved, no default token paths planned
    expect(preview.preserved).toContain(customYt);
    expect(preview.preserved).toContain(customGl);
    for (const def of ["youtrack.token", "gitlab.token"]) {
      expect(preview.mutations.some((m) => m.path === path.join(configDir, def))).toBe(false);
    }

    const result = setup.applySetupPreview(preview, { home, configDir, cwd: install, env });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    // configs still point at the custom paths; bytes intact
    const yt = JSON.parse(readFileSync(path.join(configDir, "youtrack.json"), "utf8")) as {
      tokenFile: string;
    };
    expect(yt.tokenFile).toBe(customYt);
    const vcs = JSON.parse(readFileSync(path.join(configDir, "vcs.json"), "utf8")) as {
      gitlab: { tokenFile: string };
    };
    expect(vcs.gitlab.tokenFile).toBe(customGl);
    expect(readFileSync(customYt, "utf8")).toBe("canary-yt-packed\n");
    expect(readFileSync(customGl, "utf8")).toBe("canary-gl-packed\n");

    // idempotent second run: tokens still Skipped, bytes still intact
    const again = setup.applySetupPreview(preview, { home, configDir, cwd: install, env });
    expect(again.ok, JSON.stringify(again.entries)).toBe(true);
    for (const p of [customYt, customGl]) {
      expect(again.entries.some((e) => e.file === p && e.status === "Skipped")).toBe(true);
      expect(readFileSync(p, "utf8")).toContain("canary");
    }
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
    expect(help.stderr).toBe("");

    const init = runInIsolation(install, "node", [entry, "init"], env);
    expect(init.status, init.stdout + init.stderr).toBe(1);
    expect(init.stdout).toContain("interactive terminal");
    expect(init.stdout).toContain("workit doctor");
    expect(init.stdout).toContain("/wk-status");
    expect(init.stderr).not.toContain('"initialization"');
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI: workit init on malformed config.json blocks gracefully (no crash)", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-malformed-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    const home = path.join(install, "home");
    const configDir = path.join(home, ".config", "workit");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json"), "{ not json", "utf8");
    const env = isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });
    const entry = path.join(cliDir, "dist", "index.js");

    // previously createInitialDraft()'s default readConfig() threw inside the
    // wizard render and died via the unhandledRejection/uncaughtException
    // handler; it must instead surface the graceful Apply-blocked message.
    const init = runInIsolation(install, "node", [entry, "init"], env);
    expect(init.status, init.stdout + init.stderr).toBe(1);
    expect(init.stdout).toContain("Apply blocked — malformed configuration:");
    expect(init.stdout).toContain("config.json");
    expect(init.stderr).not.toContain("unhandledRejection");
    expect(init.stderr).not.toContain("uncaughtException");
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

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const fileSha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Task 6 (CA-19, CA-21): the packed flow/handoff surface. The bundled CLI is
// run as a subprocess against a real extracted-package fixture so resolution,
// confirmation, and core-generated output all survive the packed Node bundle.
test("packed CLI: help lists every flow and handoff command", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-help-");
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
    for (const command of [
      "workit flow status --plan <path>",
      "workit flow pause --plan <path> [--confirm]",
      "workit flow resume --plan <path> [--confirm]",
      "workit flow complete --plan <path> [--confirm]",
      "workit handoff --message <text>",
    ]) {
      expect(help.stdout, command).toContain(command);
    }
    expect(help.stderr).toBe("");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI: non-TTY mutation without --confirm exits 2 with the exact message", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-non-tty-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    const home = path.join(install, "home");
    mkdirSync(home, { recursive: true });
    const env = isolatedEnv(home);
    const entry = path.join(cliDir, "dist", "index.js");

    const run = runInIsolation(
      install,
      "node",
      [entry, "flow", "pause", "--plan", "docs/x/plan.md"],
      env,
    );
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--confirm required when stdin is not a TTY");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI: flow status and handoff work from an extracted package with stdout-only success", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-flow-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    const home = path.join(install, "home");
    mkdirSync(home, { recursive: true });
    const project = path.join(install, "project");
    mkdirSync(project, { recursive: true });
    const env = isolatedEnv(home, { WORKFLOW_WORKSPACE_ROOT: project });
    const entry = path.join(cliDir, "dist", "index.js");

    const slug = "packed-flow";
    mkdirSync(path.join(project, "docs", slug), { recursive: true });
    writeFileSync(path.join(project, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug), "utf8");
    writeFileSync(path.join(project, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug), "utf8");
    const sdd = path.join(project, "docs", slug, "sdd");
    mkdirSync(sdd, { recursive: true });
    writeFileSync(
      path.join(sdd, "flow.json"),
      `${JSON.stringify(
        {
          slug,
          activated: true,
          spec: {
            path: `docs/${slug}/spec.md`,
            status: "approved",
            evidence: null,
            approved_digest: fileSha256(path.join(project, "docs", slug, "spec.md")),
          },
          plan: {
            path: `docs/${slug}/plan.md`,
            status: "approved",
            evidence: null,
            approved_digest: fileSha256(path.join(project, "docs", slug, "plan.md")),
          },
          menu: { presented: true, chosen: "handoff", evidence: null },
          execution: { status: "active", mode: "subagent-driven", evidence: null },
          handoff_destination: false,
          updated_at: Date.now(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const status = runInIsolation(
      install,
      "node",
      [entry, "flow", "status", "--plan", `docs/${slug}/plan.md`],
      env,
    );
    expect(status.status, status.stderr).toBe(0);
    expect(status.stderr).toBe("");
    const statusData = JSON.parse(status.stdout);
    expect(statusData.ok).toBe(true);
    expect(statusData.slug).toBe(slug);
    expect(statusData.spec.path).toBe(`docs/${slug}/spec.md`);
    expect(statusData.plan.path).toBe(`docs/${slug}/plan.md`);
    expect(statusData.menu.chosen).toBe("handoff");
    expect(statusData.drift).toEqual([]);

    const handoff = runInIsolation(
      install,
      "node",
      [entry, "handoff", "--message", `docs/${slug}/plan.md`],
      env,
    );
    expect(handoff.status, handoff.stderr).toBe(0);
    expect(handoff.stderr).toBe("");
    expect(handoff.stdout).toContain(HANDOFF_DESTINATION_MARKER);
    const state = JSON.parse(readFileSync(path.join(sdd, "flow.json"), "utf8")) as {
      handoff_destination: boolean;
    };
    expect(state.handoff_destination).toBe(true);
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("packed CLI: domain and usage diagnostics are stderr with the documented exit codes", () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-packedcli-diag-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    const cliDir = installPackedPackage(nm, byName(packs, CLI));
    const home = path.join(install, "home");
    mkdirSync(home, { recursive: true });
    const entry = path.join(cliDir, "dist", "index.js");

    const usage = runInIsolation(install, "node", [entry, "flow", "status"], isolatedEnv(home));
    expect(usage.status, usage.stdout + usage.stderr).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toContain("--plan");

    const project = path.join(install, "domain-project");
    mkdirSync(project, { recursive: true });
    const env = isolatedEnv(home, { WORKFLOW_WORKSPACE_ROOT: project });
    const domain = runInIsolation(
      install,
      "node",
      [entry, "flow", "status", "--plan", "docs/x/plan.md"],
      env,
    );
    expect(domain.status, domain.stdout + domain.stderr).toBe(1);
    expect(domain.stdout).toBe("");
    expect(domain.stderr).toContain("flow_not_activated");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);
