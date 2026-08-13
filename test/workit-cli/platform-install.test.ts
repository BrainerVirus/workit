import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySetupPreview,
  buildSetupPreview,
  TOKEN_PLACEHOLDER,
  type SetupPreviewInput,
  type SetupResult,
} from "../../packages/workit-core/src/core/setup";
import { isolatedEnv } from "../shared/helpers/packages";

// Task 14 apply/verify (WZ-09, WZ-10, WZ-13-WZ-15; CA-08, CA-13, CA-14, CA-31):
// applySetupPreview applies ONLY the reviewed mutations with package-native
// registration/assets, reports every platform/file independently, preserves
// unrelated user config byte-for-byte, never clobbers credentials, and verifies
// the result with the shared offline doctor. Partial platform failures propagate
// to a nonzero exitCode.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const tempDir = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

const values = (over: Partial<SetupPreviewInput> = {}): SetupPreviewInput => ({
  platforms: ["opencode"],
  locale: "en",
  timezone: "UTC",
  branchPreset: "gitflow",
  branchAllowed: "feature/*, bugfix/*",
  branchProtected: "main, develop",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: false,
  ...over,
});

const envFor = (home: string, configDir: string) =>
  isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: configDir });

const wsEntry = (name: string, glob: string) => ({
  name,
  glob,
  vcs: { provider: "gitlab" as const, defaultTargetBranch: "main" },
});

const opts = (
  home: string,
  configDir: string,
  over: { dev?: string; cwd?: string; env?: Record<string, string> } = {},
) => ({
  home,
  configDir,
  dev: over.dev ?? repoRoot,
  cwd: over.cwd ?? configDir,
  env: over.env ?? envFor(home, configDir),
});

const apply = (dir: string, home: string, over: Partial<SetupPreviewInput> = {}): SetupResult =>
  applySetupPreview(
    buildSetupPreview(values(over), { dir, cwd: dir, env: {}, home }),
    opts(home, dir),
  );

const statusOf = (result: SetupResult, file: string): string | undefined =>
  result.entries.find((e) => e.file === file)?.status;

const suffixStatus = (result: SetupResult, suffix: string): string[] =>
  result.entries.filter((e) => e.file.endsWith(suffix)).map((e) => e.status);

test("selected OpenCode applies, registers package-native assets, doctor verifies (WZ-13/CA-31)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    const result = apply(dir, home, { platforms: ["opencode"] });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.entries.some((e) => e.status === "Failed")).toBe(false);
    expect(statusOf(result, path.join(dir, "config.json"))).toBe("Installed");

    const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
    expect(statusOf(result, opencodeCfg)).toBe("Installed");
    const cfg = JSON.parse(readFileSync(opencodeCfg, "utf8"));
    expect(cfg.plugin).toContain(`file://${repoRoot}/packages/workit-opencode/src/plugin.ts`);

    // doctor verified the just-written registration (offline, installer-scoped)
    expect(result.doctor.length).toBe(1);
    for (const report of result.doctor) {
      expect(report.exitCode, `${report.host}: ${JSON.stringify(report.checks)}`).toBe(0);
    }
  } finally {
    clean(home);
    clean(dir);
  }
});

test("selected OpenCode + Cursor configure idempotently; second apply changes nothing (WZ-14)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    const first = apply(dir, home, { platforms: ["opencode", "cursor"] });
    expect(first.ok, JSON.stringify(first.entries)).toBe(true);
    expect(first.exitCode).toBe(0);

    const files = [
      path.join(dir, "config.json"),
      path.join(home, ".config", "opencode", "opencode.json"),
      path.join(home, ".cursor", "settings.json"),
      path.join(home, ".cursor", "mcp.json"),
    ];
    const before: Record<string, string> = Object.fromEntries(
      files.map((f) => [f, readFileSync(f, "utf8")]),
    );

    const second = apply(dir, home, { platforms: ["opencode", "cursor"] });
    expect(second.ok, JSON.stringify(second.entries)).toBe(true);
    expect(second.entries.some((e) => e.status === "Failed")).toBe(false);
    for (const file of files) {
      expect(statusOf(second, file)).toBe("Skipped");
      expect(readFileSync(file, "utf8")).toBe(before[file]); // byte-for-byte
    }
    // the plugin package is re-synced from the same source → Skipped too
    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
    expect(statusOf(second, pluginDir)).toBe("Skipped");
  } finally {
    clean(home);
    clean(dir);
  }
});

test("reapplying the same Cursor source removes stale package files and preserves compiled rules", () => {
  const home = tempDir("workit-install-refresh-home-");
  const dir = tempDir("workit-install-refresh-cfg-");
  const dev = tempDir("workit-install-refresh-dev-");
  const source = path.join(dev, "packages", "workit-cursor");
  const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
  const staleVendor = path.join("vendor", "legacy", "start-server.sh");
  const compiledRule = path.join("rules", "user-managed.mdc");
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(path.join(repoRoot, "packages", "workit-cursor"), source, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
    mkdirSync(path.dirname(path.join(source, staleVendor)), { recursive: true });
    writeFileSync(path.join(source, staleVendor), "#!/usr/bin/env bash\n", { mode: 0o755 });
    const applyCursor = () => {
      const preview = buildSetupPreview(values({ platforms: ["cursor"] }), {
        dir,
        cwd: dir,
        env: {},
        home,
      });
      return applySetupPreview(preview, opts(home, dir, { dev }));
    };

    const first = applyCursor();
    expect(first.ok, JSON.stringify(first.entries)).toBe(true);
    writeFileSync(path.join(pluginDir, compiledRule), "---\nalwaysApply: true\n---\n# User rule\n");
    rmSync(path.join(source, staleVendor));

    const refreshed = applyCursor();
    expect(statusOf(refreshed, pluginDir)).toBe("Configured");
    expect(existsSync(path.join(pluginDir, staleVendor))).toBe(false);
    expect(readFileSync(path.join(pluginDir, compiledRule), "utf8")).toContain("# User rule");

    expect(statusOf(applyCursor(), pluginDir)).toBe("Skipped");
  } finally {
    clean(home);
    clean(dir);
    clean(dev);
  }
});

test("Cursor refresh staging failure keeps the prior live install and returns Failed", () => {
  if (
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    return;
  }
  const home = tempDir("workit-install-atomic-home-");
  const dir = tempDir("workit-install-atomic-cfg-");
  const dev = tempDir("workit-install-atomic-dev-");
  const source = path.join(dev, "packages", "workit-cursor");
  const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
  const skill = path.join("skills", "wk-init", "SKILL.md");
  const sourceSkill = path.join(source, skill);
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(path.join(repoRoot, "packages", "workit-cursor"), source, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
    const applyCursor = () => {
      const preview = buildSetupPreview(values({ platforms: ["cursor"] }), {
        dir,
        cwd: dir,
        env: {},
        home,
      });
      return applySetupPreview(preview, opts(home, dir, { dev }));
    };
    const first = applyCursor();
    expect(first.ok, JSON.stringify(first.entries)).toBe(true);
    const installedBefore = readFileSync(path.join(pluginDir, skill), "utf8");
    writeFileSync(sourceSkill, "# changed but unreadable\n");
    chmodSync(sourceSkill, 0o000);

    const failed = applyCursor();
    expect(failed.ok).toBe(false);
    expect(statusOf(failed, pluginDir)).toBe("Failed");
    expect(readFileSync(path.join(pluginDir, skill), "utf8")).toBe(installedBefore);
    const parent = path.dirname(pluginDir);
    expect(readdirSync(parent).filter((name) => name.includes(".workit.swap-"))).toEqual([]);
  } finally {
    try {
      chmodSync(sourceSkill, 0o644);
    } catch {
      /* source may not exist */
    }
    clean(home);
    clean(dir);
    clean(dev);
  }
});

test("migrates the legacy Cursor identity to workit, preserving unrelated bytes (CA-08/CA-09)", () => {
  const home = tempDir("workit-migrate-home-");
  const dir = tempDir("workit-migrate-cfg-");
  const dev = tempDir("workit-migrate-dev-");
  const source = path.join(dev, "packages", "workit-cursor");
  const legacyDir = path.join(home, ".cursor", "plugins", "local", "workflow-toolkit");
  const newDir = path.join(home, ".cursor", "plugins", "local", "workit");
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(path.join(repoRoot, "packages", "workit-cursor"), source, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
    // Legacy install: old dir with a user-compiled rule, old enabled keys and
    // old plugin-dir entries, unrelated similarly-named plugins and settings.
    mkdirSync(path.join(legacyDir, "skills", "wk-init"), { recursive: true });
    writeFileSync(path.join(legacyDir, "skills", "wk-init", "SKILL.md"), "# legacy\n");
    mkdirSync(path.join(legacyDir, "rules"), { recursive: true });
    writeFileSync(
      path.join(legacyDir, "rules", "user-managed.mdc"),
      "---\nalwaysApply: true\n---\n# User rule\n",
    );
    mkdirSync(path.join(home, ".cursor", "rules"), { recursive: true });
    writeFileSync(path.join(home, ".cursor", "rules", "custom.mdc"), "# unrelated custom rule\n");
    const otherDir = path.join(home, ".cursor", "plugins", "local", "workflow-toolkit-extra");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, "marker"), "unrelated\n");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "settings.json"),
      JSON.stringify({
        enabled_plugins: {
          "workflow-toolkit": true,
          "local/workflow-toolkit": true,
          "workflow-toolkit-extra": true,
          "other-plugin": true,
        },
        plugin_dirs: [legacyDir, otherDir],
        "chat.temperature": 0.7,
        telemetry: { machineId: "abc-123" },
      }),
    );
    writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "workflow-toolkit": { command: "bash", args: ["-lc", "legacy"] },
          "other-server": { command: "python", args: ["-m", "http.server"] },
        },
      }),
    );

    const preview = buildSetupPreview(values({ platforms: ["cursor"] }), {
      dir,
      cwd: dir,
      env: {},
      home,
    });
    const result = applySetupPreview(preview, opts(home, dir, { dev }));
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);

    // New identity installed and registered; exact legacy entries removed.
    const settings = JSON.parse(readFileSync(path.join(home, ".cursor", "settings.json"), "utf8"));
    expect(settings.enabled_plugins.workit).toBe(true);
    expect(settings.enabled_plugins["workflow-toolkit"]).toBeUndefined();
    expect(settings.enabled_plugins["local/workflow-toolkit"]).toBeUndefined();
    expect(settings.enabled_plugins["workflow-toolkit-extra"]).toBe(true);
    expect(settings.enabled_plugins["other-plugin"]).toBe(true);
    expect(settings.plugin_dirs).toContain(newDir);
    expect(settings.plugin_dirs).toContain(otherDir);
    expect(settings.plugin_dirs).not.toContain(legacyDir);
    expect(settings["chat.temperature"]).toBe(0.7);
    expect(settings.telemetry).toEqual({ machineId: "abc-123" });

    // The legacy directory is removed only after the new install succeeded;
    // the user-compiled rule is carried forward, unrelated bytes survive.
    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(readFileSync(path.join(newDir, "rules", "user-managed.mdc"), "utf8")).toContain(
      "# User rule",
    );
    expect(readFileSync(path.join(home, ".cursor", "rules", "custom.mdc"), "utf8")).toBe(
      "# unrelated custom rule\n",
    );
    expect(readFileSync(path.join(otherDir, "marker"), "utf8")).toBe("unrelated\n");

    // MCP: the legacy server name is dropped, the unrelated server is kept.
    const mcp = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["other-server", "workit"]);
  } finally {
    clean(home);
    clean(dir);
    clean(dev);
  }
});

test("legacy Cursor identity and registration survive a failed replacement (CA-09 ordered cleanup)", () => {
  if (
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    return;
  }
  const home = tempDir("workit-migrate-fail-home-");
  const dir = tempDir("workit-migrate-fail-cfg-");
  const dev = tempDir("workit-migrate-fail-dev-");
  const source = path.join(dev, "packages", "workit-cursor");
  const legacyDir = path.join(home, ".cursor", "plugins", "local", "workflow-toolkit");
  const legacySkill = path.join("skills", "wk-init", "SKILL.md");
  const sourceSkill = path.join(source, legacySkill);
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(path.join(repoRoot, "packages", "workit-cursor"), source, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
    // Legacy install + registration present.
    mkdirSync(path.join(legacyDir, "skills", "wk-init"), { recursive: true });
    writeFileSync(path.join(legacyDir, legacySkill), "# legacy\n");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "settings.json"),
      JSON.stringify({
        enabled_plugins: { "workflow-toolkit": true },
        plugin_dirs: [legacyDir],
      }),
    );
    // Force the staged copy to fail (unreadable source) BEFORE the final rename.
    writeFileSync(sourceSkill, "# changed but unreadable\n");
    chmodSync(sourceSkill, 0o000);

    const preview = buildSetupPreview(values({ platforms: ["cursor"] }), {
      dir,
      cwd: dir,
      env: {},
      home,
    });
    const result = applySetupPreview(preview, opts(home, dir, { dev }));
    expect(result.ok).toBe(false);

    // The legacy directory and registration remain recoverable.
    expect(existsSync(legacyDir)).toBe(true);
    const settings = JSON.parse(readFileSync(path.join(home, ".cursor", "settings.json"), "utf8"));
    expect(settings.enabled_plugins["workflow-toolkit"]).toBe(true);
    expect(settings.plugin_dirs).toContain(legacyDir);
  } finally {
    try {
      chmodSync(sourceSkill, 0o644);
    } catch {
      /* source may not exist */
    }
    clean(home);
    clean(dir);
    clean(dev);
  }
});

test("unrelated config is preserved byte-for-byte; credentials never clobbered (CA-13/WZ-05)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
    writeFileSync(opencodeCfg, JSON.stringify({ model: "gpt-5", theme: "dark", custom: { a: 1 } }));
    const unrelated = path.join(home, ".config", "opencode", "keys.json");
    writeFileSync(unrelated, '{"apiKey":"should-not-change"}\n');

    const result = apply(dir, home, { platforms: ["opencode"] });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);

    // unrelated keys round-trip JSON-identical; only the plugin pin was added
    const cfg = JSON.parse(readFileSync(opencodeCfg, "utf8"));
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.theme).toBe("dark");
    expect(cfg.custom).toEqual({ a: 1 });
    expect(cfg.plugin).toBeDefined();
    // a file the apply never touches stays byte-identical
    expect(readFileSync(unrelated, "utf8")).toBe('{"apiKey":"should-not-change"}\n');
  } finally {
    clean(home);
    clean(dir);
  }
});

test("file-vs-ignore: existing files merged/skipped, new files created (WZ-05/CA-13)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    // existing youtrack.json with unrelated keys + a real token (must survive)
    const ytJson = path.join(dir, "youtrack.json");
    const ytToken = path.join(dir, "youtrack.token");
    writeFileSync(
      ytJson,
      JSON.stringify({
        baseUrl: "https://org.youtrack.cloud",
        meetingIssue: "ORG-1",
        greetingCutoff: "11:00",
      }),
    );
    writeFileSync(ytToken, "perm_supersecret\n", { mode: 0o600 });

    const result = apply(dir, home, {
      platforms: ["opencode"],
      baseUrl: "https://new.example.com",
      vcsProvider: "gitlab",
    });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);

    // existing youtrack.json merged — unrelated keys preserved, baseUrl updated
    expect(statusOf(result, ytJson)).toBe("Configured");
    const merged = JSON.parse(readFileSync(ytJson, "utf8"));
    expect(merged.meetingIssue).toBe("ORG-1");
    expect(merged.greetingCutoff).toBe("11:00");
    expect(merged.baseUrl).toBe("https://new.example.com");

    // existing token byte-for-byte preserved and reported Skipped
    expect(statusOf(result, ytToken)).toBe("Skipped");
    expect(readFileSync(ytToken, "utf8")).toBe("perm_supersecret\n");

    // absent gitlab token created as a placeholder
    const glToken = path.join(dir, "gitlab.token");
    expect(statusOf(result, glToken)).toBe("Installed");
    expect(readFileSync(glToken, "utf8").trim()).toBe(TOKEN_PLACEHOLDER);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("partial platform failure propagates nonzero + Failed entry; healthy platform applied (WZ-15)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  const dev = tempDir("workit-install-dev-");
  try {
    // fake dev checkout: opencode present, cursor absent
    mkdirSync(path.join(dev, "packages"), { recursive: true });
    cpSync(
      path.join(repoRoot, "packages/workit-opencode"),
      path.join(dev, "packages/workit-opencode"),
      {
        recursive: true,
        filter: (src) => !src.includes("node_modules"),
      },
    );

    const result = applySetupPreview(
      buildSetupPreview(values({ platforms: ["opencode", "cursor"] }), {
        dir,
        cwd: dir,
        env: {},
        home,
      }),
      opts(home, dir, { dev }),
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const cursorFailed = result.entries.filter(
      (e) => e.platform === "cursor" && e.status === "Failed",
    );
    expect(cursorFailed.length).toBeGreaterThan(0);
    // the healthy platform is still installed and verified
    expect(result.entries.some((e) => e.platform === "opencode" && e.status === "Installed")).toBe(
      true,
    );
    expect(existsSync(path.join(home, ".config", "opencode", "opencode.json"))).toBe(true);
  } finally {
    clean(home);
    clean(dir);
    clean(dev);
  }
});

test("packaged hygiene assets are applied without overwriting existing files (CA-08)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  const project = tempDir("workit-install-project-");
  try {
    writeFileSync(path.join(project, ".gitignore"), "# existing\n", "utf8");
    const result = applySetupPreview(
      buildSetupPreview(values({ platforms: [], applyProject: true }), {
        dir,
        cwd: project,
        env: {},
      }),
      opts(home, dir, { cwd: project }),
    );
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(existsSync(path.join(project, "CHANGELOG.md"))).toBe(true);
    expect(readFileSync(path.join(project, "CHANGELOG.md"), "utf8")).toContain("# Changelog");
    const gitignore = readFileSync(path.join(project, ".gitignore"), "utf8");
    expect(gitignore).toContain("# existing");
    expect(gitignore).toContain("docs/*/sdd/");
    expect(suffixStatus(result, "CHANGELOG.md")).toContain("Installed");
    expect(statusOf(result, path.join(project, ".gitignore"))).toBe("Configured");
  } finally {
    clean(home);
    clean(dir);
    clean(project);
  }
});

test("corrupted platform config is preserved, not overwritten (CA-14)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
    const cursorSettings = path.join(home, ".cursor", "settings.json");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    mkdirSync(path.dirname(opencodeCfg), { recursive: true });
    mkdirSync(path.dirname(cursorSettings), { recursive: true });
    writeFileSync(opencodeCfg, "{ not valid json");
    writeFileSync(cursorSettings, "{ nope");
    writeFileSync(cursorMcp, "definitely-not-json");

    const result = apply(dir, home, { platforms: ["opencode", "cursor"] });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    for (const file of [opencodeCfg, cursorSettings, cursorMcp]) {
      expect(statusOf(result, file)).toBe("Failed");
      expect(readFileSync(file, "utf8")).toBe(
        file === opencodeCfg
          ? "{ not valid json"
          : file === cursorSettings
            ? "{ nope"
            : "definitely-not-json",
      );
    }
  } finally {
    clean(home);
    clean(dir);
  }
});

test("blocked preview → exitCode 1, Failed entries, nothing written (WZ-06/CA-22)", () => {
  const home = tempDir("workit-install-home-");
  const dir = tempDir("workit-install-cfg-");
  try {
    writeFileSync(path.join(dir, "youtrack.json"), "{ not json");
    const preview = buildSetupPreview(values(), { dir, cwd: dir, env: {} });
    expect(preview.ok).toBe(false);
    const result = applySetupPreview(preview, opts(home, dir));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((e) => e.status === "Failed")).toBe(true);
    expect(existsSync(path.join(home, ".config", "opencode", "opencode.json"))).toBe(false);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("unreadable platform config is Failed with the path, never rewritten (EACCES)", () => {
  // root bypasses file permissions and win32 chmod is not advisory — skip both.
  if (
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    return;
  }
  const home = tempDir("workit-install-eacces-");
  const dir = tempDir("workit-install-eacces-cfg-");
  const opencodeCfg = path.join(home, ".config", "opencode", "opencode.json");
  const original = JSON.stringify({ model: "gpt-5" });
  try {
    mkdirSync(path.dirname(opencodeCfg), { recursive: true });
    writeFileSync(opencodeCfg, original, "utf8");
    chmodSync(opencodeCfg, 0o000);

    const result = apply(dir, home, { platforms: ["opencode"] });
    expect(result.ok, JSON.stringify(result.entries)).toBe(false);
    expect(result.exitCode).toBe(1);
    const entry = result.entries.find((e) => e.file === opencodeCfg);
    expect(entry?.status).toBe("Failed");
    expect(entry?.detail).toContain(opencodeCfg);
    // no write attempt: the original bytes are untouched once perms are restored
    chmodSync(opencodeCfg, 0o644);
    expect(readFileSync(opencodeCfg, "utf8")).toBe(original);
  } finally {
    try {
      chmodSync(opencodeCfg, 0o644);
    } catch {
      /* file may already be gone */
    }
    clean(home);
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Task 28 (AR-09/AR-10, CA-39): preview/apply parity and custom credential
// paths. Every file Apply changes must have been previewed as a mutation, and
// existing configured token paths + bytes stay authoritative.
// ---------------------------------------------------------------------------

const treeFiles = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(p, readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out;
};

const collectTree = (...roots: string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const [p, content] of treeFiles(root)) map.set(p, content);
  }
  return map;
};

test("preview/apply parity: every Apply write was previewed, exactly (AR-09/CA-39)", () => {
  const home = tempDir("workit-parity-home-");
  const dir = tempDir("workit-parity-cfg-");
  try {
    const preview = buildSetupPreview(
      values({
        platforms: ["opencode", "cursor"],
        baseUrl: "https://yt.example.com",
        vcsProvider: "gitlab",
        workspaces: [wsEntry("work", "/work/**")],
        applyProject: true,
      }),
      { dir, cwd: dir, env: {}, home },
    );
    expect(preview.ok, JSON.stringify(preview.blocked)).toBe(true);

    // content classes: the preview covers every write class Apply performs
    const types = new Set(preview.mutations.map((m) => m.type));
    for (const t of [
      "create-file",
      "merge-json",
      "update-workspaces",
      "append-gitignore",
      "register-platform",
      "install-adapter",
    ]) {
      expect(types.has(t as never), `preview must plan a ${t} write`).toBe(true);
    }

    const before = collectTree(home, dir);
    const result = applySetupPreview(preview, opts(home, dir));
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    const after = collectTree(home, dir);

    const changed = [...after.entries()].filter(([p, c]) => {
      const prev = before.get(p);
      return prev === undefined || prev !== c;
    });
    // nothing was deleted by Apply
    for (const p of before.keys()) {
      expect(existsSync(p), `Apply deleted ${p}`).toBe(true);
    }

    // every changed path was previewed: exact match, or inside the previewed
    // adapter copy directory for the cursor plugin package
    const previewedPaths = new Set(preview.mutations.map((m) => m.path));
    const isCovered = (p: string): boolean =>
      previewedPaths.has(p) ||
      preview.mutations.some(
        (m) => m.type === "install-adapter" && p.startsWith(`${m.path}${path.sep}`),
      );
    const uncovered = changed.map(([p]) => p).filter((p) => !isCovered(p));
    expect(uncovered).toEqual([]);

    // exact equality in both directions: each previewed mutation maps to a
    // changed path (collapsing the adapter copy dir onto its files), and every
    // changed path maps back to a previewed mutation
    const collapsed = new Set(
      changed.map(([p]) => {
        const inst = preview.mutations.find(
          (m) => m.type === "install-adapter" && p.startsWith(`${m.path}${path.sep}`),
        );
        return inst ? inst.path : p;
      }),
    );
    expect(collapsed).toEqual(previewedPaths);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("custom credential paths and canary bytes survive Apply (AR-10)", () => {
  const home = tempDir("workit-token-home-");
  const dir = tempDir("workit-token-cfg-");
  try {
    const ytJson = path.join(dir, "youtrack.json");
    const vcsJson = path.join(dir, "vcs.json");
    const customYt = path.join(dir, "secrets", "yt.token");
    const customGl = path.join(dir, "secrets", "gl.token");
    const customGh = path.join(dir, "secrets", "gh.token");
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(
      ytJson,
      JSON.stringify({
        baseUrl: "https://org.example.com",
        tokenFile: customYt,
        meetingIssue: "ORG-1",
      }),
      "utf8",
    );
    writeFileSync(customYt, "canary-yt-123\n", { mode: 0o600 });
    writeFileSync(
      vcsJson,
      JSON.stringify({
        provider: "gitlab",
        gitlab: { host: "gitlab.example.com", tokenFile: customGl },
        github: { tokenFile: customGh },
      }),
      "utf8",
    );
    writeFileSync(customGl, "canary-gl-123\n", { mode: 0o600 });
    writeFileSync(customGh, "canary-gh-123\n", { mode: 0o600 });

    const result = apply(dir, home, {
      platforms: ["opencode"],
      baseUrl: "https://new.example.com",
      vcsProvider: "gitlab",
    });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);

    // configs still point at the custom paths; unrelated keys preserved
    const yt = JSON.parse(readFileSync(ytJson, "utf8")) as Record<string, unknown>;
    expect(yt.tokenFile).toBe(customYt);
    expect(yt.meetingIssue).toBe("ORG-1");
    expect(yt.baseUrl).toBe("https://new.example.com");
    const vcs = JSON.parse(readFileSync(vcsJson, "utf8")) as {
      gitlab: { tokenFile: string };
      github: { tokenFile: string };
    };
    expect(vcs.gitlab.tokenFile).toBe(customGl);
    expect(vcs.github.tokenFile).toBe(customGh);

    // canary bytes byte-for-byte intact, reported preserved
    for (const [p, bytes] of [
      [customYt, "canary-yt-123\n"],
      [customGl, "canary-gl-123\n"],
    ] as const) {
      expect(readFileSync(p, "utf8")).toBe(bytes);
      expect(result.entries.some((e) => e.file === p && e.status === "Skipped")).toBe(true);
    }
    // no default token files were created next to the configs
    for (const def of [path.join(dir, "youtrack.token"), path.join(dir, "gitlab.token")]) {
      expect(existsSync(def)).toBe(false);
    }
  } finally {
    clean(home);
    clean(dir);
  }
});

test("apply fails fast when apply options differ from preview options (AR-13)", () => {
  const homeA = tempDir("workit-contract-a-");
  const homeB = tempDir("workit-contract-b-");
  const dir = tempDir("workit-contract-cfg-");
  try {
    const preview = buildSetupPreview(values({ platforms: ["opencode", "cursor"] }), {
      dir,
      cwd: dir,
      env: {},
      home: homeA,
    });
    expect(preview.ok, JSON.stringify(preview.blocked)).toBe(true);
    const platformMutations = preview.mutations.filter(
      (m) => m.type === "register-platform" || m.type === "install-adapter",
    );
    expect(platformMutations.length).toBe(4);
    for (const m of platformMutations) {
      expect(m.path.startsWith(homeA)).toBe(true);
    }

    // Apply with DIFFERENT options (a different home): the reviewed mutation
    // paths are homeA paths, the apply-time resolution points at homeB. Apply
    // must refuse the write (Failed) — it must never write an unreviewed path.
    const result = applySetupPreview(preview, opts(homeB, dir));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    for (const m of platformMutations) {
      const entry = result.entries.find((e) => e.file === m.path);
      expect(entry?.status, `mutation ${m.type}:${m.path}`).toBe("Failed");
    }
    for (const root of [homeA, homeB]) {
      expect(existsSync(path.join(root, ".config", "opencode", "opencode.json"))).toBe(false);
      expect(existsSync(path.join(root, ".cursor", "settings.json"))).toBe(false);
      expect(existsSync(path.join(root, ".cursor", "mcp.json"))).toBe(false);
      expect(existsSync(path.join(root, ".cursor", "plugins", "local", "workit"))).toBe(false);
    }
  } finally {
    clean(homeA);
    clean(homeB);
    clean(dir);
  }
});
