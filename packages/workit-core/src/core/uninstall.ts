// Uninstall planning + apply (Task 8): the exact inverse of the setup/registration
// write set. planUninstall is a pure reader — it classifies the installed state
// and returns the actions apply WOULD perform; applyUninstall dispatches only
// reviewed plan actions, preserves unrelated user config byte-for-byte
// (write-only-if-changed), and never touches ~/.config/workit
// (CA-11, CA-12, CA-13, CA-14). Homes are injectable exactly like setup/doctor
// path options (D-07): tests pass explicit paths and no default ever resolves
// to a real user directory in tests.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorkitPlugin } from "./registration";

export type UninstallHost = "opencode" | "cursor";

export type UninstallAction =
  | { kind: "edit-json-remove"; path: string; detail: string }
  | { kind: "remove-dir"; path: string; detail: string };

export type UninstallHostPlan = {
  host: UninstallHost;
  installed: boolean;
  actions: UninstallAction[];
};

export type UninstallPlan = {
  hosts: UninstallHostPlan[];
};

export type UninstallResultStatus = "removed" | "skipped" | "failed";

export type UninstallResultEntry = {
  host: UninstallHost;
  path: string;
  status: UninstallResultStatus;
  detail?: string;
};

export type UninstallResult = {
  ok: boolean;
  entries: UninstallResultEntry[];
};

/** Injectable homes mirroring setup's ApplySetupOptions subset (D-07). */
export type UninstallPaths = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  opencodeConfig?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
};

type ResolvedUninstall = {
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  cursorPluginDir: string;
};

const resolveUninstallPaths = (options: UninstallPaths = {}): ResolvedUninstall => {
  const home = options.home ?? options.env?.HOME ?? process.env.HOME ?? os.homedir();
  return {
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workit"),
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

type Existing =
  | { kind: "missing" }
  | { kind: "malformed"; error: string }
  | { kind: "record"; value: Record<string, unknown> };

const readJsonRecord = (file: string): Existing => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A read-permission error (EACCES) must not look like a missing file (same
    // disambiguation as setup.ts readExisting): classify it malformed so plan
    // keeps the host installed and apply reports Failed with the path untouched.
    if (existsSync(file)) return { kind: "malformed", error: `${file} is not readable` };
    return { kind: "missing" };
  }
  try {
    const value = JSON.parse(raw);
    return isRecord(value)
      ? { kind: "record", value }
      : { kind: "malformed", error: `${file} is not a JSON object` };
  } catch {
    return { kind: "malformed", error: `${file} is not valid JSON` };
  }
};

// Mirror of mergeCursorEnabledPlugins' strip(): trailing-separator-insensitive
// comparison that guards the filesystem root.
const stripTrailingSep = (p: string): string => {
  const j = path.join(p);
  return path.dirname(j) === j ? j : j.replace(/[\\/]+$/, "");
};

const CURSOR_LEGACY_IDENTITIES = ["workflow-toolkit", "local/workflow-toolkit"];

// Inverse of mergeCursorSettings: drop workit identities from enabled_plugins,
// drop the canonical plugin dir entry from plugin_dirs. Returns the next record
// plus whether anything changed (plan/apply share this so outcomes match).
function cleanCursorSettings(
  settings: Record<string, unknown>,
  pluginDir: string,
): { next: Record<string, unknown>; changed: boolean } {
  const next = { ...settings };
  let changed = false;
  if (isRecord(next.enabled_plugins)) {
    const enabled = { ...(next.enabled_plugins as Record<string, unknown>) };
    for (const identity of ["workit", ...CURSOR_LEGACY_IDENTITIES]) {
      if (identity in enabled) {
        delete enabled[identity];
        changed = true;
      }
    }
    next.enabled_plugins = enabled;
  }
  if (Array.isArray(next.plugin_dirs)) {
    const canonical = stripTrailingSep(pluginDir);
    const kept = (next.plugin_dirs as unknown[])
      .map(String)
      .filter((d) => stripTrailingSep(d) !== canonical);
    if (kept.length !== (next.plugin_dirs as unknown[]).length) {
      next.plugin_dirs = kept;
      changed = true;
    }
  }
  return { next, changed };
}

// Inverse of mergeOpenCodeConfig's plugin registration: remove every workit
// identity from the plugin list.
function cleanOpenCodeConfig(config: Record<string, unknown>): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  const next = { ...config };
  let changed = false;
  if (Array.isArray(next.plugin)) {
    const plugins = (next.plugin as unknown[]).map(String);
    const kept = plugins.filter((p) => !isWorkitPlugin(p));
    if (kept.length !== plugins.length) {
      next.plugin = kept;
      changed = true;
    }
  } else if (typeof next.plugin === "string" && isWorkitPlugin(next.plugin)) {
    delete next.plugin;
    changed = true;
  }
  return { next, changed };
}

// Inverse of mergeCursorMcp: drop the canonical server name and its legacy twin.
function cleanCursorMcp(mcp: Record<string, unknown>): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  const next = { ...mcp };
  let changed = false;
  if (isRecord(next.mcpServers)) {
    const servers = { ...(next.mcpServers as Record<string, unknown>) };
    for (const name of ["workit", "workflow-toolkit"]) {
      if (name in servers) {
        delete servers[name];
        changed = true;
      }
    }
    next.mcpServers = servers;
  }
  return { next, changed };
}

// Shared edit-json-remove executor for plan parity: parse → clean by target →
// report change without writing.
type JsonCleaner = (record: Record<string, unknown>) => {
  next: Record<string, unknown>;
  changed: boolean;
};

const jsonCleanerFor = (target: string, res: ResolvedUninstall): JsonCleaner | null => {
  if (target === res.opencodeConfig) return cleanOpenCodeConfig;
  if (target === res.cursorSettings) return (r) => cleanCursorSettings(r, res.cursorPluginDir);
  if (target === res.cursorMcp) return cleanCursorMcp;
  return null;
};

/** Pure planner: reports the uninstall actions Apply would perform. Reads host
 *  config files but never writes; ~/.config/workit is never an action target. */
export function planUninstall(paths: UninstallPaths = {}): UninstallPlan {
  const res = resolveUninstallPaths(paths);

  const ocExisting = readJsonRecord(res.opencodeConfig);
  const ocDirty =
    ocExisting.kind === "malformed" ||
    (ocExisting.kind === "record" && cleanOpenCodeConfig(ocExisting.value).changed);
  const opencode: UninstallHostPlan = {
    host: "opencode",
    installed: ocDirty,
    actions: ocDirty
      ? [
          {
            kind: "edit-json-remove",
            path: res.opencodeConfig,
            detail: "remove workit plugin entries from opencode.json",
          },
        ]
      : [],
  };

  const settingsExisting = readJsonRecord(res.cursorSettings);
  const mcpExisting = readJsonRecord(res.cursorMcp);
  // A malformed host file is still planned: apply must surface the failure
  // (file untouched) instead of silently pretending the host is clean.
  const settingsDirty =
    settingsExisting.kind === "malformed" ||
    (settingsExisting.kind === "record" &&
      cleanCursorSettings(settingsExisting.value, res.cursorPluginDir).changed);
  const mcpDirty =
    mcpExisting.kind === "malformed" ||
    (mcpExisting.kind === "record" && cleanCursorMcp(mcpExisting.value).changed);
  const dirExists = existsSync(res.cursorPluginDir);
  const actions: UninstallAction[] = [];
  if (settingsDirty) {
    actions.push({
      kind: "edit-json-remove",
      path: res.cursorSettings,
      detail: "remove workit enabled_plugins/plugin_dirs entries from settings.json",
    });
  }
  if (mcpDirty) {
    actions.push({
      kind: "edit-json-remove",
      path: res.cursorMcp,
      detail: "remove the workit MCP server registration from mcp.json",
    });
  }
  if (dirExists) {
    actions.push({
      kind: "remove-dir",
      path: res.cursorPluginDir,
      detail: "delete the local workit plugin directory",
    });
  }
  const cursor: UninstallHostPlan = {
    host: "cursor",
    installed: settingsDirty || mcpDirty || dirExists,
    actions,
  };

  return { hosts: [opencode, cursor] };
}

// CA-14 traversal guard: rm -rf is permitted ONLY on the exact resolved
// canonical <home>/.cursor/plugins/local/workit directory. Any other resolved
// path (symlinked alias, sibling, traversal) fails closed without touching disk.
const canonicalRemoveDirAllowed = (actionPath: string, res: ResolvedUninstall): boolean => {
  const expected = path.resolve(res.cursorPluginDir);
  return (
    actionPath === expected &&
    path.basename(expected) === "workit" &&
    path.basename(path.dirname(expected)) === "local" &&
    path.basename(path.dirname(path.dirname(expected))) === "plugins"
  );
};

const applyEditJsonRemove = (
  target: string,
  cleaner: JsonCleaner,
): { status: UninstallResultStatus; detail?: string } => {
  const existing = readJsonRecord(target);
  if (existing.kind === "malformed") {
    return { status: "failed", detail: `${existing.error} — file untouched` };
  }
  if (existing.kind === "missing") {
    return { status: "skipped", detail: "file already absent" };
  }
  const { next, changed } = cleaner(existing.value);
  // Only-if-changed: byte-preserving when there is nothing to remove.
  if (!changed) return { status: "skipped", detail: "no workit entries present" };
  const serialized = JSON.stringify(next, null, 2) + "\n";
  if (readFileSync(target, "utf8") === serialized) {
    return { status: "skipped", detail: "already clean" };
  }
  try {
    writeFileSync(target, serialized, "utf8");
  } catch (error) {
    return {
      status: "failed",
      detail: `write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { status: "removed" };
};

/** Applies ONLY the reviewed plan actions with the given path options. Each
 *  planned action yields exactly one result entry; malformed host JSON fails
 *  its own action untouched while the remaining actions proceed (CA-13). */
export function applyUninstall(plan: UninstallPlan, paths: UninstallPaths = {}): UninstallResult {
  const res = resolveUninstallPaths(paths);
  const entries: UninstallResultEntry[] = [];
  for (const hostPlan of plan.hosts) {
    for (const action of hostPlan.actions) {
      let status: UninstallResultStatus;
      let detail: string | undefined;
      if (action.kind === "remove-dir") {
        // Resolve before comparing so ".."/symlink tricks can never widen the rm.
        const resolved = path.resolve(action.path);
        if (!canonicalRemoveDirAllowed(resolved, res)) {
          status = "failed";
          detail = `refusing to remove non-canonical plugin directory: ${resolved}`;
        } else if (!existsSync(resolved)) {
          status = "skipped";
          detail = "directory already absent";
        } else {
          try {
            rmSync(resolved, { recursive: true, force: true });
            status = "removed";
          } catch (error) {
            status = "failed";
            detail = error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        const cleaner = jsonCleanerFor(action.path, res);
        if (cleaner === null) {
          status = "failed";
          detail = `${action.path} is not a recognized uninstall target for this host`;
        } else {
          const outcome = applyEditJsonRemove(action.path, cleaner);
          status = outcome.status;
          detail = outcome.detail;
        }
      }
      entries.push({ host: hostPlan.host, path: action.path, status, detail });
    }
  }
  return { ok: entries.every((e) => e.status !== "failed"), entries };
}
