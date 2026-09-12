// Registration merge helpers for the OpenCode/Cursor installers (RR-06).
// Pure functions: accept the existing user config, return the deduplicated
// config PLUS the explicit list of keys changed. Unrelated user settings are
// never rewritten — their values round-trip JSON-identical. The install
// scripts (`packages/workit-core/scripts/install-*-plugin.sh`) import these so
// there is exactly one source of truth for registration merging.
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

/** Swap the sessionStart hook command and normalize the enforcement events to
 *  canonical (missing or divergent preToolUse/beforeShellExecution entries are
 *  rewritten so the installer heals exactly what the doctor flags). Other
 *  hooks and fields are preserved. */
export function mergeCursorHooks(
  hooks: unknown,
  sessionStartEntry: Record<string, unknown>,
): MergeResult<Record<string, unknown>> {
  const base: Record<string, unknown> = isRecord(hooks) ? { ...hooks } : { version: 1 };
  const hooksMap = isRecord(base.hooks) ? { ...(base.hooks as Record<string, unknown>) } : {};
  const changed: string[] = [];
  const list = Array.isArray(hooksMap.sessionStart) ? hooksMap.sessionStart : [];
  const same =
    list.length === 1 &&
    isRecord(list[0]) &&
    JSON.stringify(list[0]) === JSON.stringify(sessionStartEntry);
  if (!same) {
    hooksMap.sessionStart = [sessionStartEntry];
    changed.push("hooks.sessionStart");
  }
  for (const event of ["preToolUse", "beforeShellExecution"] as const) {
    const canonical = canonicalHookEntry(event);
    const current = hooksMap[event];
    if (
      !Array.isArray(current) ||
      current.length !== 1 ||
      !isRecord(current[0]) ||
      JSON.stringify({ ...current[0], failClosed: true }) !==
        JSON.stringify({ ...canonical, failClosed: true })
    ) {
      hooksMap[event] = [canonical];
      changed.push(`hooks.${event}`);
    }
  }
  base.hooks = hooksMap;
  return { config: base, changed };
}

/**
 * Canonical selector for the Cursor npm runtime: `@latest` with `--prefer-online`
 * (README "Update review"). The single source for every source-derived Cursor
 * runtime selector; the committed manifests keep the literal (static data
 * cannot import TS). `--prefer-online` is mandatory — it forces npx to check
 * the registry so a stale cached `latest` resolution is never reused.
 */
export const CURSOR_RUNTIME_PACKAGE = "@brainervirus/workit-cursor@latest";

/**
 * Canonical Cursor hook launcher (single source of truth for the shipped
 * hooks-cursor.json, the installer merge, and the doctor drift check).
 */
export const CURSOR_HOOK_RUN_COMMAND = `npx -y --prefer-online --package=${CURSOR_RUNTIME_PACKAGE} workit-cursor-hook`;

/**
 * preToolUse matcher covering every name the hook's write-tool guard treats
 * as a write (see CURSOR_WRITE_TOOL_NAMES in the Cursor hook). A narrower
 * installed matcher lets write tools bypass enforcement silently.
 */
export const CURSOR_PRETOOLUSE_MATCHER =
  "Write|Edit|Delete|Shell|Remove|ApplyPatch|Apply_Patch|Patch|Rename|Mkdir|Mv|Cp|Touch";

const canonicalHookEntry = (
  event: "preToolUse" | "beforeShellExecution",
): Record<string, unknown> =>
  event === "preToolUse"
    ? { command: CURSOR_HOOK_RUN_COMMAND, matcher: CURSOR_PRETOOLUSE_MATCHER, failClosed: true }
    : { command: CURSOR_HOOK_RUN_COMMAND, failClosed: true };

/**
 * Drift between an installed hooks file and the canonical event entries.
 * Only present-but-divergent entries count: absent events are filled in by
 * the installer merge on the next run, and minimal installs predate them.
 */
export function cursorHookDrift(installed: unknown): string[] {
  if (!isRecord(installed) || !isRecord(installed.hooks)) return ["hooks file is not a hook map"];
  const hooks = installed.hooks as Record<string, unknown>;
  const drift: string[] = [];
  for (const event of ["preToolUse", "beforeShellExecution"] as const) {
    const list = hooks[event];
    if (list === undefined) continue;
    const canonical = canonicalHookEntry(event);
    const entry = Array.isArray(list) ? list[0] : undefined;
    if (
      !isRecord(entry) ||
      entry.command !== canonical.command ||
      (event === "preToolUse" && entry.matcher !== canonical.matcher)
    )
      drift.push(event);
  }
  return drift;
}

/**
 * Portable Cursor MCP server entry (CA-16/CA-17): launch the published package
 * through npx against its npm bin, so the Marketplace plugin never depends on a
 * repo-relative or untracked dist file.
 */
export function cursorMcpServerEntry(_packageDir: string): {
  command: string;
  args: string[];
} {
  return {
    command: "npx",
    args: [
      "-y",
      "--prefer-online",
      `--package=${CURSOR_RUNTIME_PACKAGE}`,
      "workit-cursor-mcp",
      "${workspaceFolder}",
    ],
  };
}

/**
 * Portable Cursor sessionStart hook entry (CA-17): a single command string in
 * Cursor's documented format (no args array).
 */
export function cursorHooksEntry(_packageDir: string): {
  command: string;
  args: string[];
} {
  return {
    command: `npx -y --prefer-online --package=${CURSOR_RUNTIME_PACKAGE} workit-cursor-session-start`,
    args: [],
  };
}

/**
 * Local-dev Cursor MCP server entry: run the installed plugin's own built dist
 * through node instead of the published npx pin, so a checkout install runs the
 * branch's code (rename included) without waiting for a release. The committed
 * Marketplace manifests keep the reviewed pin; this form is written by the
 * local install path only.
 */
export function cursorMcpLocalDistEntry(packageDir: string): {
  command: string;
  args: string[];
} {
  return {
    command: "node",
    args: [path.join(packageDir, "dist", "mcp-server.js"), "${workspaceFolder}"],
  };
}

/**
 * Local-dev Cursor sessionStart hook entry: node against the installed dist, in
 * Cursor's documented single-command-string hook format (no args array).
 */
export function cursorHookLocalDistEntry(packageDir: string): {
  command: string;
  args: string[];
} {
  return {
    command: `node ${path.join(packageDir, "dist", "cursor-session-start.js")}`,
    args: [],
  };
}
