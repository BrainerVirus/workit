// Deterministic pack-and-extract helpers for the artifact gate. Packing never
// publishes, tags, or touches a registry — `bun pm pack` only writes a local
// tarball. Extracted-package helpers run commands from temp dirs with no access
// to the repository's node_modules, so resolution goes through the packed
// candidate (or an offline copy of hoisted third-party deps as the registry
// stand-in) instead of the monorepo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export type PackedPackage = {
  packageName: string;
  tarball: string;
  sha256: string;
};

const WORKSPACE_PACKAGES = [
  "workit-core",
  "workit-opencode",
  "workit-cursor",
  "workit-cli",
] as const;

let cached: PackedPackage[] | null = null;

function copyPackage(pkg: string, sandbox: string) {
  cpSync(path.join(REPO_ROOT, "packages", pkg), path.join(sandbox, "packages", pkg), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules`),
  });
}

// Pack the release-parity candidate without publishing: copy the CURRENT package
// layout into a temp sandbox, apply the release-time workspace rewrite (RR-01 /
// RR-09) and the existing CLI build, then pack each package with `bun pm pack`.
// Deterministic and offline — no registry, no tags, no marketplace operations.
export function packWorkspacePackages(options: { force?: boolean } = {}): PackedPackage[] {
  if (cached && !options.force) return cached;
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "wk-pack-sandbox-"));
  const tarballs = mkdtempSync(path.join(os.tmpdir(), "wk-pack-tarballs-"));
  // ponytail: the tarball temp dir deliberately leaks to a fresh OS temp dir —
  // the returned PackedPackage entries reference the tarballs after this call
  // returns, so cleanup here would break callers; the OS tempdir sweep reclaims
  // it. Cleanup only if the pack itself throws before any caller can hold them.
  try {
    for (const pkg of WORKSPACE_PACKAGES) copyPackage(pkg, sandbox);

    // Release parity: rewrite workspace:* core deps to ^<core version> in the
    // sandbox copy (the release flow runs this script before packing). Raw
    // workspace:* tarballs silently drop the core dependency (RR-01, CA-03).
    const rewrite = spawnSync(
      "bun",
      [path.join(REPO_ROOT, "packages/workit-core/scripts/rewrite-workspace-deps.ts"), sandbox],
      { encoding: "utf8" },
    );
    if (rewrite.status !== 0) {
      throw new Error(`rewrite-workspace-deps failed: ${rewrite.stderr}`);
    }

    // Deterministic adapter dist + assets: run each adapter's own build script
    // against the sandbox copy. dist/ is gitignored, so a fresh checkout packs an
    // empty tarball without this build.
    for (const pkg of ["workit-opencode", "workit-cursor", "workit-cli"]) {
      const buildScript = path.join(REPO_ROOT, "packages", pkg, "scripts", "build.ts");
      const target = path.join(sandbox, "packages", pkg);
      const build = spawnSync("bun", [buildScript, target], { encoding: "utf8" });
      if (build.status !== 0) {
        throw new Error(`${pkg} build failed: ${build.stderr}`);
      }
    }

    cached = packSandbox(sandbox, tarballs);
    return cached;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Final-gate entry (Task 23, CA-30): the deterministic, pack-only candidate
// over packWorkspacePackages. Packing never publishes — `bun pm pack` only
// writes a local tarball — and this wrapper asserts the tarballs stay local to
// the temp pack dir so a publish/registry/tag path can never look like this
// gate. `force: true` bypasses the module cache to prove repack determinism.
export function packReleaseCandidate(options: { force?: boolean } = {}): PackedPackage[] {
  const packs = packWorkspacePackages(options);
  for (const pack of packs) {
    if (!existsSync(pack.tarball)) {
      throw new Error(`release candidate missing tarball: ${pack.packageName}`);
    }
    // ponytail: tmp-dir provenance is the "not published" guard — a published
    // package would resolve from a registry cache or the repo, never a fresh
    // temp pack dir; raise to a registry readback if publishing ever runs here.
    if (!pack.tarball.startsWith(os.tmpdir())) {
      throw new Error(`release candidate tarball outside the temp pack dir: ${pack.tarball}`);
    }
  }
  return packs;
}

function packSandbox(sandbox: string, tarballs: string): PackedPackage[] {
  const packs: PackedPackage[] = [];
  for (const pkg of WORKSPACE_PACKAGES) {
    const pkgDir = path.join(sandbox, "packages", pkg);
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const packed = spawnSync("bun", ["pm", "pack", "--destination", tarballs], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    if (packed.status !== 0) {
      throw new Error(`bun pm pack ${pkg} failed: ${packed.stderr}`);
    }
    const fileName = `${String(pkgJson.name).replace(/^@/, "").replace("/", "-")}-${pkgJson.version}.tgz`;
    const file = path.join(tarballs, fileName);
    if (!existsSync(file)) throw new Error(`expected tarball ${file}`);
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    packs.push({ packageName: pkgJson.name, tarball: file, sha256 });
  }
  return packs;
}

// Extract a packed tarball into a temp dir. Returns the temp root (for cleanup)
// and the extracted `package/` directory.
export function extractTarball(tarball: string): { root: string; packageDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-extract-"));
  // Cheap traversal guard (D9): reject any entry with a `..` path component
  // before extraction. Our own `bun pm pack` tarballs never have one; this
  // only hardens against a tampered tarball ever reaching the gate.
  if (listTarball(tarball).some((entry) => entry.split("/").includes(".."))) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`tar traversal refused: ${tarball}`);
  }
  const run = spawnSync("tar", ["-xzf", tarball, "-C", root], { encoding: "utf8" });
  if (run.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`tar extract failed: ${run.stderr}`);
  }
  const packageDir = path.join(root, "package");
  if (!existsSync(packageDir)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`no package/ root in ${tarball}`);
  }
  return { root, packageDir };
}

// List the files inside a packed tarball (paths relative to `package/`).
export function listTarball(tarball: string): string[] {
  const run = spawnSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`tar list failed: ${run.stderr}`);
  return (
    run.stdout
      .split("\n")
      .filter(Boolean)
      // Windows bsdtar emits CRLF line endings — strip the \r so entries match
      // their tar-form forward-slash names on every platform.
      .map((line) => line.replace(/\r$/, "").replace(/^package\//, ""))
  );
}

// Read a single file (relative to `package/`) straight out of a tarball.
export function readTarballFile(tarball: string, entry: string): string {
  const run = spawnSync("tar", ["-xOf", tarball, `package/${entry}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`tar read ${entry} failed: ${run.stderr}`);
  return run.stdout;
}

// Install a packed package under an isolated node_modules (extract + copy), so
// consumers resolve it from the candidate instead of the monorepo. Returns the
// installed package directory.
export function installPackedPackage(nodeModulesDir: string, pack: PackedPackage): string {
  const target = path.join(nodeModulesDir, pack.packageName);
  mkdirSync(path.dirname(target), { recursive: true });
  const { root, packageDir } = extractTarball(pack.tarball);
  try {
    cpSync(packageDir, target, { recursive: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return target;
}

// Offline registry stand-in: copy the hoisted third-party runtime deps of the
// given packages (BFS over each package.json's dependencies AND
// optionalDependencies) into an isolated node_modules, so an extracted
// candidate resolves them without a network. Symlinks are dereferenced so a
// workspace-symlinked hoisted root cannot leak a repo-absolute path into the
// isolated install (D9). Optional deps that are absent (e.g. other-platform
// @msgpackr-extract binaries) are skipped — optional means optional.
export function copyHoistedDeps(nodeModulesDir: string, roots: string[]): void {
  const queue = [...roots];
  const optional = new Set<string>();
  const seen = new Set<string>();
  while (queue.length) {
    const spec = queue.shift()!;
    if (seen.has(spec)) continue;
    seen.add(spec);
    const src = path.join(REPO_ROOT, "node_modules", spec);
    if (!existsSync(src)) {
      if (optional.has(spec)) continue;
      throw new Error(`hoisted dependency not found: ${spec}`);
    }
    const dest = path.join(nodeModulesDir, spec);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    const meta = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8"));
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push(dep);
    for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
      optional.add(dep);
      queue.push(dep);
    }
  }
}

// Script-specific path overrides the packed scripts read from the environment
// (install-opencode-plugin.sh: CONFIG_PATH/PIN_PATH; sync-runtime.sh: PKG_PATH;
// install-cursor-plugin.sh: CURSOR_MCP/CURSOR_SETTINGS). Forwarded from a dev
// shell they re-point a script at the repository, defeating isolation.
const STRIPPED_ENV_VARS = new Set([
  "CONFIG_PATH",
  "PIN_PATH",
  "PKG_PATH",
  "CURSOR_MCP",
  "CURSOR_SETTINGS",
]);

// Env for isolated runs: HOME points at a temp dir and every WORKFLOW_* /
// XDG_* override plus the script-specific path overrides above is stripped so
// scripts fall back to their HOME defaults and can never be pointed back at
// the repository.
export function isolatedEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("WORKFLOW_") || k.startsWith("XDG_")) continue;
    if (STRIPPED_ENV_VARS.has(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  return { ...env, ...extra };
}

// Probe the npm registry: the isolated npm-install gates fetch third-party
// runtime deps (ink/react/@inkjs/ui, zod/@modelcontextprotocol/sdk) from the
// public registry, so an offline/registry-outage CI run must skip those tests
// cleanly rather than fail. Reachability is independent of HOME (a temp HOME
// loads no user .npmrc), so the ambient env is a faithful probe. The online
// path keeps every assertion intact.
export function npmRegistryReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  const ping = spawnSync("npm", ["ping"], { encoding: "utf8", timeout: 30_000, env });
  return ping.status === 0;
}

// Run a command with cwd inside an isolated install. Returns status/stdout/stderr.
export function runInIsolation(
  cwd: string,
  bin: string,
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
