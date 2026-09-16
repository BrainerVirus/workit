import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Files whose later modification means the live process is running stale
 * workit code. Resolved from this module so both the source and bundled plugin
 * layouts point at the same core sources. */
export const pluginSourceFiles = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./plugin.ts", import.meta.url)),
  fileURLToPath(new URL("./tools/workit.ts", import.meta.url)),
  ...[
    "task-contract.ts",
    "task-engine.ts",
    "task-evaluation.ts",
    "task-store.ts",
    "workers.ts",
    "authority.ts",
    "methods.ts",
  ].map((file) => fileURLToPath(new URL(`../../workit-core/src/core/${file}`, import.meta.url))),
].filter((file) => existsSync(file));
