import { expect, test } from "bun:test";
import path from "node:path";
import {
  listTarball,
  packWorkspacePackages,
  readTarballFile,
  REPO_ROOT,
} from "../shared/helpers/packages";

// Task 7 package-content gate: every adapter tarball ships ONE package-local JS
// entry plus deterministic package-local assets, and carries NO raw TypeScript,
// workspace protocols, core source-subpath imports, split CLI chunks, checkout
// paths, active vendored shell, or undeclared dependency resolution.

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

// Files that are allowed to stay in a tarball even though they are `.ts`:
// vendored upstream skill examples are documented test/vendor data, not runtime
// entries of this project.
const isAllowedTs = (entry: string) => entry.startsWith("assets/vendor/") && entry.endsWith(".ts");

const tsEntries = (tarball: string) =>
  listTarball(tarball).filter((e) => e.endsWith(".ts") && !isAllowedTs(e));

const distJs = (tarball: string, prefix = "dist/") =>
  listTarball(tarball).filter((e) => e.startsWith(prefix) && e.endsWith(".js"));

test("opencode tarball ships one bundled dist entry plus its own assets (RR-02/PT-06/PT-07)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, OPENCODE).tarball;
  const entries = listTarball(tarball);

  expect(entries).toContain("dist/plugin.js");
  expect(entries.some((e) => e.startsWith("assets/commands/"))).toBe(true);
  expect(entries.some((e) => e.startsWith("assets/skills/"))).toBe(true);
  expect(entries.some((e) => e.startsWith("assets/templates/"))).toBe(true);
  expect(entries.some((e) => e.startsWith("assets/vendor/superpowers/skills/"))).toBe(true);
  expect(tsEntries(tarball)).toEqual([]);
});

test("cursor tarball ships dist MCP + hook entries, package-relative manifests and assets (RR-03/PT-07)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, CURSOR).tarball;
  const entries = listTarball(tarball);

  for (const required of [
    "dist/mcp-server.js",
    "dist/cursor-session-start.js",
    "mcp/run-server.sh",
    "mcp.json",
    "marketplace.json",
    ".cursor-plugin/plugin.json",
    "hooks/session-start",
    "hooks/hooks-cursor.json",
  ]) {
    expect(entries, required).toContain(required);
  }
  expect(entries.some((e) => e.startsWith("assets/templates/"))).toBe(true);
  expect(tsEntries(tarball)).toEqual([]);
});

test("cli tarball ships a single nonsplitting dist entry plus bin (PT-10)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, CLI).tarball;
  const entries = listTarball(tarball);

  expect(entries).toContain("dist/index.js");
  expect(distJs(tarball)).toEqual(["dist/index.js"]);
  const pkg = JSON.parse(readTarballFile(tarball, "package.json"));
  expect(pkg.bin.workit).toBe("./dist/index.js");
  expect(tsEntries(tarball)).toEqual([]);
});

test("core tarball keeps its source package layout but drops the dead vendored shell (PT-08)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, CORE).tarball;
  const entries = listTarball(tarball);

  for (const required of [
    "src/core.ts",
    "scripts/rewrite-workspace-deps.ts",
    "scripts/install-opencode-plugin.sh",
    "scripts/sync-runtime.sh",
    "templates/",
    "skills/",
    "vendor/superpowers/skills/",
  ]) {
    expect(
      entries.some((e) => e.startsWith(required)),
      required,
    ).toBe(true);
  }
  expect(entries).not.toContain("scripts/verify-project.sh");
});

test("no packed package.json carries a workspace:, file: or git: protocol (CA-03)", () => {
  const packs = packWorkspacePackages();
  for (const pack of packs) {
    const raw = readTarballFile(pack.tarball, "package.json");
    expect(raw, pack.packageName).not.toContain("workspace:");
    expect(raw, pack.packageName).not.toContain("file:");
    expect(raw, pack.packageName).not.toContain("git:");
  }
});

test("packed runtime JS imports no core source subpaths and no checkout paths", () => {
  const packs = packWorkspacePackages();
  const normalized = REPO_ROOT.split(path.sep).join("/");
  for (const pack of packs) {
    if (pack.packageName === CORE) continue; // source package ships src/*.ts by design
    for (const entry of distJs(pack.tarball)) {
      const js = readTarballFile(pack.tarball, entry);
      expect(js, `${pack.packageName}/${entry}`).not.toContain("@brainervirus/workit-core/src/");
      // bun bakes relative `// packages/...` source comments (harmless), but no
      // absolute checkout or share paths may leak into packaged runtime JS.
      expect(js, `${pack.packageName}/${entry}`).not.toContain(normalized);
      expect(js, `${pack.packageName}/${entry}`).not.toContain(".local/share/workflow-toolkit");
    }
  }
});

test("packed runtime JS resolves only declared dependencies (RR-08)", () => {
  const packs = packWorkspacePackages();
  const nodeBuiltins = new Set([
    "node:assert",
    "node:async_hooks",
    "node:buffer",
    "node:child_process",
    "node:cluster",
    "node:console",
    "node:constants",
    "node:crypto",
    "node:dgram",
    "node:diagnostics_channel",
    "node:dns",
    "node:domain",
    "node:events",
    "node:fs",
    "node:http",
    "node:http2",
    "node:https",
    "node:inspector",
    "node:module",
    "node:net",
    "node:os",
    "node:path",
    "node:perf_hooks",
    "node:process",
    "node:punycode",
    "node:querystring",
    "node:readline",
    "node:repl",
    "node:stream",
    "node:string_decoder",
    "node:sys",
    "node:timers",
    "node:tls",
    "node:trace_events",
    "node:tty",
    "node:url",
    "node:util",
    "node:v8",
    "node:vm",
    "node:wasi",
    "node:worker_threads",
    "node:zlib",
  ]);
  for (const pack of packs) {
    if (pack.packageName === CORE) continue; // source package, not bundled JS
    const pkg = JSON.parse(readTarballFile(pack.tarball, "package.json"));
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    for (const entry of distJs(pack.tarball)) {
      const js = readTarballFile(pack.tarball, entry);
      const found = new Set<string>();
      // Only literal string specifiers count as runtime dependency resolution;
      // bun's codegen for computed `import(expr)` is not a literal import.
      const re = /(?:from\s+|import\s*\(\s*)\s*["']([^"'\s]+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(js)) !== null) {
        const spec = m[1];
        if (spec.startsWith("node:") || nodeBuiltins.has(spec)) continue;
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        found.add(spec);
      }
      const undeclared = [...found].filter((s) => !declared.has(s));
      expect(undeclared, `${pack.packageName}/${entry}`).toEqual([]);
    }
  }
});

test("adapter tarballs expose a top-level assets root and no runtime TypeScript", () => {
  const packs = packWorkspacePackages();
  for (const name of [OPENCODE, CURSOR, CLI]) {
    const tarball = byName(packs, name).tarball;
    expect(
      listTarball(tarball).some((e) => e.startsWith("assets/")),
      name,
    ).toBe(true);
    expect(tsEntries(tarball), name).toEqual([]);
  }
});
