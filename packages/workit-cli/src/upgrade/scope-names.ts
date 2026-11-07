// Package names on the old and the new npm scope (dependency-free: the
// doctor reads them too). Workit moved from @brainervirus/workit-<name> to
// @workit-dev/<name>; the 14.x bridge's `workit upgrade` moves every install.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type HostId } from "../admin/detect-hosts";

export const LEGACY_SCOPE = "@brainervirus";
export const NEW_SCOPE = "@workit-dev";
/** The new scope's first real release; anything below is a placeholder (0.0.x). */
export const NEW_SCOPE_FLOOR = "1.0.0";
/** The plan row that names the move. */
export const SCOPE_ROW = "migrate scope";

export type ScopedName = HostId | "cli" | "core" | "mcp";
export const legacyPackage = (name: ScopedName): string => `${LEGACY_SCOPE}/workit-${name}`;
export const newPackage = (name: ScopedName): string => `${NEW_SCOPE}/${name}`;

/** Runs the bridge (old scope's latest), which migrates every host. */
export const SCOPE_FIX = `npx -y ${legacyPackage("cli")}@latest upgrade --yes`;

/** Which scope a package name (or an `npm:`/`@version` selector of one) belongs to. */
export const scopeOf = (selector: string): "legacy" | "new" | null => {
  const name = selector.replace(/^npm:/, "");
  if (name.startsWith(`${LEGACY_SCOPE}/workit-`)) return "legacy";
  if (name.startsWith(`${NEW_SCOPE}/`)) return "new";
  return null;
};

/** The package name a host plugin directory holds (its package.json), or null. */
export const packageNameAt = (dir: string): string | null => {
  try {
    const name: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
};

/** `@brainervirus/workit-opencode[@latest]` -> `@workit-dev/opencode[@latest]`; an exact pin is not moved. */
export const movedOpencodePin = (pin: string): string | null => {
  const match = /^(npm:)?@brainervirus\/workit-opencode(@latest)?$/.exec(pin);
  return match ? `${match[1] ?? ""}${newPackage("opencode")}${match[2] ?? ""}` : null;
};

/** The new-scope source Pi installs for an old floating one. */
export const movedPiSource = (): string => `npm:${newPackage("pi")}`;
