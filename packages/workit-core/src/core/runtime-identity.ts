import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * Self-identifying runtime: sha256 of this module's own running file. In a
 * dev checkout that is the core source; in an installed package it is the
 * shipped bundle — either way the hash names the exact bytes executing,
 * never a version string, pin form, or path spelling.
 */
export const runtimeBundleHash = (): string | null => {
  try {
    return bundleHashOfFile(fileURLToPath(import.meta.url));
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

/** True when the file at `candidate` runs byte-identical code to `source`. */
export const sameBundle = (candidate: string, source: string): boolean => {
  if (!existsSync(candidate) || !existsSync(source)) return false;
  const a = bundleHashOfFile(candidate);
  return a !== null && a === bundleHashOfFile(source);
};
