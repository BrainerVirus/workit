// Declared support matrix for published Workit artifacts (RR-10/PT-11/PT-12).
// Single source of truth for the pinned toolchain and host versions; the CI
// workflow, package engines, and lockfiles must stay in sync (enforced by
// test/artifacts/manifests.test.ts and test/artifacts/packed-runtime.test.ts).
// Deno is intentionally not part of the matrix (PT-12): nothing advertises a
// host that has no executable artifact/test evidence.
export const SUPPORT_MATRIX = {
  bun: "1.4.1",
  node: { minimum: "24", current: "24.20.0" },
  opencode: { minimum: "1.15.0", current: "1.18.29" },
  os: ["ubuntu-latest", "macos-latest", "windows-latest"],
} as const;
