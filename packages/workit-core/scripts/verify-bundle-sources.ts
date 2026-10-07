#!/usr/bin/env bun
// Release guard: every adapter dist/ must inline the workspace's own
// @brainervirus sources, never a registry copy. bun build resolves the nearest
// node_modules first, so an installed packages/<pkg>/node_modules/@brainervirus
// copy silently replaces the tagged source (8.0.0 shipped 7.7.0's core that
// way). bun prefixes each inlined module with a `// <path>` header; a header
// under node_modules/@brainervirus/ names a stale copy. Runs after the
// prepare-time build, before publish, and in the release-candidate gate.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RELEASE_PACKAGES } from "./analyze-release-scope";

const REGISTRY_COPY = /^\/\/ (\S*node_modules\/@brainervirus\/\S+)$/gmu;

function bundles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) return bundles(file);
    return name.endsWith(".js") ? [file] : [];
  });
}

/** Built adapter bundles under `root`, and the registry-copy modules each inlines. */
export function bundleSources(root: string): {
  scanned: string[];
  stale: Array<{ bundle: string; modules: string[] }>;
} {
  const scanned = RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-core").flatMap((pkg) =>
    bundles(join(root, "packages", pkg, "dist")),
  );
  const stale = scanned.flatMap((file) => {
    const modules = [...readFileSync(file, "utf8").matchAll(REGISTRY_COPY)].map((m) => m[1]);
    return modules.length ? [{ bundle: relative(root, file), modules }] : [];
  });
  return { scanned: scanned.map((file) => relative(root, file)), stale };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { scanned, stale } = bundleSources(root);
  if (scanned.length === 0) {
    console.error(`no adapter bundles under ${root}/packages/*/dist; run \`bun run build\` first`);
    process.exit(1);
  }
  if (stale.length) {
    console.error("adapter bundles inline a registry copy of a workspace package, not its source:");
    for (const { bundle, modules } of stale)
      console.error(`  - ${bundle}: ${modules.length} modules, e.g. ${modules[0]}`);
    console.error(
      "remove packages/*/node_modules/@brainervirus and rebuild; see release.yml NPM_CONFIG_WORKSPACES_UPDATE",
    );
    process.exit(1);
  }
  console.log(`verified ${scanned.length} adapter bundles inline workspace sources`);
}
