// The `updates` setting and the launch-check cache. Local files only, so
// doctor reads them without the launch check's prompt, styles and runners.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir } from "@brainervirus/workit-core/src/core/heavy-words";
import {
  isConfigObject,
  isUpdatesMode,
  type UpdatesMode,
} from "@brainervirus/workit-core/src/core/config";

/** Workit's global config dir, resolved the way `workit upgrade` resolves it. */
export const workitConfigDir = (env: NodeJS.ProcessEnv): string =>
  env.WORKFLOW_TOOLKIT_CONFIG ??
  env.WORKFLOW_TOOLKIT_CONFIG_DIR ??
  path.join(env.XDG_CONFIG_HOME || path.join(env.HOME ?? os.homedir(), ".config"), "workit");

export type UpdateCache = {
  /** When the registry was last asked (a failed lookup counts: offline stays quiet). */
  checkedAt?: number;
  /** The newest published CLI version, when the last lookup succeeded. */
  latest?: string;
  /** "Never for this version": silent until a newer one is published. */
  skipped?: string;
  /** "Skip for now": silent until the TTL passes. */
  snoozedAt?: number;
};

const cacheFile = (env: NodeJS.ProcessEnv, dir = stateDir(env)): string =>
  path.join(dir, "update-check.json");

/** The cache, or {} when missing or unreadable; `dir` overrides Workit state (doctor's). */
export const readUpdateCache = (env: NodeJS.ProcessEnv, dir?: string): UpdateCache => {
  try {
    const data: unknown = JSON.parse(readFileSync(cacheFile(env, dir), "utf8"));
    return isConfigObject(data) ? (data as UpdateCache) : {};
  } catch {
    return {};
  }
};

/** Best effort: an unwritable state dir only means the check repeats. */
export const writeUpdateCache = (env: NodeJS.ProcessEnv, cache: UpdateCache): void => {
  try {
    const file = cacheFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(cache) + "\n", "utf8");
    renameSync(temp, file);
  } catch {
    // silent by design
  }
};

const configFile = (env: NodeJS.ProcessEnv, dir = workitConfigDir(env)): string =>
  path.join(dir, "config.json");

/** The global `updates` setting; a missing, malformed or unknown value is `prompt`. */
export const readUpdatesMode = (env: NodeJS.ProcessEnv, dir?: string): UpdatesMode => {
  try {
    const data = JSON.parse(readFileSync(configFile(env, dir), "utf8")) as {
      updates?: unknown;
    };
    return isConfigObject(data) && isUpdatesMode(data.updates) ? data.updates : "prompt";
  } catch {
    return "prompt";
  }
};

/** Set `updates` in config.json, keeping every other key. Returns an error text or null. */
export const writeUpdatesMode = (env: NodeJS.ProcessEnv, mode: UpdatesMode): string | null => {
  const file = configFile(env);
  let data: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isConfigObject(parsed)) return `${file} is not a JSON object`;
    data = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `${file} is not valid JSON`;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...data, updates: mode }, null, 2) + "\n", "utf8");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `cannot write ${file}`;
  }
};
