// Declared support matrix for published Workit artifacts (RR-10/PT-11/PT-12).
// Single source of truth for the pinned toolchain and host versions; the CI
// workflow, package engines, and lockfiles must stay in sync (enforced by
// test/artifacts/manifests.test.ts and test/artifacts/packed-runtime.test.ts).
// Deno is intentionally not part of the matrix (PT-12): nothing advertises a
// host that has no executable artifact/test evidence.
export const SUPPORT_MATRIX = {
  bun: "1.4.1",
  node: { minimum: "24", current: "24.20.0" },
  // The object-form dual entry (server() + setup()) only loads from
  // 1.18.29+; the supported floor is 1.18.30 so no host can pass doctor while
  // being unable to load the entry shape.
  opencode: { minimum: "1.18.30", current: "1.18.30" },
  // Codex is a qualification host, not a runtime dependency: the CLI version
  // below is the one live qualification evidence covers. The doctor warns when
  // an installed CLI drifts ahead so a fresh install never silently outruns
  // the qualification pin.
  codex: { cli: "0.153.4", desktopPackage: "26.901.20858", bundledCodexCli: "0.153.0-alpha.5" },
  os: ["ubuntu-latest", "macos-latest", "windows-latest"],
} as const;
