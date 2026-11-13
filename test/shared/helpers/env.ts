import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";

/**
 * What a child keeps when a test strips WORKIT_* from its env: the run marker,
 * so the child's grants and seal stay in the run's temp account home and its
 * writes to the real home's host settings are refused (#859). The children
 * that strip get a temp HOME or WORKIT_STATE_DIR of their own.
 */
const RUN_ISOLATION_KEYS: ReadonlySet<string> = new Set(["WORKIT_TEST_RUN"]);

/** Whether a test that strips Workit's env from a child drops `key` (never the run marker). */
export const stripsWorkitKey = (key: string): boolean =>
  key.startsWith("WORKIT_") && !RUN_ISOLATION_KEYS.has(key);

// WORKIT_CONFIG -> dir; restored afterwards; dir removed.
export const withIsolatedConfig = (dir: string, fn: () => void) => {
  const previous = process.env.WORKIT_CONFIG;
  process.env.WORKIT_CONFIG = dir;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.WORKIT_CONFIG;
    else process.env.WORKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

// Temp dir as WORKIT_CONFIG; restored afterwards; dir removed.
export const withTempConfigDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-config-"));
  withIsolatedConfig(dir, () => fn(dir));
};

let node24Bin: string | null = null;

// Prepend a node shim that reports the declared support-matrix current version.
export const envWithSupportedNode = (base: Record<string, string> = {}): Record<string, string> => {
  if (!node24Bin) {
    node24Bin = mkdtempSync(path.join(os.tmpdir(), "wk-node24-bin-"));
    const realNode =
      spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim() || "node";
    writeFileSync(
      path.join(node24Bin, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${SUPPORT_MATRIX.node.current}"; exit 0; fi\nexec ${JSON.stringify(realNode)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const pathPrefix = base.PATH ?? process.env.PATH ?? "";
  return { ...process.env, ...base, PATH: `${node24Bin}:${pathPrefix}` };
};
