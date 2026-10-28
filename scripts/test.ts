#!/usr/bin/env bun
// Test tiers. `bun run test` runs the fast domain/unit tier; `bun run
// test:packaging` runs the suites that pack tarballs, run npm/Pi installs,
// drive doctor against installed artifacts, or need docker. Packaging suites
// build what they pack (packWorkspacePackages builds every adapter into a
// sandbox), so neither tier needs `bun run build` first. Plain `bun test`
// still runs everything. Extra arguments pass through to `bun test`.
//
// `ci <leg> <i>/<n>` runs one shard of a CI leg (.github/workflows/ci.yml).
import { spawnSync } from "node:child_process";

const PACKAGING = [
  "test/artifacts/**",
  "test/opencode-v2/contract.test.ts",
  "test/opencode-v2/lifecycle.test.ts",
  "test/opencode-v2/matrix.test.ts",
  "test/workit-cli/doctor.test.ts",
  "test/workit-cli/packed-cli.test.ts",
  "test/workit-cli/platform-install.test.ts",
  "test/workit-claude-code/packed-plugin.test.ts",
  "test/workit-codex/packed-launcher.test.ts",
  "test/workit-core/cursor-install-mcp.test.ts",
  "test/workit-core/doctor.test.ts",
  "test/workit-core/install-scripts.test.ts",
  "test/workit-pi/stock-pi.test.ts",
];

// Windows runners run this suite ~3x slower than macOS, so a Windows test
// gets 3x bun's 5 s default. A file that needs more sets its own
// `setDefaultTimeout`, which wins over this flag.
const WINDOWS_TIMEOUT_MS = 15_000;

// Each CI leg: the tests it runs, and whether files run across workers.
// Ubuntu runs the unit tier serially: under `bun test --parallel` its CLI
// suites hung with workers spinning on unreaped children (#415). macOS and
// Windows run the core and artifact suites, which pass in parallel.
const LEGS = {
  ubuntu: {
    select: PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`),
    parallel: false,
  },
  macos: { select: ["./test/workit-core", "./test/artifacts"], parallel: true },
  windows: { select: ["./test/workit-core", "./test/artifacts"], parallel: true },
} as const;

const bunTest = (args: string[]): number =>
  spawnSync("bun", ["test", ...args], { stdio: "inherit" }).status ?? 1;

// bun picks this shard's files, balanced by the per-file durations in
// test/timings/<leg>.json, then rewrites that file with what this shard
// measured; CI uploads it so the committed timings can be refreshed.
function runCiShard(leg: string | undefined, spec: string | undefined): number {
  const config = LEGS[leg as keyof typeof LEGS];
  if (!config || !/^\d+\/\d+$/.test(spec ?? "")) {
    console.error(`usage: bun scripts/test.ts ci <${Object.keys(LEGS).join("|")}> <i>/<n>`);
    return 2;
  }
  return bunTest([
    `--shard=${spec}`,
    `--timings=test/timings/${leg}.json`,
    "--update-timings",
    ...(config.parallel ? ["--parallel"] : []),
    ...(process.platform === "win32" ? [`--timeout=${WINDOWS_TIMEOUT_MS}`] : []),
    ...config.select,
  ]);
}

if (import.meta.main) {
  const [tier, ...rest] = process.argv.slice(2);
  if (tier === "ci") process.exit(runCiShard(rest[0], rest[1]));
  if (tier !== "unit" && tier !== "packaging") {
    console.error("usage: bun scripts/test.ts <unit|packaging> [bun test args]");
    console.error("       bun scripts/test.ts ci <ubuntu|macos|windows> <i>/<n>");
    process.exit(2);
  }
  const selection =
    tier === "packaging"
      ? PACKAGING.map((pattern) => `./${pattern.replace(/\/\*\*$/, "")}`)
      : PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`);
  process.exit(bunTest([...selection, ...rest]));
}
