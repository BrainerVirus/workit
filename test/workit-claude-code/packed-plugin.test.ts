// S14 packaging gate: the packed npm tarball is the plugin Claude Code
// installs from the marketplace's npm source. It must carry the built
// payload, resolve dist/ (no monorepo next to it), and, when a Claude Code
// CLI is available (WORKIT_CLAUDE_BIN in CI, or `claude` on PATH), pass
// `claude plugin validate --strict` and install from a local marketplace in
// an isolated config dir.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeWorkitInstalls } from "@/packages/workit-cli/src/admin/host-install";
import { fixture, tempRoot, withProtectedMain } from "@/test/workit-core/hooks/hook-fixtures";
import {
  extractTarball,
  listTarball,
  packWorkspacePackages,
  REPO_ROOT,
} from "@/test/shared/helpers/packages";
import { runHook } from "./plugin-helpers";

const PACKAGE = "@brainervirus/workit-claude-code";
const TREE_VERSION = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "packages", "workit-core", "package.json"), "utf8"),
).version as string;
const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const packed = () => packWorkspacePackages().find((pack) => pack.packageName === PACKAGE)!;

const claudeBin = (): string | null => {
  const explicit = process.env.WORKIT_CLAUDE_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "claude" : null;
};

/** The extracted package laid out as Claude's plugin cache holds it. */
let extracted: string | null = null;
const pluginFromTarball = () => {
  if (extracted) return extracted;
  const { root, packageDir } = extractTarball(packed().tarball);
  cleanup.push(root);
  extracted = packageDir;
  return packageDir;
};

test(
  "the packed tarball carries the built plugin payload and no sources or evals",
  () => {
    const files = listTarball(packed().tarball);
    for (const required of [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "bin/workit-hook.mjs",
      "bin/workit",
      "agents/verifier.md",
      "agents/reviewer.md",
      "agents/implementer.md",
      "dist/workit-hook.js",
      "dist/workit.js",
      "skills/review/SKILL.md",
      "assets/templates/workit-contract.md",
      "package.json",
      "README.md",
    ])
      expect(files, required).toContain(required);
    expect(files.filter((file) => /^(src|scripts|evals)\//.test(file))).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(pluginFromTarball(), "package.json"), "utf8"));
    // Release parity: no workspace protocol survives into the published manifest.
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    const manifest = JSON.parse(
      readFileSync(path.join(pluginFromTarball(), ".claude-plugin", "plugin.json"), "utf8"),
    );
    // The release-time rewrite (rewrite-workspace-deps.ts, which the pack
    // sandbox runs too) mirrors the tree's core version into plugin.json, the
    // version Claude reads. Derived from the tree, so a release on main can't
    // break this; the plugin package.json lockstep is the manifest sync's job
    // (plugin.test.ts).
    expect(manifest.version).toBe(TREE_VERSION);
  },
  { timeout: 300_000 },
);

test(
  "given the packed tarball, the hook launcher resolves dist/ and denies a protected-branch checkout",
  async () => {
    const plugin = pluginFromTarball();
    await withProtectedMain(() => {
      const cwd = tempRoot("workit-claude-packed-");
      cleanup.push(cwd);
      const run = runHook(plugin, fixture("claude-code", "pre-tool-use-bash", cwd));
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.stringify(run.json)).toContain('"permissionDecision":"deny"');
    });
    if (process.platform !== "win32") {
      const cli = spawnSync(path.join(plugin, "bin", "workit"), ["--version"], {
        encoding: "utf8",
        env: { ...process.env, WORKIT_SHIM_TRACE: "1" },
        timeout: 60_000,
      });
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stderr).toContain("workit-shim: dist");
    }
  },
  { timeout: 300_000 },
);

const claude = claudeBin();
test.skipIf(claude === null)(
  "given the packed tarball, claude plugin validate --strict passes and a local marketplace installs it",
  () => {
    const plugin = pluginFromTarball();
    const home = mkdtempSync(path.join(os.tmpdir(), "workit-claude-home-"));
    cleanup.push(home);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      USERPROFILE: home,
    };
    const run = (args: string[]) =>
      spawnSync(claude!, args, { encoding: "utf8", env, cwd: home, timeout: 120_000 });
    const validated = run(["plugin", "validate", "--strict", plugin]);
    expect(validated.status, validated.stdout + validated.stderr).toBe(0);
    const root = run(["plugin", "validate", "--strict", REPO_ROOT]);
    expect(root.status, root.stdout + root.stderr).toBe(0);
    // A directory marketplace whose entry points at the extracted package
    // stands in for the npm source (same payload, no registry).
    const market = path.join(home, "market");
    mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "workit",
        description: "packed candidate",
        owner: { name: "BrainerVirus" },
        plugins: [{ name: "workit", description: "packed candidate", source: "./workit" }],
      }),
    );
    spawnSync("cp", ["-R", plugin, path.join(market, "workit")]);
    expect(run(["plugin", "marketplace", "add", market]).status).toBe(0);
    const installed = run(["plugin", "install", "workit@workit"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const installs = claudeWorkitInstalls(home, env);
    expect(installs).toHaveLength(1);
    // Claude records the version plugin.json declares.
    expect(installs[0].version).toBe(
      JSON.parse(readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8")).version,
    );
    expect(installs[0].version).toBe(TREE_VERSION);
    expect(existsSync(path.join(installs[0].installPath, "dist", "workit-hook.js"))).toBe(true);
  },
  { timeout: 300_000 },
);
