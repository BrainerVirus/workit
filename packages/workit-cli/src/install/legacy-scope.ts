// Workit published as @brainervirus/workit-* up to 14.x and as @workit-dev/*
// from 1.0.0. The version numbers restarted, so a 14.x install of the old
// scope is never compared with a 1.x release of the new one: that would read
// as "newer than published". This module is the one place that names the old
// scope; it only finds old-scope installs so the doctor can point at the
// migration. Moving them is the old scope's own `workit upgrade` (the 14.x
// bridge release), which knows both names.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { claudeWorkitInstalls } from "../admin/host-install";
import { pathWorkits } from "./discover";
import { ownedPaths, realpathOr } from "./paths";

export const LEGACY_SCOPE = "@brainervirus";

/** The old-scope name of a package: `cli` -> `@brainervirus/workit-cli`. */
export const legacyName = (pkg: string): string => `${LEGACY_SCOPE}/workit-${pkg}`;

/**
 * The one command that moves every old-scope install to @workit-dev: the
 * latest old-scope CLI (the 14.x bridge) migrates the CLI and each host.
 */
export const LEGACY_SCOPE_FIX = `npx -y ${legacyName("cli")}@latest upgrade`;

export type LegacyScopeInstall = { what: string; version: string | null };

export type LegacyScopePaths = {
  home: string;
  env: NodeJS.ProcessEnv;
  opencodeConfig: string;
  piAgentDir: string;
  codexHome: string;
  cursorPluginDir: string;
};

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The version an old-scope package directory holds, or null when it is not `pkg` of the old scope. */
const legacyVersion = (packageDir: string, pkg: string): string | null | undefined => {
  const found = readJson(path.join(packageDir, "package.json"));
  if (found?.name !== legacyName(pkg)) return undefined;
  return typeof found.version === "string" ? found.version : null;
};

/** `@brainervirus/workit-<pkg>`, bare, `npm:`-prefixed or with a version or tag. */
const legacySpec = (pkg: string): RegExp =>
  new RegExp(`^(?:npm:)?${LEGACY_SCOPE}/workit-${pkg}(?:@\\S+)?$`);

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

/**
 * Every old-scope install this machine still runs: the Workit-owned CLI, a
 * `workit` on PATH from an old-scope npm package, and each host registration
 * (OpenCode pin, Pi package, Cursor MCP server and plugin, Codex and Claude
 * Code plugin caches). Read-only.
 */
export const legacyScopeInstalls = (paths: LegacyScopePaths): LegacyScopeInstall[] => {
  const found: LegacyScopeInstall[] = [];
  const add = (what: string, version: string | null) => {
    if (!found.some((entry) => entry.what === what)) found.push({ what, version });
  };
  const env = { ...paths.env, HOME: paths.home };

  const owned = path.join(ownedPaths(env).current, "node_modules", LEGACY_SCOPE, "workit-cli");
  const ownedVersion = legacyVersion(owned, "cli");
  if (ownedVersion !== undefined) add(`Workit-owned CLI ${realpathOr(owned)}`, ownedVersion);

  const cliSegment = `${path.sep}node_modules${path.sep}${LEGACY_SCOPE}${path.sep}workit-cli${path.sep}`;
  for (const bin of pathWorkits(env)) {
    const real = realpathOr(bin);
    const at = real.indexOf(cliSegment);
    if (at < 0) continue;
    const dir = real.slice(0, at + cliSegment.length - 1);
    add(`npm CLI ${dir}`, legacyVersion(dir, "cli") ?? null);
  }

  const opencode = readJson(paths.opencodeConfig);
  for (const pin of [opencode?.plugin, opencode?.plugins].flatMap((list) =>
    Array.isArray(list) ? list : [],
  ))
    if (typeof pin === "string" && legacySpec("opencode").test(pin))
      add(`OpenCode plugin ${pin} in ${paths.opencodeConfig}`, null);

  const piSettings = path.join(paths.piAgentDir, "settings.json");
  const pi = readJson(piSettings);
  for (const entry of Array.isArray(pi?.packages) ? pi.packages : []) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source === "string" && legacySpec("pi").test(source))
      add(`Pi package ${source} in ${piSettings}`, null);
  }

  const mcpFile = path.join(paths.home, ".cursor", "mcp.json");
  const args: unknown = readJson(mcpFile)?.mcpServers?.workit?.args;
  for (const arg of Array.isArray(args) ? args : [])
    if (typeof arg === "string" && arg.startsWith(`--package=${legacyName("cursor")}`))
      add(`Cursor MCP server ${arg.slice("--package=".length)} in ${mcpFile}`, null);
  const cursorVersion = legacyVersion(paths.cursorPluginDir, "cursor");
  if (cursorVersion !== undefined) add(`Cursor plugin ${paths.cursorPluginDir}`, cursorVersion);

  for (const dir of subdirs(path.join(paths.codexHome, "plugins", "cache"))) {
    for (const versionDir of subdirs(path.join(dir, "workit"))) {
      const version = legacyVersion(versionDir, "codex");
      if (version !== undefined) add(`Codex plugin ${versionDir}`, version);
    }
  }

  for (const install of claudeWorkitInstalls(paths.home, paths.env, null)) {
    const version = legacyVersion(install.installPath, "claude-code");
    if (version !== undefined)
      add(`Claude Code plugin ${install.id} ${install.installPath}`, version);
  }
  return found;
};

/** True when a Claude Code plugin install holds the old-scope package (its version is not comparable). */
export const isLegacyClaudePlugin = (installPath: string): boolean =>
  legacyVersion(installPath, "claude-code") !== undefined;
