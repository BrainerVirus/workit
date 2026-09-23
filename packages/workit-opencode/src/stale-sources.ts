import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./shared/assets";

const typescriptFiles = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(file)
      : entry.isFile() && file.endsWith(".ts")
        ? [file]
        : [];
  });
};

/** All TypeScript sources loaded by a development checkout. Installed bundles
 * retain the current module marker and simply have no source tree to scan. */
export const pluginSourceFiles = [
  ...new Set([
    fileURLToPath(import.meta.url),
    ...typescriptFiles(path.join(packageRoot(), "src")),
    path.join(packageRoot(), "..", "workit-core", "src", "core.ts"),
    ...typescriptFiles(path.join(packageRoot(), "..", "workit-core", "src", "core")),
  ]),
]
  .filter((file) => existsSync(file))
  .sort();
