// Per-test budgets for git- and spawn-heavy tests (#415). One place for the
// numbers, so a flake under load is fixed by naming the kind of test, not by a
// magic number in each file.

/** Windows runners run spawn- and git-heavy tests about 3x slower than Linux and macOS. */
export const WINDOWS_SLOWDOWN = 3;

/**
 * The default per-test timeout `bun scripts/test.ts` passes (`--timeout`) to the
 * unit and packaging tiers and to every CI shard: a test that spawns a process
 * or runs git stretches past bun's 5 s default when files share the machine.
 */
export const LOADED_TIMEOUT_MS = 15_000;

/** `ms` on Linux and macOS, `WINDOWS_SLOWDOWN` times `ms` on Windows. */
export const windowsScaled = (ms: number): number =>
  process.platform === "win32" ? ms * WINDOWS_SLOWDOWN : ms;

/**
 * The budget for one test that runs git or spawns several processes (a repo
 * fixture, a CLI child per assertion): 15 s, 45 s on Windows. Pass it as the
 * third argument to `test`, or to `setDefaultTimeout` for a file of them.
 */
export const spawnHeavyTimeout = (): number => windowsScaled(LOADED_TIMEOUT_MS);
