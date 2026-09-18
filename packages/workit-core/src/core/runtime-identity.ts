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

// Segments of package-manager ephemeral caches (pnpm dlx, npx, pacquet).
// Installs resolving through these break when the cache is cleared; one
// table here replaces the per-callsite substring lists.
const EPHEMERAL_CACHE_SEGMENTS = [
  "/caches/pnpm/dlx/",
  "/.cache/pnpm/dlx/",
  "/_npx/",
  "/.pacquet/",
  "/library/caches/pnpm/",
];

/** True when the entry resolves through a package-manager ephemeral cache. */
export const isEphemeralCachePath = (entry: string): boolean => {
  if (!entry) return false;
  const normalized = entry.replaceAll("\\", "/").toLowerCase();
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => normalized.includes(segment));
};
