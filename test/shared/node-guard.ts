// bun test preload (bunfig.toml): the suite spawns the real `node` on PATH for
// packed adapters, doctor and installers, and those fail in confusing ways on
// an older runtime. Stop before any test runs with one clear message instead.
// (Bun reports its own process.versions.node, so ask the PATH binary.)
import { spawnSync } from "node:child_process";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";

const required = Number(SUPPORT_MATRIX.node.minimum);
const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
const found = probe.status === 0 ? probe.stdout.trim() : null;
const major = Number(/^v(\d+)\./.exec(found ?? "")?.[1] ?? 0);
if (major < required) {
  console.error(
    `workit tests need Node ${required}+ on PATH (found ${found ?? "no node"}); ` +
      `switch first, e.g. \`fnm use ${SUPPORT_MATRIX.node.current}\`.`,
  );
  process.exit(1);
}
