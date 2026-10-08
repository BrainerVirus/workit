#!/usr/bin/env bun
// Test tiers. `bun run test` runs the fast domain/unit tier; `bun run
// test:packaging` runs the suites that pack tarballs, run npm/Pi installs,
// drive doctor against installed artifacts, or need docker. Packaging suites
// build what they pack (packWorkspacePackages builds every adapter into a
// sandbox), so neither tier needs `bun run build` first. Plain `bun test`
// still runs everything. Extra arguments pass through to `bun test`.
//
// `shard <i>/<n> <dir...>` runs one CI shard of the test files under the given
// directories (the macOS and Windows legs of .github/workflows/ci.yml).
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

// Measured file durations on windows-latest (seconds, CI run 37716628812).
// Only balances shards: an unlisted or stale entry costs balance, never
// coverage. Unlisted files weigh DEFAULT_WEIGHT (the mean of the rest).
const SHARD_WEIGHTS: Record<string, number> = {
  "test/workit-core/forge.test.ts": 110,
  "test/workit-core/ledger.test.ts": 81,
  "test/artifacts/phase-0-candidate.test.ts": 71,
  "test/workit-core/doctor.test.ts": 65,
  "test/artifacts/packed-runtime.test.ts": 50,
  "test/workit-core/ledger-integrity.test.ts": 47,
  "test/workit-core/event-store.test.ts": 41,
  "test/workit-core/git-rev.test.ts": 29,
  "test/workit-core/pr-create.test.ts": 19,
  "test/workit-core/task-engine.test.ts": 18,
  "test/workit-core/publish-changed-packages.test.ts": 17,
  "test/workit-core/event-store-review.test.ts": 16,
  "test/workit-core/branch-policy.test.ts": 14,
  "test/artifacts/pack-cleanup.test.ts": 14,
  "test/workit-core/revision-retry.test.ts": 14,
  "test/workit-core/payload-replay.test.ts": 12,
  "test/workit-core/hooks/raw-git.test.ts": 12,
  "test/workit-core/analyze-release-scope.test.ts": 10,
  "test/workit-core/protocol-ergonomics.test.ts": 10,
};
const DEFAULT_WEIGHT = 1.6;

// Per-test timeouts. Windows runners run this suite ~3x slower than macOS
// (771 s vs 246 s), so a Windows test gets 3x bun's 5 s default. Files whose
// tests measured over 5 s on Windows and set no per-test or per-file timeout
// of their own keep 60 s; annotating those tests lets a file leave this list.
const WINDOWS_TIMEOUT_MS = 15_000;
const WINDOWS_SLOW_FILES = new Set([
  "test/workit-core/commit-flavor.test.ts",
  "test/workit-core/doctor.test.ts",
  "test/workit-core/git-rev.test.ts",
  "test/workit-core/ledger-integrity.test.ts",
  "test/workit-core/ledger.test.ts",
  "test/workit-core/revision-retry.test.ts",
]);
const WINDOWS_SLOW_TIMEOUT_MS = 60_000;

const bunTest = (args: string[]): number =>
  spawnSync("bun", ["test", ...args], { stdio: "inherit" }).status ?? 1;

const testFiles = (dirs: string[]): string[] =>
  dirs
    .flatMap((dir) =>
      [...new Bun.Glob("**/*.test.ts").scanSync(dir)].map(
        (file) => `${dir.replace(/\/+$/, "")}/${file.replaceAll("\\", "/")}`,
      ),
    )
    .toSorted();

// Longest-processing-time first: each file goes to the lightest shard.
function assignShards(files: string[], count: number): string[][] {
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  const weight = (file: string) => SHARD_WEIGHTS[file] ?? DEFAULT_WEIGHT;
  const ordered = files.toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.load < min.load ? shard : min));
    lightest.load += weight(file);
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files.toSorted());
}

function runShard(spec: string | undefined, dirs: string[]): number {
  const match = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count || dirs.length === 0) {
    console.error("usage: bun scripts/test.ts shard <i>/<n> <dir...>");
    return 2;
  }
  const files = assignShards(testFiles(dirs), count)[index - 1] ?? [];
  console.log(`shard ${index}/${count}: ${files.length} files\n${files.join("\n")}`);
  // `bun test` with no paths would run every test in the repo.
  if (files.length === 0) return 0;
  if (process.platform !== "win32") return bunTest(files.map((file) => `./${file}`));
  const slow = files.filter((file) => WINDOWS_SLOW_FILES.has(file));
  const rest = files.filter((file) => !WINDOWS_SLOW_FILES.has(file));
  // Both groups always run, so one failure never hides the other's.
  const statuses = [
    rest.length ? bunTest([`--timeout=${WINDOWS_TIMEOUT_MS}`, ...rest.map((f) => `./${f}`)]) : 0,
    slow.length
      ? bunTest([`--timeout=${WINDOWS_SLOW_TIMEOUT_MS}`, ...slow.map((f) => `./${f}`)])
      : 0,
  ];
  return statuses.find((status) => status !== 0) ?? 0;
}

if (import.meta.main) {
  const [tier, ...rest] = process.argv.slice(2);
  if (tier === "shard") process.exit(runShard(rest[0], rest.slice(1)));
  if (tier !== "unit" && tier !== "packaging") {
    console.error("usage: bun scripts/test.ts <unit|packaging> [bun test args]");
    console.error("       bun scripts/test.ts shard <i>/<n> <dir...>");
    process.exit(2);
  }
  const selection =
    tier === "packaging"
      ? PACKAGING.map((pattern) => `./${pattern.replace(/\/\*\*$/, "")}`)
      : PACKAGING.map((pattern) => `--path-ignore-patterns=${pattern}`);
  process.exit(bunTest([...selection, ...rest]));
}
