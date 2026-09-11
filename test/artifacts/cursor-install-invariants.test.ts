import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-core/src/core/doctor";
import { WORKIT_METHOD_SKILLS } from "@/packages/workit-core/src/core/skill-manifests";
import { syncRuntime } from "@/packages/workit-core/src/core/sync-runtime";
import {
  extractTarball,
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
  REPO_ROOT,
} from "@/test/shared/helpers/packages";

const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";
const WORKIT = [...WORKIT_METHOD_SKILLS].sort();

const skillManifests = (root: string): string[] =>
  readdirSync(root)
    .filter((name) => existsSync(path.join(root, name, "SKILL.md")))
    .sort();

const walkFiles = (root: string, visit: (file: string) => void): void => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(file, visit);
    else visit(file);
  }
};

const copyBuildFixture = (root: string): string => {
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "packages"), { recursive: true });
  for (const pkg of ["workit-core", "workit-cursor"]) {
    cpSync(path.join(REPO_ROOT, "packages", pkg), path.join(repo, "packages", pkg), {
      recursive: true,
    });
  }
  mkdirSync(path.join(repo, "packages/workit-opencode/src"), { recursive: true });
  writeFileSync(path.join(repo, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(repo, "node_modules"), "junction");
  return repo;
};

const buildCursor = (repo: string, target: string) =>
  spawnSync(
    process.execPath,
    [path.join(repo, "packages/workit-cursor/scripts/build.ts"), target],
    { encoding: "utf8" },
  );

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((pack) => pack.packageName === name)!;

test(
  "Cursor build, package, and packed CLI doctor enforce exact canonical method skills and Workit identity",
  () => {
    expect(WORKIT).toHaveLength(14);
    const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-cursor-invariants-"));
    try {
      const missingWorkitRepo = copyBuildFixture(path.join(fixture, "missing-workit"));
      rmSync(path.join(missingWorkitRepo, "packages/workit-core/skills/workit-plan"), {
        recursive: true,
      });
      const missingWorkitBuild = buildCursor(
        missingWorkitRepo,
        path.join(fixture, "missing-workit-output"),
      );

      const extraWorkitRepo = copyBuildFixture(path.join(fixture, "extra-workit"));
      const extraWorkitSkill = path.join(
        extraWorkitRepo,
        "packages/workit-cursor/skills/not-canonical",
      );
      mkdirSync(extraWorkitSkill, { recursive: true });
      writeFileSync(path.join(extraWorkitSkill, "SKILL.md"), "# extra\n");
      const extraWorkitBuild = buildCursor(
        extraWorkitRepo,
        path.join(fixture, "extra-workit-output"),
      );
      expect([missingWorkitBuild.status, extraWorkitBuild.status]).toEqual([1, 1]);
      expect(missingWorkitBuild.stderr).toContain("workit-plan");
      expect(extraWorkitBuild.stderr).toContain("not-canonical");

      const packs = packWorkspacePackages();
      const extracted = extractTarball(byName(packs, CURSOR).tarball);
      try {
        expect(skillManifests(path.join(extracted.packageDir, "skills"))).toEqual(WORKIT);
        walkFiles(path.join(extracted.packageDir, "skills"), (file) => {
          expect(statSync(file).mode & 0o111, file).toBe(0);
          expect(readFileSync(file).subarray(0, 2).toString("latin1"), file).not.toBe("#!");
        });
        expect(existsSync(path.join(extracted.packageDir, "assets/logo.svg"))).toBe(true);
        for (const manifest of [".cursor-plugin/plugin.json"]) {
          const json = JSON.parse(readFileSync(path.join(extracted.packageDir, manifest), "utf8"));
          expect(json.name, manifest).toBe("workit");
          expect(json.displayName, manifest).toBe("Workit");
          expect(json.logo, manifest).toBe("assets/logo.svg");
          expect(JSON.stringify(json), manifest).not.toContain("Workflow Toolkit");
        }
      } finally {
        rmSync(extracted.root, { recursive: true, force: true });
      }

      const home = path.join(fixture, "packed-home");
      const nodeModules = path.join(fixture, "packed", "node_modules");
      const plugin = path.join(home, ".cursor/plugins/local/workit");
      mkdirSync(path.dirname(plugin), { recursive: true });
      mkdirSync(nodeModules, { recursive: true });
      installPackedPackage(nodeModules, byName(packs, CLI));
      const cursor = installPackedPackage(nodeModules, byName(packs, CURSOR));
      cpSync(cursor, plugin, { recursive: true });
      mkdirSync(path.join(home, ".cursor"), { recursive: true });
      writeFileSync(
        path.join(home, ".cursor/mcp.json"),
        JSON.stringify({
          mcpServers: {
            workit: { command: "node", args: [path.join(plugin, "dist/mcp-server.js")] },
          },
        }),
      );
      const runPackedDoctor = () => {
        const result = spawnSync(
          "node",
          [path.join(nodeModules, CLI, "dist/index.js"), "doctor", "--json"],
          { cwd: fixture, env: isolatedEnv(home), encoding: "utf8" },
        );
        return { result, report: JSON.parse(result.stdout) };
      };

      const healthy = runPackedDoctor();
      expect(healthy.result.status, healthy.result.stderr).toBe(0);
      expect(healthy.report.checks.find((check: any) => check.id === "assets").status).toBe("pass");
      const opencode = runDoctor({ host: "opencode", home, cwd: fixture, env: isolatedEnv(home) });
      expect(opencode.checks.find((check) => check.id === "assets")?.status).toBe("warn");

      for (const damaged of [path.join(plugin, "skills/workit-plan/SKILL.md")]) {
        const contents = readFileSync(damaged);
        rmSync(damaged);
        const missing = runPackedDoctor();
        expect(missing.result.status).not.toBe(0);
        expect(missing.report.checks.find((check: any) => check.id === "assets").status).toBe(
          "fail",
        );
        writeFileSync(damaged, contents);
      }

      const rogue = path.join(plugin, "skills/not-canonical");
      mkdirSync(rogue);
      writeFileSync(path.join(rogue, "SKILL.md"), "# rogue\n");
      const extra = runPackedDoctor();
      expect(extra.result.status).not.toBe(0);
      expect(extra.report.checks.find((check: any) => check.id === "assets").status).toBe("fail");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
  { timeout: 300_000 },
);

const syncToolsAvailable =
  process.platform !== "win32" &&
  ["bash", "flock", "rsync"].every(
    (tool) => spawnSync(tool, ["--version"], { encoding: "utf8" }).status === 0,
  );

const syncEnv = (home: string, lockDir: string, repo: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("WORKFLOW_") && key !== "HOME"),
  ),
  HOME: home,
  WORKFLOW_TOOLKIT_DEV: repo,
  WORKIT_SYNC_LOCK_DIR: lockDir,
});

test(
  "sync-runtime installs the canonical method skills and no legacy vendor tree",
  async () => {
    if (!syncToolsAvailable) return;
    const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-sync-runtime-"));
    const home = path.join(fixture, "home");
    const lockDir = path.join(fixture, "lock");
    const plugin = path.join(home, ".cursor/plugins/local/workit");
    mkdirSync(plugin, { recursive: true });
    try {
      const result = await syncRuntime({
        env: syncEnv(home, lockDir, REPO_ROOT),
      });
      expect(result.ok).toBe(true);
      expect(skillManifests(path.join(plugin, "skills"))).toEqual(WORKIT);
      expect(existsSync(path.join(plugin, "vendor"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);
