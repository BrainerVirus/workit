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
import { LOADED_TIMEOUT_MS } from "../test/shared/timeouts";

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

// Every run gets LOADED_TIMEOUT_MS per test instead of bun's 5 s default:
// spawn- and git-heavy tests timed out at 5 s when files shared the machine,
// in CI shards (2026-10-28) and in local full runs (2026-11-04, #415). Windows
// shards get the same 15 s (3x bun's default for a ~3x slower runner); a file
// that needs more sets `setDefaultTimeout(spawnHeavyTimeout())`
// (test/shared/timeouts.ts), which wins over this flag. A `--timeout` passed
// to a tier wins too.
const timeoutFlag = (args: readonly string[]): string[] =>
  args.some((arg) => arg.startsWith("--timeout")) ? [] : [`--timeout=${LOADED_TIMEOUT_MS}`];

// Each CI leg's tests, and whether its shard's files run across workers
// (`bun test --parallel`). Ubuntu and macOS do: on Bun 1.4.4 they finish in
// about half the time. Windows stays serial: in parallel its spawn-heavy
// tests timed out at 15 s for a small gain. (On Bun 1.4.1 workers could spin
// forever with an unreaped child, #415.)
const LEGS = {
  ubuntu: {
    select: PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`),
    parallel: true,
  },
  macos: { select: ["./test/workit-core", "./test/artifacts"], parallel: true },
  windows: { select: ["./test/workit-core", "./test/artifacts"], parallel: false },
} as const;

const bunTest = (args: string[]): number =>
  spawnSync("bun", ["test", ...args], { stdio: "inherit" }).status ?? 1;

// bun picks this shard's files, balanced by the per-file durations in
// test/timings/<leg>.json, then rewrites that file with what this shard
// measured; CI uploads it so the committed timings can be refreshed.
/** The `bun test` arguments for one CI shard; null for an unknown leg or a bad spec. */
export function ciShardArgs(leg: string | undefined, spec: string | undefined): string[] | null {
  const config = LEGS[leg as keyof typeof LEGS];
  if (!config || !/^\d+\/\d+$/.test(spec ?? "")) return null;
  return [
    `--shard=${spec}`,
    `--timings=test/timings/${leg}.json`,
    "--update-timings",
    // Serial legs isolate each file too (--parallel implies it): without it a
    // file's process.env, cwd and globals leaked into every later file of the
    // shard, which failed unrelated Windows tests by shard order.
    ...(config.parallel ? ["--parallel"] : ["--isolate"]),
    `--timeout=${LOADED_TIMEOUT_MS}`,
    ...config.select,
  ];
}

/** The `bun test` arguments for a local tier; every file runs isolated unless the caller picked a mode. */
export function tierArgs(tier: "unit" | "packaging", rest: readonly string[]): string[] {
  const selection =
    tier === "packaging"
      ? PACKAGING.map((pattern) => `./${pattern.replace(/\/\*\*$/, "")}`)
      : PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`);
  const chosen = rest.some((arg) => arg.startsWith("--parallel") || arg.endsWith("isolate"));
  return [...selection, ...(chosen ? [] : ["--isolate"]), ...timeoutFlag(rest), ...rest];
}

export const CI_LEGS = Object.keys(LEGS);

if (import.meta.main) {
  const [tier, ...rest] = process.argv.slice(2);
  if (tier === "ci") {
    const args = ciShardArgs(rest[0], rest[1]);
    if (!args) {
      console.error(`usage: bun scripts/test.ts ci <${CI_LEGS.join("|")}> <i>/<n>`);
      process.exit(2);
    }
    process.exit(bunTest(args));
  }
  if (tier !== "unit" && tier !== "packaging") {
    console.error("usage: bun scripts/test.ts <unit|packaging> [bun test args]");
    console.error("       bun scripts/test.ts ci <ubuntu|macos|windows> <i>/<n>");
    process.exit(2);
  }
  process.exit(bunTest(tierArgs(tier, rest)));
}
