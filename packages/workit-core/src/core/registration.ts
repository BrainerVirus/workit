// Registration merge helpers for the OpenCode/Cursor installers (RR-06).
// Pure functions: accept the existing user config, return the deduplicated
// config PLUS the explicit list of keys changed. Unrelated user settings are
// never rewritten — their values round-trip JSON-identical. The install
// scripts (`packages/workit-core/scripts/install-*-plugin.sh`) import these so
// there is exactly one source of truth for registration merging.
import { existsSync } from "node:fs";
import path from "node:path";

export interface MergeResult<T> {
  config: T;
  changed: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Exact identity match — `name` or `name@version` — never a substring (D3). */
const named = (s: string, name: string) => s === name || s.startsWith(`${name}@`);

/**
 * True when a plugin identity is a current or legacy Workit entry. Matched by
 * exact identity, never by substring: an unrelated plugin whose id merely
 * contains "workflow-toolkit" is preserved (D3). Path-style identities are
 * compared with normalized separators so a Windows file:// pin (backslashes)
 * still matches the packages/workit-* path checks.
 */
export function isWorkitPlugin(value: unknown): boolean {
  const s = String(value).replaceAll("\\", "/");
  const url = s.startsWith("file://") || s.startsWith("git+file://");
  const pkgPath =
    s.includes("/packages/workit-opencode/") ||
    s.includes("/packages/workit-cursor/") ||
    s.includes("/node_modules/@brainervirus/workit-opencode/") ||
    s.includes("/node_modules/@brainervirus/workit-cursor/");
  return (
    named(s, "workflow-toolkit") ||
    named(s, "workflow-toolkit-opencode") ||
    named(s, "local/workflow-toolkit") ||
    named(s, "workit") ||
    named(s, "local/workit") ||
    named(s, "@brainervirus/workit-opencode") ||
    named(s, "@brainervirus/workit-cursor") ||
    (url && pkgPath) ||
    (s.startsWith("git+file://") && s.includes("workflow-toolkit"))
  );
}

/** Deduplicate every legacy/current Workit plugin identity to one dev pin. */
export function mergeOpenCodePlugins(plugin: unknown, pin: string): MergeResult<unknown[]> {
  const existing = Array.isArray(plugin) ? plugin : typeof plugin === "string" ? [plugin] : [];
  const config = [pin, ...existing.filter((p) => !isWorkitPlugin(p))];
  const changed = JSON.stringify(config) !== JSON.stringify(existing) ? ["plugin"] : [];
  return { config, changed };
}

/** Merge an existing OpenCode config with a dev pin; preserve unrelated keys. */
export function mergeOpenCodeConfig(
  config: unknown,
  pin: string,
): MergeResult<Record<string, unknown>> {
  const base = isRecord(config) ? { ...config } : {};
  const changed: string[] = [];

  const plugins = mergeOpenCodePlugins(base.plugin, pin);
  if (plugins.changed.length > 0) {
    base.plugin = plugins.config;
    changed.push("plugin");
  }

  // Drop share skills.paths — native ~/.config/opencode/skills links avoid
  // triple-load duplicates. Matched by exact path segment, never substring: an
  // unrelated dir like `~/projects/my-workflow-toolkit-skills` is preserved (D3).
  const skills = base.skills;
  if (isRecord(skills) && Array.isArray(skills.paths)) {
    const next = skills.paths.filter((p) => {
      const segment = String(p).split(/[\\/]/);
      return !segment.some((seg) => named(seg, "workflow-toolkit"));
    });
    if (next.length !== skills.paths.length) {
      base.skills = { ...skills, paths: next };
      changed.push("skills.paths");
    }
  }

  return { config: base, changed };
}

/** Collapse current + legacy Cursor plugin identities to the canonical `workit`. */
export function mergeCursorEnabledPlugins(enabled: unknown): MergeResult<Record<string, boolean>> {
  const prev = isRecord(enabled) ? { ...(enabled as Record<string, boolean>) } : {};
  const next: Record<string, boolean> = { ...prev, workit: true };
  delete next["workflow-toolkit"]; // legacy identity
  delete next["local/workflow-toolkit"]; // legacy duplicate identity
  const changed = JSON.stringify(next) !== JSON.stringify(prev) ? ["enabled_plugins"] : [];
  return { config: next, changed };
}

/** Append the plugin dir once, dropping the exact legacy sibling directory. */
export function mergeCursorPluginDirs(
  pluginDirs: unknown,
  pluginDir: string,
): MergeResult<string[]> {
  // path.join does not strip a single trailing separator; do it explicitly for
  // the dedup comparison (guarding the filesystem-root case).
  const strip = (p: string) => {
    const j = path.join(p);
    return path.dirname(j) === j ? j : j.replace(/[\\/]+$/, "");
  };
  const normalized = strip(pluginDir);
  // CA-08: the legacy local plugin dir is the exact sibling of the canonical
  // dir; remove only that entry, never a similarly-named unrelated dir (D3).
  const legacy = strip(path.join(path.dirname(pluginDir), "workflow-toolkit"));
  const prev = Array.isArray(pluginDirs) ? pluginDirs.map(String) : [];
  const kept = prev.filter((d) => strip(d) !== legacy);
  // Normalize both sides for comparison so a trailing-slash variant of an
  // existing entry is not appended as a duplicate; existing entries are kept
  // verbatim.
  const exists = kept.some((d) => strip(d) === normalized);
  const next = exists ? kept : [...kept, normalized];
  const changed = JSON.stringify(next) !== JSON.stringify(prev) ? ["plugin_dirs"] : [];
  return { config: next, changed };
}

/** Merge Cursor settings: one plugin identity, dirs appended, unrelated keys kept. */
export function mergeCursorSettings(
  settings: unknown,
  pluginDir: string,
): MergeResult<Record<string, unknown>> {
  const base = isRecord(settings) ? { ...settings } : {};
  const changed: string[] = [];

  const enabled = mergeCursorEnabledPlugins(base.enabled_plugins);
  if (enabled.changed.length > 0) {
    base.enabled_plugins = enabled.config;
    changed.push("enabled_plugins");
  }

  const dirs = mergeCursorPluginDirs(base.plugin_dirs, pluginDir);
  if (dirs.changed.length > 0) {
    base.plugin_dirs = dirs.config;
    changed.push("plugin_dirs");
  }

  return { config: base, changed };
}

/** Set one portable workit MCP server, dropping the legacy server name. */
export function mergeCursorMcp(
  mcp: unknown,
  serverName: string,
  server: Record<string, unknown>,
): MergeResult<Record<string, unknown>> {
  const base = isRecord(mcp) ? { ...mcp } : {};
  const servers = isRecord(base.mcpServers)
    ? { ...(base.mcpServers as Record<string, unknown>) }
    : {};
  delete servers["workflow-toolkit"]; // legacy duplicate registration
  servers[serverName] = server;
  const changed = JSON.stringify(servers) !== JSON.stringify(base.mcpServers) ? ["mcpServers"] : [];
  base.mcpServers = servers;
  return { config: base, changed };
}

/** Swap the sessionStart hook command, preserving other hooks and fields. */
export function mergeCursorHooks(
  hooks: unknown,
  sessionStartEntry: Record<string, unknown>,
): MergeResult<Record<string, unknown>> {
  const base: Record<string, unknown> = isRecord(hooks) ? { ...hooks } : { version: 1 };
  const hooksMap = isRecord(base.hooks) ? { ...(base.hooks as Record<string, unknown>) } : {};
  const list = Array.isArray(hooksMap.sessionStart) ? hooksMap.sessionStart : [];
  const same =
    list.length === 1 &&
    isRecord(list[0]) &&
    JSON.stringify(list[0]) === JSON.stringify(sessionStartEntry);
  if (same) return { config: base, changed: [] };
  hooksMap.sessionStart = [sessionStartEntry];
  base.hooks = hooksMap;
  return { config: base, changed: ["hooks.sessionStart"] };
}

/**
 * Portable Cursor MCP server entry for an installed plugin dir: prefer the
 * self-contained node dist bundle (PT-10); fall back to the bash shim for a
 * dist-less dev checkout.
 */
export function cursorMcpServerEntry(packageDir: string): {
  command: string;
  args: string[];
} {
  if (existsSync(path.join(packageDir, "dist", "mcp-server.js"))) {
    return {
      command: "node",
      args: [path.join(packageDir, "dist", "mcp-server.js"), "${workspaceFolder}"],
    };
  }
  return {
    command: "bash",
    args: [path.join(packageDir, "mcp", "run-server.sh"), "${workspaceFolder}"],
  };
}

/**
 * Portable Cursor sessionStart hook entry: prefer the self-contained node dist
 * bundle; fall back to the bash shim for a dist-less dev checkout (AR-06).
 */
export function cursorHooksEntry(packageDir: string): {
  command: string;
  args: string[];
} {
  if (existsSync(path.join(packageDir, "dist", "cursor-session-start.js"))) {
    return {
      command: "node",
      args: [path.join(packageDir, "dist", "cursor-session-start.js")],
    };
  }
  return {
    command: "bash",
    args: [path.join(packageDir, "hooks", "session-start")],
  };
}
