module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli" }],
    "@semantic-release/github",
  ],
};
