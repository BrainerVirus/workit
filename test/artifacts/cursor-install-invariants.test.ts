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
import { runDoctor } from "../../packages/workit-core/src/core/doctor";
import { CANONICAL_SKILLS } from "../../packages/workit-core/src/core/skill-manifests";
import { syncRuntime } from "../../packages/workit-core/src/core/sync-runtime";
import {
  extractTarball,
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
  REPO_ROOT,
} from "../shared/helpers/packages";

const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";
const SUPERPOWERS = [...CANONICAL_SKILLS.superpowers].sort();
const WORKIT = [...CANONICAL_SKILLS.workit].sort();

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
  "Cursor build, package, and packed CLI doctor enforce exact canonical inert skills and Workit identity",
  () => {
    expect(SUPERPOWERS).toHaveLength(14);
    expect(WORKIT).toHaveLength(12);
    const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-cursor-invariants-"));
    try {
      const missingRepo = copyBuildFixture(path.join(fixture, "missing"));
      rmSync(
        path.join(missingRepo, "packages/workit-core/vendor/superpowers/skills/brainstorming"),
        {
          recursive: true,
        },
      );
      const missingBuild = buildCursor(missingRepo, path.join(fixture, "missing-output"));
      expect(missingBuild.status).not.toBe(0);
      expect(missingBuild.stderr).toContain("brainstorming");

      const extraRepo = copyBuildFixture(path.join(fixture, "extra"));
      const extraSkill = path.join(
        extraRepo,
        "packages/workit-core/vendor/superpowers/skills/not-canonical",
      );
      mkdirSync(extraSkill, { recursive: true });
      writeFileSync(path.join(extraSkill, "SKILL.md"), "# extra\n");
      const extraBuild = buildCursor(extraRepo, path.join(fixture, "extra-output"));
      expect(extraBuild.status).not.toBe(0);
      expect(extraBuild.stderr).toContain("not-canonical");

      const missingWorkitRepo = copyBuildFixture(path.join(fixture, "missing-workit"));
      rmSync(path.join(missingWorkitRepo, "packages/workit-cursor/skills/wk-init"), {
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
      expect(missingWorkitBuild.stderr).toContain("wk-init");
      expect(extraWorkitBuild.stderr).toContain("not-canonical");
      const prepublish = spawnSync(process.execPath, ["run", "prepublishOnly"], {
        cwd: path.join(missingWorkitRepo, "packages/workit-cursor"),
        encoding: "utf8",
      });
      expect(prepublish.status).not.toBe(0);
      expect(prepublish.stderr).toContain("wk-init");

      const packs = packWorkspacePackages();
      const extracted = extractTarball(byName(packs, CURSOR).tarball);
      try {
        expect(
          skillManifests(path.join(extracted.packageDir, "vendor/superpowers/skills")),
        ).toEqual(SUPERPOWERS);
        expect(skillManifests(path.join(extracted.packageDir, "skills"))).toEqual(WORKIT);
        walkFiles(path.join(extracted.packageDir, "vendor/superpowers/skills"), (file) => {
          expect(statSync(file).mode & 0o111, file).toBe(0);
          expect(readFileSync(file).subarray(0, 2).toString("latin1"), file).not.toBe("#!");
        });
        for (const manifest of ["marketplace.json", ".cursor-plugin/plugin.json"]) {
          const json = JSON.parse(readFileSync(path.join(extracted.packageDir, manifest), "utf8"));
          expect(json.name, manifest).toBe("workit");
          expect(json.displayName, manifest).toBe("Workit");
          expect(JSON.stringify(json), manifest).not.toContain("Workflow Toolkit");
        }
      } finally {
        rmSync(extracted.root, { recursive: true, force: true });
      }

      const home = path.join(fixture, "packed-home");
      const nodeModules = path.join(fixture, "packed", "node_modules");
      const plugin = path.join(home, ".cursor/plugins/local/workflow-toolkit");
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

      for (const damaged of [
        path.join(plugin, "skills/wk-init/SKILL.md"),
        path.join(plugin, "vendor/superpowers/skills/brainstorming/SKILL.md"),
      ]) {
        const contents = readFileSync(damaged);
        rmSync(damaged);
        const missing = runPackedDoctor();
        expect(missing.result.status).not.toBe(0);
        expect(missing.report.checks.find((check: any) => check.id === "assets").status).toBe(
          "fail",
        );
        writeFileSync(damaged, contents);
      }

      const rogue = path.join(plugin, "vendor/superpowers/skills/not-canonical");
      mkdirSync(rogue);
      writeFileSync(path.join(rogue, "SKILL.md"), "# rogue\n");
      const extra = runPackedDoctor();
      expect(extra.result.status).not.toBe(0);
      expect(extra.report.checks.find((check: any) => check.id === "assets").status).toBe("fail");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    // The packed doctor spawns the CLI under node four times; Windows node cold
    // starts exceed the default 5s per-test budget.
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
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !key.startsWith("WORKFLOW_") && key !== "XDG_RUNTIME_DIR",
    ),
  ),
  HOME: home,
  XDG_RUNTIME_DIR: lockDir,
  WORKFLOW_TOOLKIT_DEV: repo,
  BUN: process.execPath,
});

test.skipIf(!syncToolsAvailable)(
  "shell and TypeScript sync reject damaged canonical source and preserve exact inert live skills",
  async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-cursor-sync-invariants-"));
    try {
      const damagedRepo = copyBuildFixture(path.join(fixture, "damaged"));
      rmSync(
        path.join(damagedRepo, "packages/workit-core/vendor/superpowers/skills/brainstorming"),
        { recursive: true },
      );
      const installHome = path.join(fixture, "install-damaged-home");
      const installLock = path.join(fixture, "install-damaged-lock");
      mkdirSync(installHome);
      mkdirSync(installLock);
      const install = spawnSync(
        "bash",
        [path.join(damagedRepo, "packages/workit-core/scripts/install-cursor-plugin.sh")],
        {
          cwd: damagedRepo,
          env: syncEnv(installHome, installLock, damagedRepo),
          encoding: "utf8",
        },
      );
      expect(install.status).not.toBe(0);
      expect(install.stderr).toContain("brainstorming");

      for (const implementation of ["shell", "typescript"] as const) {
        const home = path.join(fixture, `${implementation}-damaged-home`);
        const lock = path.join(fixture, `${implementation}-damaged-lock`);
        mkdirSync(home);
        mkdirSync(lock);
        const env = syncEnv(home, lock, damagedRepo);
        if (implementation === "shell") {
          const result = spawnSync(
            "bash",
            [path.join(REPO_ROOT, "packages/workit-core/scripts/sync-runtime.sh")],
            { env, encoding: "utf8" },
          );
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("brainstorming");
        } else {
          const result = await syncRuntime({ env });
          expect(result.ok).toBe(false);
          expect("error" in result && result.error).toContain("brainstorming");
        }
      }

      for (const implementation of ["shell", "typescript"] as const) {
        const home = path.join(fixture, `${implementation}-home`);
        const lock = path.join(fixture, `${implementation}-lock`);
        mkdirSync(home);
        mkdirSync(lock);
        const env = syncEnv(home, lock, REPO_ROOT);
        if (implementation === "shell") {
          const result = spawnSync(
            "bash",
            [path.join(REPO_ROOT, "packages/workit-core/scripts/sync-runtime.sh")],
            { env, encoding: "utf8" },
          );
          expect(result.status, result.stderr).toBe(0);
        } else {
          expect(await syncRuntime({ env })).toEqual({ ok: true });
        }
        const plugin = path.join(home, ".cursor/plugins/local/workflow-toolkit");
        expect(skillManifests(path.join(plugin, "skills"))).toEqual(WORKIT);
        expect(skillManifests(path.join(plugin, "vendor/superpowers/skills"))).toEqual(SUPERPOWERS);
        walkFiles(path.join(plugin, "vendor/superpowers/skills"), (file) => {
          expect(statSync(file).mode & 0o111, file).toBe(0);
          expect(readFileSync(file).subarray(0, 2).toString("latin1"), file).not.toBe("#!");
        });
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
