import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractTarball,
  isolatedEnv,
  npmRegistryReachable,
  packWorkspacePackages,
} from "@/test/shared/helpers/packages";

// #265 / #272: `npm i -g @brainervirus/workit-cli` nests the CLI's workspace
// dependencies under <global root>/@brainervirus/workit-cli/node_modules, and
// OpenCode installs workit-opencode into its own cache. `workit init` used to
// look only for hoisted siblings and failed with "package not found"; doctor
// warned about a missing dev checkout and flock on a normal install. This gate
// installs the packed CLI with npm into a temp prefix, against a temp HOME.

const CLI = "@brainervirus/workit-cli";
const CURSOR = "@brainervirus/workit-cursor";
const OPENCODE = "@brainervirus/workit-opencode";

// Third-party runtime deps (ink, react, @inkjs/ui) come from the registry.
const npmRegistryOk = npmRegistryReachable();
if (!npmRegistryOk) {
  console.error("skipping npm-global layout gate: `npm ping` failed — registry unreachable");
}

const NETWORK_ERROR =
  /E(?:AI_AGAIN|CONNRESET|CONNREFUSED|NOTFOUND|TIMEDOUT|NETUNREACH|SOCKETTIMEOUT)|network|\bE5\d\d\b|fetch failed/i;

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

type Entry = { platform: string; file: string; status: string; detail?: string };
type PackedSetup = {
  buildSetupPreview: (values: Record<string, unknown>, opts: Record<string, unknown>) => unknown;
  applySetupPreview: (
    preview: unknown,
    opts: Record<string, unknown>,
  ) => { ok: boolean; entries: Entry[] };
};
type Report = { checks: { id: string; status: string; detail: string }[] };

test.skipIf(!npmRegistryOk)(
  "Given a global npm install with nested node_modules and an OpenCode-managed plugin, When init and doctor run, Then adapters resolve and no false row appears",
  async () => {
    const packs = packWorkspacePackages();
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-npm-global-")));
    try {
      const home = path.join(base, "home");
      const prefix = path.join(base, "prefix");
      mkdirSync(home, { recursive: true });
      const env = isolatedEnv(home, {
        npm_config_prefix: prefix,
        npm_config_cache: path.join(base, "npm-cache"),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      });

      // The packed CLI depends on workit-cursor by version; point that one
      // dependency at the packed tarball so npm installs this candidate, nested
      // exactly as a registry install nests it.
      const cliPack = extractTarball(byName(packs, CLI).tarball);
      const manifestPath = path.join(cliPack.packageDir, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(Object.keys(manifest.dependencies)).not.toContain(OPENCODE);
      manifest.dependencies[CURSOR] = `file:${byName(packs, CURSOR).tarball}`;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const repacked = spawnSync(
        "npm",
        ["pack", cliPack.packageDir, "--pack-destination", base, "--json"],
        { encoding: "utf8", env },
      );
      rmSync(cliPack.root, { recursive: true, force: true });
      expect(repacked.status, repacked.stderr).toBe(0);
      const cliTarball = path.join(base, JSON.parse(repacked.stdout)[0].filename);

      const install = spawnSync("npm", ["install", "-g", cliTarball], {
        encoding: "utf8",
        env,
        timeout: 300_000,
      });
      // The registry answered `npm ping` but can still drop the install (a
      // flaky network, an outage mid-run): that is not a layout failure.
      if (install.status !== 0 && NETWORK_ERROR.test(`${install.stderr}${install.stdout}`)) {
        console.error(
          `skipping npm-global layout gate: npm install hit the network\n${install.stderr}`,
        );
        return;
      }
      expect(install.status, install.stderr).toBe(0);
      const globalRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", env }).stdout.trim();
      const cliDir = path.join(globalRoot, CLI);
      // The #265 layout: the adapter lives under the CLI, not beside it.
      expect(existsSync(path.join(cliDir, "node_modules", CURSOR, "package.json"))).toBe(true);
      expect(existsSync(path.join(globalRoot, CURSOR))).toBe(false);

      // OpenCode registered and cached the plugin itself (opencode 2.x layout).
      const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
      mkdirSync(path.dirname(opencodeConfig), { recursive: true });
      writeFileSync(opencodeConfig, JSON.stringify({ plugins: [OPENCODE] }, null, 2) + "\n");
      const opencodePack = extractTarball(byName(packs, OPENCODE).tarball);
      const cached = path.join(
        home,
        ".cache",
        "opencode",
        "npm",
        "@brainervirus",
        "workit-opencode@latest",
        "1790643053398",
        "node_modules",
        OPENCODE,
      );
      mkdirSync(path.dirname(cached), { recursive: true });
      cpSync(opencodePack.packageDir, cached, { recursive: true });
      rmSync(opencodePack.root, { recursive: true, force: true });

      const repo = path.join(base, "projects", "app");
      mkdirSync(repo, { recursive: true });
      expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
      const configDir = path.join(home, ".config", "workit");
      mkdirSync(configDir, { recursive: true });
      // Init and doctor run offline: a registry fallback (npm-staging the
      // Cursor adapter) cannot hide a resolution regression. The registry
      // probe is pinned to the candidate version, so a newer published release
      // cannot turn this layout gate into a stale-cache report.
      const setupEnv = {
        ...env,
        npm_config_offline: "true",
        WORKFLOW_TOOLKIT_CONFIG: configDir,
        WORKIT_DOCTOR_STALE_REGISTRY_VERSION: JSON.parse(
          readFileSync(path.join(cached, "package.json"), "utf8"),
        ).version,
      };

      // init's setup engine, built the way the CLI bundles it and loaded from
      // the installed package, so it resolves adapters from that install.
      const setupFile = path.join(cliDir, "dist", "admin-setup.js");
      const built = spawnSync(
        "bun",
        [
          "build",
          path.resolve(import.meta.dir, "../../packages/workit-cli/src/admin/setup.ts"),
          "--target",
          "node",
          "--format",
          "esm",
          "--outfile",
          setupFile,
        ],
        { encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const setup = (await import(pathToFileURL(setupFile).href)) as PackedSetup;
      const preview = setup.buildSetupPreview(
        {
          platforms: ["opencode", "cursor"],
          locale: "en",
          branchPreset: "gitflow",
          branchAllowed: "feature/*",
          branchProtected: "main",
          baseUrl: "",
          vcsProvider: "skip",
          workspaces: [],
          applyProject: true,
        },
        { dir: configDir, cwd: repo, env: setupEnv },
      );
      const result = setup.applySetupPreview(preview, {
        home,
        configDir,
        cwd: repo,
        env: setupEnv,
      });
      const failed = result.entries.filter((e) => e.status === "Failed");
      expect(failed, JSON.stringify(result.entries, null, 2)).toEqual([]);
      expect(JSON.stringify(result.entries)).not.toContain("package not found");
      const opencode = result.entries.find((e) => e.file === opencodeConfig);
      expect(opencode?.status).toBe("Skipped");
      const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
      expect(JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")).name).toBe(
        CURSOR,
      );
      expect(existsSync(path.join(repo, ".gitignore"))).toBe(true);
      // The nested adapter was used as installed: init never fell back to
      // staging a registry copy (that path is offline-blocked above anyway).
      expect(JSON.stringify(result.entries)).not.toContain(".workit-package-bootstrap");
      expect(
        existsSync(path.join(home, ".cursor", "plugins", "local", ".workit-package-bootstrap")),
      ).toBe(false);

      const doctor = spawnSync(
        process.execPath.endsWith("bun") ? "node" : process.execPath,
        [path.join(cliDir, "dist", "index.js"), "doctor", "--json"],
        { cwd: repo, encoding: "utf8", env: setupEnv, timeout: 120_000 },
      );
      const report = JSON.parse(doctor.stdout) as Report;
      const row = (id: string) => report.checks.find((c) => c.id === id)!;
      expect(row("versions").status).toBe("info");
      expect(row("utility").detail).not.toContain("flock");
      const misleading = report.checks.filter(
        (c) =>
          (c.status === "warn" || c.status === "fail") &&
          /dev checkout|WORKFLOW_TOOLKIT_DEV|flock|package not found/.test(c.detail),
      );
      expect(misleading, doctor.stdout).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
  600_000,
);
