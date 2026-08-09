#!/usr/bin/env bun
// Rewrite workspace:* core deps to ^<released version> in the platform packages
// before publish: neither npm nor bun rewrites the protocol, so a packed tarball
// with workspace:* silently drops the core dependency. Runs as semantic-release
// prepareCmd (after the version bumps, before the npm publish phase).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, "..", "..", "..");
const core = JSON.parse(readFileSync(resolve(root, "packages/workit-core/package.json"), "utf8"));
for (const pkg of ["workit-opencode", "workit-cursor", "workit-cli"]) {
  const file = resolve(root, `packages/${pkg}/package.json`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.dependencies?.["@brainervirus/workit-core"] !== "workspace:*") continue;
  data.dependencies["@brainervirus/workit-core"] = `^${core.version}`;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
