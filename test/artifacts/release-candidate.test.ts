import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installPackedPackage,
  isolatedEnv,
  listTarball,
  packReleaseCandidate,
  readTarballFile,
  REPO_ROOT,
  runInIsolation,
} from "../shared/helpers/packages";
import { RELEASE_PACKAGES } from "../../packages/workit-core/scripts/analyze-release-scope";

// Task 23 release-candidate gate (RL-08/RL-10, CA-30): the FINAL packed
// candidate is deterministic, self-contained, safe, and never published.
// packReleaseCandidate() wraps the release-parity pack and asserts the
// tarballs are pack-local; this suite proves the artifacts themselves.

const CORE = "@brainervirus/workit-core";
const MCP = "@brainervirus/workit-mcp";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CODEX = "@brainervirus/workit-codex";
const PI = "@brainervirus/workit-pi";
const CLI = "@brainervirus/workit-cli";

const V1_PACKAGES = [CORE, MCP, CLI, OPENCODE, CURSOR, CODEX, PI];

const packedFiles = () => {
  const files: string[] = [];
  for (const pack of packReleaseCandidate()) {
    for (const entry of listTarball(pack.tarball)) {
      if (pack.packageName === CORE) files.push(entry);
    }
  }
  return files;
};

const packageNames = () => packReleaseCandidate().map((p) => p.packageName);

const byName = (packs: ReturnType<typeof packReleaseCandidate>, name: string) =>
  packs.find((p) => p.packageName === name)!;

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

// The pack flow runs ONLY through these sources: a sandbox copy + the
// release-time workspace rewrite + each adapter's own build + bun pm pack.
// The Task 24 gate script reuses the same pack-only candidate.
const PACK_FLOW_SOURCES = [
  path.join("test", "shared", "helpers", "packages.ts"),
  path.join("scripts", "verify-release-candidate.ts"),
  path.join("packages", "workit-core", "scripts", "rewrite-workspace-deps.ts"),
  path.join("packages", "workit-opencode", "scripts", "build.ts"),
  path.join("packages", "workit-cursor", "scripts", "build.ts"),
  path.join("packages", "workit-cli", "scripts", "build.ts"),
];

test("the v1 candidate contains no 0.x workflow runtime", () => {
  const files = packedFiles();
  expect(files).not.toContain("src/core/flow-state.ts");
  expect(files.some((file) => file.includes("vendor/superpowers"))).toBe(false);
  expect(packageNames()).toEqual(V1_PACKAGES);
});

test("no source import names deleted 0.x workflow modules", () => {
  const deleted = [
    "core/flow-state",
    "core/handoff-tools",
    "core/handoff-context",
    "core/plan-tasks",
    "core/sdd",
    "core/detector",
    "core/reminder",
    "core/menu",
    "/state.ts",
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
        const source = readFileSync(file, "utf8");
        for (const name of deleted) {
          if (source.includes(name)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
  };
  for (const pkg of RELEASE_PACKAGES) walk(path.join(REPO_ROOT, "packages", pkg, "src"));
  walk(path.join(REPO_ROOT, "packages/workit-cursor/mcp"));
  walk(path.join(REPO_ROOT, "packages/workit-codex/hooks"));
  walk(path.join(REPO_ROOT, "packages/workit-codex/scripts"));
  walk(path.join(REPO_ROOT, "packages/workit-pi/src"));
  walk(path.join(REPO_ROOT, "packages/workit-pi/extensions"));
  expect(offenders).toEqual([]);
});

test("packed internal dependencies rewrite to the same release version", () => {
  const packs = packReleaseCandidate();
  const coreVersion = JSON.parse(
    readTarballFile(byName(packs, CORE).tarball, "package.json"),
  ).version;
  for (const name of [MCP, OPENCODE, CURSOR, CODEX, CLI]) {
    const pkg = JSON.parse(readTarballFile(byName(packs, name).tarball, "package.json"));
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith("@brainervirus/")) {
        expect(range, `${name} → ${dep}`).toBe(`^${coreVersion}`);
      }
    }
  }
});

test("Cursor and Codex plugin manifests match the core release version", () => {
  const packs = packReleaseCandidate();
  const coreVersion = JSON.parse(
    readTarballFile(byName(packs, CORE).tarball, "package.json"),
  ).version;
  const cursor = JSON.parse(
    readTarballFile(byName(packs, CURSOR).tarball, ".cursor-plugin/plugin.json"),
  );
  const codex = JSON.parse(
    readTarballFile(byName(packs, CODEX).tarball, ".codex-plugin/plugin.json"),
  );
  expect(cursor.version).toBe(coreVersion);
  expect(codex.version).toBe(coreVersion);
});

test("Pi declares its package resources in the packed manifest", () => {
  const pkg = JSON.parse(
    readTarballFile(byName(packReleaseCandidate(), PI).tarball, "package.json"),
  );
  expect(pkg.pi?.extensions).toEqual(["./dist/workit.js"]);
  expect(pkg.pi?.skills).toEqual(["./skills"]);
});

test("release analysis treats every v1 package path as product code", () => {
  expect(RELEASE_PACKAGES).toEqual([
    "workit-core",
    "workit-mcp",
    "workit-cli",
    "workit-opencode",
    "workit-cursor",
    "workit-codex",
    "workit-pi",
  ]);
});

test("a fresh repack yields byte-identical sha256 for every package", () => {
  const first = packReleaseCandidate();
  const second = packReleaseCandidate({ force: true });
  expect(second.map((p) => p.packageName)).toEqual(first.map((p) => p.packageName));
  expect(second.map((p) => p.sha256)).toEqual(first.map((p) => p.sha256));
});

test("packing the candidate never invokes a publication command (RL-08/CA-30)", () => {
  // Comment text may mention publishing; the pack flow's CODE must not run it,
  // and no bare "publish" literal may appear either (D10).
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden =
    /\b(?:npm|npx|bun|yarn|pnpm)\s+(?:publish|login|adduser)\b|\bgit\s+(?:push|tag)\b|\bgh\s+release\b/;
  for (const rel of PACK_FLOW_SOURCES) {
    const code = codeOnly(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
    expect(code, rel).not.toMatch(forbidden);
    expect(code, rel).not.toContain('"publish"');
    expect(code, rel).not.toContain("'publish'");
  }
  for (const pack of packReleaseCandidate()) {
    expect(pack.tarball.startsWith(os.tmpdir()), pack.packageName).toBe(true);
  }
});

test("packed release metadata is synchronized: adapter core dep equals core version", () => {
  const packs = packReleaseCandidate();
  const coreVersion = JSON.parse(
    readTarballFile(byName(packs, CORE).tarball, "package.json"),
  ).version;
  for (const name of [MCP, OPENCODE, CURSOR, CODEX, CLI]) {
    const pkg = JSON.parse(readTarballFile(byName(packs, name).tarball, "package.json"));
    expect(pkg.dependencies["@brainervirus/workit-core"], name).toBe(`^${coreVersion}`);
  }
});

// AR-03: the packed CLI manifest declares BOTH adapters at the same release
// version, so a manifest-driven install carries the full setup closure.
test("packed CLI manifest declares both adapters at the core release version", () => {
  const packs = packReleaseCandidate();
  const coreVersion = JSON.parse(
    readTarballFile(byName(packs, CORE).tarball, "package.json"),
  ).version;
  const cli = JSON.parse(readTarballFile(byName(packs, CLI).tarball, "package.json"));
  expect(cli.dependencies["@brainervirus/workit-opencode"]).toBe(`^${coreVersion}`);
  expect(cli.dependencies["@brainervirus/workit-cursor"]).toBe(`^${coreVersion}`);
  expect(JSON.stringify(cli.dependencies)).not.toContain("workspace:");
});

test("candidate entries are self-contained: no dist .ts, workspace:, or checkout paths", () => {
  const normalizedRoot = REPO_ROOT.split(path.sep).join("/");
  for (const pack of packReleaseCandidate()) {
    const files = listTarball(pack.tarball);
    const distTs = files.filter((f) => f.startsWith("dist/") && f.endsWith(".ts"));
    expect(distTs, pack.packageName).toEqual([]);
    const raw = readTarballFile(pack.tarball, "package.json");
    expect(raw, pack.packageName).not.toContain("workspace:");
    expect(raw, pack.packageName).not.toContain("file:");
    expect(raw, pack.packageName).not.toContain("git:");
    expect(files.join("\n"), pack.packageName).not.toContain(normalizedRoot);
  }
});

test("the packed candidate starts in isolation from an unrelated working directory", () => {
  const packs = packReleaseCandidate();
  const cli = byName(packs, CLI);
  const install = tmp("wk-rc-cli-");
  const home = tmp("wk-rc-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, cli);
    const cliDir = path.join(nm, CLI);
    const res = runInIsolation(
      cliDir,
      "node",
      [path.join(cliDir, "dist", "index.js"), "--help"],
      isolatedEnv(home),
    );
    expect(res.status, res.stderr ?? "").toBe(0);
    expect(res.stdout).toContain("workit");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
