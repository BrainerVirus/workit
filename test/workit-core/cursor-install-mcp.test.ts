import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySetupPreview,
  buildSetupPreview,
  type SetupPreviewInput,
  type SetupResult,
} from "../../packages/workit-core/src/core/setup";
import { isolatedEnv } from "../shared/helpers/packages";

// PT-10 + cursor cwd semantics: the SHIPPED plugin manifest stays
// package-relative, but Cursor spawns plugin MCP servers with the workspace as
// cwd, so the INSTALLED copy's mcp.json must carry an absolute entry rewritten
// at install time.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const tempDir = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

const values = (over: Partial<SetupPreviewInput> = {}): SetupPreviewInput => ({
  platforms: ["cursor"],
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

const apply = (dir: string, home: string): SetupResult =>
  applySetupPreview(buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }), {
    home,
    configDir: dir,
    dev: repoRoot,
    cwd: dir,
    env: envFor(home, dir),
  });

const statusOf = (result: SetupResult, file: string): string | undefined =>
  result.entries.find((e) => e.file === file)?.status;

test("the installed plugin mcp.json is rewritten to an absolute node entry at install (PT-10)", () => {
  const home = tempDir("wk-cursor-mcp-home-");
  const dir = tempDir("wk-cursor-mcp-cfg-");
  try {
    const result = apply(dir, home);
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);

    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
    const pluginMcp = JSON.parse(readFileSync(path.join(pluginDir, "mcp.json"), "utf8"));
    const entry = pluginMcp.mcpServers.workit;
    expect(entry.command).toBe("node");
    expect(entry.args[0]).toStartWith(`${pluginDir}${path.sep}`);
    expect(entry.args[0]).toEndWith(path.join("dist", "mcp-server.js"));

    // The SHIPPED manifest stays package-relative (PT-10): the installed copy
    // is a derived artifact, never the source bytes.
    const shipped = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "workit-cursor", "mcp.json"), "utf8"),
    );
    expect(shipped.mcpServers.workit.args[0]).toBe("./dist/mcp-server.js");
    expect(shipped.mcpServers.workit.args[0]).not.toBe(entry.args[0]);

    // ~/.cursor/mcp.json registers the same absolute entry.
    const userMcp = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
    expect(userMcp.mcpServers.workit).toEqual(entry);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("a second cursor apply reports the plugin Skipped — the derived mcp.json matches (truthful Skipped)", () => {
  const home = tempDir("wk-cursor-mcp-idem-home-");
  const dir = tempDir("wk-cursor-mcp-idem-cfg-");
  try {
    const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
    mkdirSync(path.dirname(pluginDir), { recursive: true });

    const first = apply(dir, home);
    expect(first.ok, JSON.stringify(first.entries)).toBe(true);
    expect(statusOf(first, pluginDir)).toBe("Installed");

    const second = apply(dir, home);
    expect(second.ok, JSON.stringify(second.entries)).toBe(true);
    expect(statusOf(second, pluginDir)).toBe("Skipped");
  } finally {
    clean(home);
    clean(dir);
  }
});
