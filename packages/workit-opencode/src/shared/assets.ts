import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of the module doing the lookup: a source file under `src/...`
 * when the checkout pins are loaded, the bundle itself for `dist/plugin.js`.
 * Resolved to the canonical path so tmpdir aliasing (`/var` vs
 * `/private/var` on macOS, 8.3 short names on Windows) cannot split the
 * reported asset locations from the caller's spelling. */
const moduleDir = (): string => {
  try {
    return realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
};

/**
 * Resolve the workit-opencode package root from both layouts. Source modules
 * live one or two levels under the package (`src/plugin.ts`,
 * `src/v2/plugin.ts`); the bundle lives in `dist/`. The nearest ancestor with
 * a package.json wins, so a relative `import.meta.url` change from moving a
 * source file can never silently point assets at the wrong directory.
 */
export const packageRoot = (): string => {
  const dir = moduleDir();
  for (const candidate of [
    path.resolve(dir, ".."),
    path.resolve(dir, "..", ".."),
    path.resolve(dir, "..", "..", ".."),
  ]) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return path.resolve(dir, "..");
};

/**
 * The method skills directory. A built or installed package has its generated
 * copy in `assets/skills`; a source checkout loaded as a local pin has no
 * copy (it is git-ignored), so it reads the canonical
 * `packages/workit-core/skills` beside it, which the build would copy anyway.
 */
export const skillsRoot = (): string => {
  const packaged = path.join(packageRoot(), "assets", "skills");
  if (existsSync(packaged)) return packaged;
  const canonical = path.resolve(packageRoot(), "..", "workit-core", "skills");
  return existsSync(canonical) ? canonical : packaged;
};
