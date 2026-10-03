// Lenient field readers for native hook payloads (D17): unknown keys are
// ignored, and only the keys a mapping needs are checked.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export const optionalText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** The canonical path of an existing absolute directory, or null. */
export const existingDirectory = (value: unknown): string | null => {
  if (!nonEmpty(value) || !path.isAbsolute(value) || !existsSync(value)) return null;
  try {
    return statSync(value).isDirectory() ? realpathSync(value) : null;
  } catch {
    return null;
  }
};
