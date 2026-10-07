// Registration merge helpers for the OpenCode/Cursor installers (RR-06).
// Pure functions: accept the existing user config, return the deduplicated
// config PLUS the explicit list of keys changed. Unrelated user settings are
// never rewritten — their values round-trip JSON-identical. The install
// scripts (`packages/workit-core/scripts/install-*-plugin.sh`) import these so
// there is exactly one source of truth for registration merging.
import path from "node:path";

/** Canonical published OpenCode plugin identity (OpenCode resolves from npm). */
export const OPENCODE_NPM_PIN = "@brainervirus/workit-opencode";

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
    /\/(?:packages\/workit-(?:opencode|cursor)|node_modules\/@brainervirus\/workit-(?:opencode|cursor))(?:\/|$)/.test(
      s,
    );
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
  const servers = isRecord(base.mcpServers) ? { ...base.mcpServers } : {};
  delete servers["workflow-toolkit"]; // legacy duplicate registration
  servers[serverName] = server;
  const changed = JSON.stringify(servers) !== JSON.stringify(base.mcpServers) ? ["mcpServers"] : [];
  base.mcpServers = servers;
  return { config: base, changed };
}

/** Swap the sessionStart hook command and normalize the workit-owned events to
 *  canonical (missing or divergent entries, including a legacy
 *  `failClosed: true`, are rewritten so the installer heals exactly what the
 *  doctor flags). Other hooks and fields are preserved. With `pluginDir` (a
 *  local install) the entries carry the absolute launcher path, so they do not
 *  depend on Cursor expanding `${CURSOR_PLUGIN_ROOT}`. */
export function mergeCursorHooks(
  hooks: unknown,
  sessionStartEntry: Record<string, unknown>,
  pluginDir?: string,
): MergeResult<Record<string, unknown>> {
  const base: Record<string, unknown> = isRecord(hooks) ? { ...hooks } : { version: 1 };
  const hooksMap = isRecord(base.hooks) ? { ...base.hooks } : {};
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
  for (const event of CURSOR_HOOK_EVENTS) {
    const canonical = canonicalHookEntry(event, pluginDir);
    const current = hooksMap[event];
    if (
      !Array.isArray(current) ||
      current.length !== 1 ||
      JSON.stringify(current[0]) !== JSON.stringify(canonical)
    ) {
      hooksMap[event] = [canonical];
      changed.push(`hooks.${event}`);
    }
  }
  base.hooks = hooksMap;
  return { config: base, changed };
}

/**
 * Canonical selector for the Cursor MCP server's npm runtime: `@latest` with
 * `--prefer-online` (README "Update review"). `--min-release-age=0` works
 * around npm/cli#9765, where npx ignores the user's scoped release-age
 * exclusion. Hooks never use it: they go through the pinned launcher below.
 */
export const CURSOR_RUNTIME_PACKAGE = "@brainervirus/workit-cursor@latest";

/**
 * Cursor hook launcher (`packages/workit-cursor/hooks/launch.mjs`, committed
 * plain JS so a Marketplace git checkout runs it unbuilt). It prefers the
 * plugin's bundled dist, then a global `workit-cursor-*` bin, then npx pinned
 * to the plugin's own version with `--prefer-offline`; it never resolves
 * `@latest`, and it fails open on any launcher or infrastructure failure.
 *
 * The shipped manifest addresses it through `${CURSOR_PLUGIN_ROOT}` (all a
 * Marketplace install can do); a local install (`workit init`,
 * install-cursor-plugin.sh) writes the absolute path instead.
 */
export const cursorHookLauncher = (pluginDir?: string): string =>
  pluginDir
    ? `node "${path.join(pluginDir, "hooks", "launch.mjs")}"`
    : 'node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs"';

/**
 * Canonical Cursor hook command (single source of truth for the shipped
 * hooks-cursor.json, the installer merge, and the doctor drift check).
 */
export const CURSOR_HOOK_RUN_COMMAND = `${cursorHookLauncher()} workit-cursor-hook`;

/**
 * preToolUse matcher covering every name the hook's write-tool guard treats
 * as a write (see CURSOR_WRITE_TOOL_NAMES in the Cursor hook). A narrower
 * installed matcher lets write tools bypass enforcement silently.
 */
export const CURSOR_PRETOOLUSE_MATCHER =
  "Write|Edit|Delete|Shell|Remove|ApplyPatch|Apply_Patch|Patch|Rename|Mkdir|Mv|Cp|Touch";

/** Workit-owned Cursor events besides sessionStart, in manifest order. */
const CURSOR_HOOK_EVENTS = [
  "preToolUse",
  "beforeShellExecution",
  "subagentStart",
  "subagentStop",
  "preCompact",
] as const;

type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];

/**
 * `failClosed: false` on every event. Cursor's failClosed cannot tell a
 * launcher failure (offline npx, crash, timeout) from a policy decision, so
 * fail-closed would brick every shell command and edit when the runtime is
 * unreachable. Policy denials still block: the hook answers Cursor's deny JSON
 * with exit 2, which Cursor honors regardless of failClosed. The trade-off: a
 * broken runtime means no Workit enforcement (host permissions still apply).
 */
const canonicalHookEntry = (
  event: CursorHookEvent,
  pluginDir?: string,
): Record<string, unknown> => {
  const command = `${cursorHookLauncher(pluginDir)} workit-cursor-hook`;
  return event === "preToolUse"
    ? { command, matcher: CURSOR_PRETOOLUSE_MATCHER, failClosed: false }
    : { command, failClosed: false };
};

/**
 * Drift between an installed hooks file and the canonical event entries.
 * Only present-but-divergent entries count: absent events are filled in by
 * the installer merge on the next run, and minimal installs predate them. A
 * legacy `failClosed: true` is drift: it turns an offline runtime into a
 * blanket deny. With `pluginDir`, the absolute launcher form a local install
 * writes is canonical too.
 */
export function cursorHookDrift(installed: unknown, pluginDir?: string): string[] {
  if (!isRecord(installed) || !isRecord(installed.hooks)) return ["hooks file is not a hook map"];
  const hooks = installed.hooks;
  const drift: string[] = [];
  for (const event of CURSOR_HOOK_EVENTS) {
    const list = hooks[event];
    if (list === undefined) continue;
    const canonical = canonicalHookEntry(event);
    const commands = [canonical.command];
    if (pluginDir) commands.push(canonicalHookEntry(event, pluginDir).command);
    const entry = Array.isArray(list) ? list[0] : undefined;
    if (
      !isRecord(entry) ||
      !commands.includes(entry.command) ||
      entry.failClosed === true ||
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
      "--min-release-age=0",
      `--package=${CURSOR_RUNTIME_PACKAGE}`,
      "workit-cursor-mcp",
      "${workspaceFolder}",
    ],
  };
}

/**
 * Cursor sessionStart hook entry (CA-17): a single command string in Cursor's
 * documented format (no args array), through the pinned launcher. Without a
 * plugin dir it is the portable `${CURSOR_PLUGIN_ROOT}` form; with one, the
 * absolute form a local install writes.
 */
export function cursorHooksEntry(pluginDir?: string): {
  command: string;
  args: string[];
} {
  return { command: `${cursorHookLauncher(pluginDir)} workit-cursor-session-start`, args: [] };
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
