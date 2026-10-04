// Declared support matrix for published Workit artifacts (RR-10/PT-11/PT-12).
// Single source of truth for the pinned toolchain and host versions; the CI
// workflow, package engines, and lockfiles must stay in sync (enforced by
// test/artifacts/manifests.test.ts and test/artifacts/packed-runtime.test.ts).
// Deno is intentionally not part of the matrix (PT-12): nothing advertises a
// host that has no executable artifact/test evidence.
export const SUPPORT_MATRIX = {
  bun: "1.4.1",
  node: { minimum: "24", current: "24.20.0" },
  // OpenCode V2 plugin API only: the entry exports `setup()` (Workit 3.0
  // retired the V1 `server()` adapter), so 1.x hosts cannot load it. 2.0.18 is
  // the `@opencode/plugin` contract the adapter is built and tested against.
  opencode: { minimum: "2.0.18", current: "2.0.18" },
  // Codex is a qualification host, not a runtime dependency: the CLI version
  // below is the one live qualification evidence covers. The doctor warns when
  // an installed CLI drifts ahead so a fresh install never silently outruns
  // the qualification pin.
  codex: { cli: "0.153.4", desktopPackage: "26.901.20858", bundledCodexCli: "0.153.0-alpha.5" },
  // Claude Code is a qualification host too: CI runs `claude plugin validate
  // --strict` with exactly this CLI, and the hook output schema fixture
  // (test/fixtures/claude-code-schemas) was transcribed from this binary.
  claudeCode: { cli: "2.1.288" },
  os: ["ubuntu-latest", "macos-latest", "windows-latest"],
} as const;
