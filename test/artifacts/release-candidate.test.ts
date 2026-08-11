import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Task 23 release-candidate gate (RL-08/RL-10, CA-30): the FINAL packed
// candidate is deterministic, self-contained, safe, and never published.
// packReleaseCandidate() wraps the release-parity pack and asserts the
// tarballs are pack-local; this suite proves the artifacts themselves.

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

const byName = (packs: ReturnType<typeof packReleaseCandidate>, name: string) =>
  packs.find((p) => p.packageName === name)!;

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

// The pack flow runs ONLY through these sources: a sandbox copy + the
// release-time workspace rewrite + each adapter's own build + bun pm pack.
const PACK_FLOW_SOURCES = [
  path.join("test", "shared", "helpers", "packages.ts"),
  path.join("packages", "workit-core", "scripts", "rewrite-workspace-deps.ts"),
  path.join("packages", "workit-opencode", "scripts", "build.ts"),
  path.join("packages", "workit-cursor", "scripts", "build.ts"),
  path.join("packages", "workit-cli", "scripts", "build.ts"),
];

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
  for (const name of [OPENCODE, CURSOR, CLI]) {
    const pkg = JSON.parse(readTarballFile(byName(packs, name).tarball, "package.json"));
    expect(pkg.dependencies["@brainervirus/workit-core"], name).toBe(`^${coreVersion}`);
  }
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
