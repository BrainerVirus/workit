#!/usr/bin/env bun
// Test tiers. `bun run test` runs the fast domain/unit tier; `bun run
// test:packaging` runs the suites that pack tarballs, run npm/Pi installs,
// drive doctor against installed artifacts, or need docker. Packaging suites
// build what they pack (packWorkspacePackages builds every adapter into a
// sandbox), so neither tier needs `bun run build` first. Plain `bun test`
// still runs everything. Extra arguments pass through to `bun test`.
import { spawnSync } from "node:child_process";
import path from "node:path";

const PACKAGING = [
  "test/artifacts/**",
  "test/opencode-v2/contract.test.ts",
  "test/opencode-v2/lifecycle.test.ts",
  "test/opencode-v2/matrix.test.ts",
  "test/workit-cli/doctor.test.ts",
  "test/workit-cli/packed-cli.test.ts",
  "test/workit-cli/platform-install.test.ts",
  "test/workit-codex/packed-launcher.test.ts",
  "test/workit-core/doctor.test.ts",
  "test/workit-core/install-scripts.test.ts",
  "test/workit-pi/stock-pi.test.ts",
];

const [tier, ...rest] = process.argv.slice(2);
if (tier !== "unit" && tier !== "packaging") {
  console.error("usage: bun scripts/test.ts <unit|packaging> [bun test args]");
  process.exit(2);
}
const selection =
  tier === "packaging"
    ? PACKAGING.map((pattern) => `./${pattern.replace(/\/\*\*$/, "")}`)
    : PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`);
// `bun run` prepends node_modules/.bin to PATH, which exposes the repo's own
// npm dependency as `npm` to host-install code under test. Give the suite the
// same PATH a direct `bun test` sees.
const PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir))
  .join(path.delimiter);
const run = spawnSync("bun", ["test", ...selection, ...rest], {
  stdio: "inherit",
  env: { ...process.env, PATH },
});
process.exit(run.status ?? 1);
