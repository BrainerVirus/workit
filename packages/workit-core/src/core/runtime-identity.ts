import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** sha256 of the exact bytes, lowercase hex. */
export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** sha256 of a bundle file's bytes, or null when it cannot be read. */
export const bundleHashOfFile = (file: string): string | null => {
  try {
    return sha256Hex(readFileSync(file));
  } catch {
    return null;
  }
};

// Package-manager ephemeral caches, anchored to each one's layout so a `_npx`
// or `dlx` directory anywhere else is never taken for one: npx's
// `<npm cache>/_npx/<hash>/` (the cache is ~/.npm, %LocalAppData%\npm-cache or
// $npm_config_cache), pnpm's `<pnpm cache>/dlx/<key>/` (~/.cache/pnpm,
// ~/Library/Caches/pnpm, %LocalAppData%\pnpm-cache or $XDG_CACHE_HOME/pnpm)
// and pacquet's ~/.pacquet. Installs resolving through these break when the
// cache is cleared; one table here replaces the per-callsite substring lists.
const EPHEMERAL_CACHE_LAYOUTS = [
  /(?:^|\/)(?:\.npm|npm-cache)\/_npx\/[0-9a-f]+\//,
  /(?:^|\/)(?:\.cache|caches)\/pnpm\/dlx\/[^/]+\//,
  /(?:^|\/)pnpm-cache\/dlx\/[^/]+\//,
  /(?:^|\/)\.pacquet\//,
];

const normalize = (entry: string): string => entry.replaceAll("\\", "/").toLowerCase();

/** True when `normalized` holds `<dir>/<child>/<key>/` for a cache dir the env configures. */
const underConfigured = (
  normalized: string,
  dir: string | undefined,
  child: string,
  key: RegExp,
) => {
  if (!dir) return false;
  const prefix = `${normalize(dir).replace(/\/+$/, "")}/${child}/`;
  const at = normalized.indexOf(prefix);
  return at >= 0 && key.test(normalized.slice(at + prefix.length));
};

/** True when the entry resolves through a package-manager ephemeral cache. */
export const isEphemeralCachePath = (
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!entry) return false;
  const normalized = normalize(entry);
  return (
    EPHEMERAL_CACHE_LAYOUTS.some((layout) => layout.test(normalized)) ||
    underConfigured(normalized, env.npm_config_cache, "_npx", /^[0-9a-f]+\//) ||
    underConfigured(
      normalized,
      env.XDG_CACHE_HOME && `${env.XDG_CACHE_HOME}/pnpm`,
      "dlx",
      /^[^/]+\//,
    )
  );
};
