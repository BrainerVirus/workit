#!/usr/bin/env bun
// Release-sync before publish: rewrite workspace:* core deps to ^<released
// version> in the platform packages, and mirror the core version + canonical
// URLs into the cursor plugin/marketplace manifests. Neither npm nor bun
// rewrites workspace:*, so a packed tarball with it silently drops the core
// dependency. Runs as semantic-release prepareCmd (after the version bumps,
// before the npm publish phase); the writes stay in CI and never reach the
// repo (semantic-release does not commit back).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, "..", "..", "..");
const core = JSON.parse(readFileSync(resolve(root, "packages/workit-core/package.json"), "utf8"));
if (!core.version || typeof core.version !== "string") {
  throw new Error(`workit-core version missing in ${resolve(root, "packages/workit-core/package.json")}`);
}
for (const pkg of ["workit-opencode", "workit-cursor", "workit-cli"]) {
  const file = resolve(root, `packages/${pkg}/package.json`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  const dep = data.dependencies?.["@brainervirus/workit-core"];
  if (dep === undefined) continue;
  data.dependencies["@brainervirus/workit-core"] = `^${core.version}`;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
for (const file of [
  resolve(root, "packages/workit-cursor/.cursor-plugin/plugin.json"),
  resolve(root, "packages/workit-cursor/marketplace.json"),
]) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.version = core.version;
  if (data.homepage) data.homepage = data.homepage.replace("BrainerVirus/workflow-toolkit", "BrainerVirus/workit");
  if (data.repository) data.repository = data.repository.replace("BrainerVirus/workflow-toolkit", "BrainerVirus/workit");
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
