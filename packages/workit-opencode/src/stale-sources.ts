import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./shared/assets";

/** Files whose later modification means the live process is running stale
 * workit code. Resolved through the layout-stable package root so both the
 * source modules and the bundled plugin watch the same core sources. */
const packageFiles = [
  "src/index.ts",
  "src/plugin.ts",
  "src/v1/server.ts",
  "src/v2/plugin.ts",
  "src/shared/tools.ts",
  "src/tools/workit.ts",
].map((file) => path.join(packageRoot(), file));

const coreDir = path.join(packageRoot(), "..", "workit-core", "src", "core");

export const pluginSourceFiles = [
  fileURLToPath(import.meta.url),
  ...packageFiles,
  ...[
    "task-contract.ts",
    "task-engine.ts",
    "task-evaluation.ts",
    "task-store.ts",
    "workers.ts",
    "authority.ts",
    "methods.ts",
  ].map((file) => path.join(coreDir, file)),
].filter((file) => existsSync(file));
