#!/usr/bin/env bun
// Release guard: every adapter dist/ must inline the workspace's own
// @brainervirus sources, never a registry copy. bun build resolves the nearest
// node_modules first, so an installed packages/<pkg>/node_modules/@brainervirus
// copy silently replaces the tagged source (8.0.0 shipped 7.7.0's core that
// way). Two checks:
//  - installs: no packages/*/node_modules/@brainervirus/* entry, and every root
//    node_modules/@brainervirus/* entry resolves inside packages/ (run before
//    the build; it also covers minified bundles, which carry no path headers);
//  - bundles: bun prefixes each inlined module with a `// <path>` header; a
//    header under node_modules/@brainervirus/ names a stale copy, and every
//    non-minified bundle must inline core from packages/workit-core/src/.
// `--installs-only` runs only the first check (prepareCmd, before the build).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { RELEASE_PACKAGES } from "./analyze-release-scope";

// Separator-agnostic: a Windows build may write `\` in module headers.
const REGISTRY_COPY = /^\/\/ (.*node_modules[\\/]@brainervirus[\\/].+)$/gmu;
const WORKSPACE_CORE = /^\/\/ packages[\\/]workit-core[\\/]src[\\/]/mu;
/** bun's unminified output averages well under 100 bytes a line; --minify is thousands. */
const MINIFIED_BYTES_PER_LINE = 1000;

const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
/** `root`-relative path with `/` separators, for messages on every OS. */
const rel = (root: string, file: string): string => relative(root, file).split(sep).join("/");
/** Windows paths compare case-insensitively. */
const fold = (file: string): string => (process.platform === "win32" ? file.toLowerCase() : file);

/** Installed @brainervirus packages a build could resolve instead of workspace source. */
export function registryInstalls(root: string): string[] {
  const nested = entries(join(root, "packages")).flatMap((pkg) => {
    const scope = join(root, "packages", pkg, "node_modules", "@brainervirus");
    return entries(scope).map((name) => rel(root, join(scope, name)));
  });
  const packages = fold(join(realpathSync(root), "packages") + sep);
  const scope = join(root, "node_modules", "@brainervirus");
  const hoisted = entries(scope)
    .filter((name) => !fold(realpathSync(join(scope, name))).startsWith(packages))
    .map((name) => rel(root, join(scope, name)));
  return [...nested, ...hoisted];
}

function bundles(dir: string): string[] {
  return entries(dir).flatMap((name) => {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) return bundles(file);
    return name.endsWith(".js") ? [file] : [];
  });
}

export type BundleProblem = { bundle: string; problem: string };

/** Built adapter bundles under `root`, and what each one inlined wrongly. */
export function bundleSources(root: string): { scanned: string[]; problems: BundleProblem[] } {
  const scanned = RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-core").flatMap((pkg) =>
    bundles(join(root, "packages", pkg, "dist")),
  );
  const problems = scanned.flatMap((file): BundleProblem[] => {
    const bundle = rel(root, file);
    const text = readFileSync(file, "utf8");
    const copies = [...text.matchAll(REGISTRY_COPY)].map((m) => m[1].replaceAll("\\", "/"));
    if (copies.length)
      return [{ bundle, problem: `${copies.length} registry-copy modules, e.g. ${copies[0]}` }];
    const minified = text.length / (text.split("\n").length || 1) > MINIFIED_BYTES_PER_LINE;
    if (!minified && !WORKSPACE_CORE.test(text))
      return [{ bundle, problem: "no `// packages/workit-core/src/` module header" }];
    return [];
  });
  return { scanned: scanned.map((file) => rel(root, file)), problems };
}

/** Every failure under `root` as printable lines; empty when the release may proceed. */
export function verifyBundleSources(root: string, options: { installsOnly?: boolean } = {}) {
  const failures = registryInstalls(root).map(
    (path) => `${path}: installed copy outside packages/ (bundles would inline it)`,
  );
  if (options.installsOnly) return { failures, scanned: 0 };
  const { scanned, problems } = bundleSources(root);
  if (scanned.length === 0)
    failures.push(`no adapter bundles under packages/*/dist; run \`bun run build\` first`);
  for (const { bundle, problem } of problems) failures.push(`${bundle}: ${problem}`);
  return { failures, scanned: scanned.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const installsOnly = args.includes("--installs-only");
  const root = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
  const { failures, scanned } = verifyBundleSources(root, { installsOnly });
  if (failures.length) {
    console.error("adapter bundles would not inline the workspace's own sources:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("remove the copies and rebuild; see release.yml NPM_CONFIG_WORKSPACES_UPDATE");
    process.exit(1);
  }
  console.log(
    installsOnly
      ? "no registry copies of workspace packages installed"
      : `verified ${scanned} adapter bundles inline workspace sources`,
  );
}
