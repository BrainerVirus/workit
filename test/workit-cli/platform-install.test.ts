import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  applySetupPreview(buildSetupPreview(values(over), { dir, cwd: dir, env: {} }), opts(home, dir));

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
    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workflow-toolkit");
    expect(statusOf(second, pluginDir)).toBe("Skipped");
  } finally {
    clean(home);
    clean(dir);
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
      buildSetupPreview(values({ platforms: ["opencode", "cursor"] }), { dir, cwd: dir, env: {} }),
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
