// A Claude Code process loads its plugins once, at start. `/resume` inside it,
// and the subagents it spawns, keep running the hook that was loaded, even
// after a newer Workit plugin version is installed. The running hook knows its
// own plugin dir (`<config>/plugins/cache/<marketplace>/workit/<version>`) and
// the registry (`<config>/plugins/installed_plugins.json`) names the installed
// version: when the running one is older, the agent tells the user once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveStateDir } from "@brainervirus/workit-core/src/core/logger";

const parts = (version: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const newer = (a: string, b: string): boolean => {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The newest installed version beside the running plugin dir, or null (a local pin, no registry). */
export const installedBeside = (root: string): { running: string; installed: string } | null => {
  try {
    const versions = path.dirname(root);
    const plugins = path.dirname(path.dirname(path.dirname(versions)));
    if (path.basename(path.dirname(path.dirname(versions))) !== "cache") return null;
    const running = path.basename(root);
    if (!parts(running)) return null;
    const registry = JSON.parse(
      readFileSync(path.join(plugins, "installed_plugins.json"), "utf8"),
    ) as { plugins?: Record<string, Array<{ installPath?: unknown; version?: unknown }>> };
    let installed: string | null = null;
    for (const entries of Object.values(registry.plugins ?? {}))
      for (const entry of Array.isArray(entries) ? entries : [])
        if (
          typeof entry?.installPath === "string" &&
          typeof entry.version === "string" &&
          path.dirname(entry.installPath) === versions &&
          (installed === null || newer(entry.version, installed))
        )
          installed = entry.version;
    return installed && newer(installed, running) ? { running, installed } : null;
  } catch {
    return null;
  }
};

/**
 * One line, once per session, when the plugin running this hook is older than
 * the installed one. SessionStart and PreToolUse only; the marker is the
 * session's hash under the state dir.
 */
export const stalePluginNotice = (
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  stateDir: () => string = resolveStateDir,
): string | null => {
  const event = payload.hook_event_name;
  const session = payload.session_id;
  const root = env.WORKIT_PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT;
  if ((event !== "SessionStart" && event !== "PreToolUse") || typeof session !== "string" || !root)
    return null;
  // Subagents share the session; the lead's line is enough.
  if (payload.agent_id) return null;
  const stale = installedBeside(root);
  if (!stale) return null;
  try {
    const dir = path.join(stateDir(), "stale-plugin");
    const marker = path.join(
      dir,
      createHash("sha256").update(`${session}\0${stale.installed}`).digest("hex").slice(0, 32),
    );
    if (existsSync(marker)) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, `${stale.running} -> ${stale.installed}\n`);
  } catch {
    // An unwritable state dir only means the line repeats.
  }
  return (
    `Workit: this Claude Code session loaded Workit ${stale.running} but ${stale.installed} is installed. ` +
    "Tell the user to fully quit Claude Code and start `claude --resume <session id>` (not `/resume`, which keeps the old plugin) to load it."
  );
};
