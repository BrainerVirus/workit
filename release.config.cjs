module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli" }],
    // prepareCmd runs after all version bumps, before the publish phase: rewrite
    // workspace:* core deps to the released version or packed tarballs drop the
    // core dependency (verified: bun publish does NOT rewrite the protocol).
    ["@semantic-release/exec", { prepareCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts" }],
    "@semantic-release/github",
  ],
};
