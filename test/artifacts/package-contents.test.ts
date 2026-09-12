import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listTarball,
  packWorkspacePackages,
  readTarballFile,
  REPO_ROOT,
} from "@/test/shared/helpers/packages";

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
const isAllowedTs = (entry: string) =>
  (entry.startsWith("assets/vendor/") || entry.startsWith("vendor/")) && entry.endsWith(".ts");

const tsEntries = (tarball: string) =>
  listTarball(tarball).filter((e) => e.endsWith(".ts") && !isAllowedTs(e));

const distJs = (tarball: string, prefix = "dist/") =>
  listTarball(tarball).filter((e) => e.startsWith(prefix) && e.endsWith(".js"));

test("opencode tarball ships one bundled dist entry plus fourteen method skills (RR-02/PT-06/PT-07)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, OPENCODE).tarball;
  const entries = listTarball(tarball);

  expect(entries).toContain("dist/plugin.js");
  expect(entries.filter((e) => e.startsWith("assets/skills/") && e.endsWith("/SKILL.md"))).toEqual([
    "assets/skills/workit-babysit/SKILL.md",
    "assets/skills/workit-behavioral-tdd/SKILL.md",
    "assets/skills/workit-blast-radius/SKILL.md",
    "assets/skills/workit-challenge/SKILL.md",
    "assets/skills/workit-debug/SKILL.md",
    "assets/skills/workit-deslop/SKILL.md",
    "assets/skills/workit-diagram/SKILL.md",
    "assets/skills/workit-green-run/SKILL.md",
    "assets/skills/workit-handoff/SKILL.md",
    "assets/skills/workit-implement/SKILL.md",
    "assets/skills/workit-mockup/SKILL.md",
    "assets/skills/workit-plan/SKILL.md",
    "assets/skills/workit-review/SKILL.md",
    "assets/skills/workit-steer/SKILL.md",
  ]);
  expect(entries.some((e) => e.startsWith("assets/commands/"))).toBe(false);
  expect(entries.some((e) => e.startsWith("assets/templates/"))).toBe(false);
  expect(entries.some((e) => e.startsWith("assets/vendor/"))).toBe(false);
  expect(tsEntries(tarball)).toEqual([]);

  // CA-07: the SDK helper/schema runtime is bundled, so the packed entry has no
  // unresolved `@opencode-ai/plugin` import to resolve at load time.
  const pluginJs = readTarballFile(tarball, "dist/plugin.js");
  expect(pluginJs, "dist/plugin.js").not.toMatch(
    /(?:from\s+|import\s*\(\s*)\s*["']@opencode-ai\/plugin["']/,
  );
});

test("cursor tarball ships dist MCP + hook entries, manifests, assets and npm bins (RR-03/PT-07/CA-16)", () => {
  const packs = packWorkspacePackages();
  const tarball = byName(packs, CURSOR).tarball;
  const entries = listTarball(tarball);

  for (const required of [
    "dist/mcp-server.js",
    "dist/cursor-session-start.js",
    "dist/workit-hook.js",
    "mcp.json",
    "assets/logo.svg",
    ".cursor-plugin/plugin.json",
    "hooks/hooks-cursor.json",
  ]) {
    expect(entries, required).toContain(required);
  }
  // CA-17: the obsolete shell launchers ship no longer — the plugin launches
  // the published package through npx, not a repo-relative dist/sh file.
  expect(entries).not.toContain("mcp/run-server.sh");
  expect(entries).not.toContain("hooks/session-start");
  expect(entries.some((e) => e.startsWith("assets/templates/"))).toBe(true);
  expect(tsEntries(tarball)).toEqual([]);

  // CA-16: the packed package.json exposes both npm executables at the exact
  // built entry paths (no wrapper files, no source entries).
  const pkg = JSON.parse(readTarballFile(tarball, "package.json"));
  expect(pkg.bin).toEqual({
    "workit-cursor-mcp": "./dist/mcp-server.js",
    "workit-cursor-session-start": "./dist/cursor-session-start.js",
    "workit-cursor-hook": "./dist/workit-hook.js",
  });
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

test("core tarball keeps its source package layout without legacy vendor shell (PT-08)", () => {
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
  ]) {
    expect(
      entries.some((e) => e.startsWith(required)),
      required,
    ).toBe(true);
  }
  expect(entries.some((e) => e.includes("vendor/superpowers"))).toBe(false);
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
      expect(js, `${pack.packageName}/${entry}`).not.toContain(".local/share/workit");
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

// --- Finding: vendored content must be inert and internally consistent ---
// The opencode build copies the core vendor skill tree into assets/vendor with a
// filter that dropped only `.sh`, so executable shell/JS tools shipped alongside
// skill markdown that (after filtering) referenced them. Packaged vendor content
// must ship no executable or shebang file, and shipped vendor markdown must not
// point at files that the build filtered out (unless explicitly allowlisted as
// intentionally filtered operational tools).

test("cursor build has no vendored legacy skills", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-cursor-windows-mode-"));
  const target = path.join(fixture, "output");
  try {
    mkdirSync(path.join(fixture, "packages"));
    for (const pkg of ["workit-core", "workit-cursor"]) {
      cpSync(path.join(REPO_ROOT, "packages", pkg), path.join(fixture, "packages", pkg), {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}node_modules`),
      });
    }
    symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(fixture, "node_modules"),
      "junction",
    );
    const build = spawnSync(
      "bun",
      [path.join(fixture, "packages/workit-cursor/scripts/build.ts"), target],
      { encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    expect(existsSync(path.join(target, "vendor"))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// --- Tool-rename content gate: shipped prose names only live workit_* tools ---
// The orchestration tools are registered as workit_*; a live workflow_*
// reference in shipped skill/template/vendor markdown points at a tool that no
// longer exists. Uppercase WORKFLOW_* env names are out of scope and stay.
const LIVE_WORKFLOW_TOOL = /\bworkflow_[a-z0-9_]+\b/;
const LIVE_WORKIT_TOOL = /\bworkit_[a-z0-9_]+\b/;
const CONTENT_TREES = [
  "skills/",
  "templates/",
  "vendor/",
  "rules/",
  "assets/skills/",
  "assets/templates/",
  "assets/vendor/",
];

const RETIRED_CURSOR_ROUTE = /\bworkit_(?:sdd_[a-z0-9_]*|resolve_branch|branch_setup|doctor)\b/;

test("Cursor ships one contract rule and no retired workflow routes", () => {
  const tarball = byName(packWorkspacePackages(), CURSOR).tarball;
  const offenders: string[] = [];
  for (const entry of listTarball(tarball)) {
    if (!entry.endsWith(".md") && !entry.endsWith(".mdc")) continue;
    if (
      !entry.startsWith("rules/") &&
      !entry.startsWith("skills/") &&
      !entry.startsWith("assets/skills/") &&
      !entry.startsWith("assets/templates/") &&
      entry !== "README.md"
    )
      continue;
    const stale = RETIRED_CURSOR_ROUTE.exec(readTarballFile(tarball, entry));
    if (stale) offenders.push(`${entry}: ${stale[0]}`);
  }
  expect(offenders).toEqual([]);
  expect(
    listTarball(tarball).filter((entry) => entry.startsWith("rules/") && entry.endsWith(".mdc")),
  ).toEqual(["rules/workit-contract.mdc"]);
});

test("shipped skill/template/vendor markdown uses workit_ tool identifiers with no live workflow_ references", () => {
  const packs = packWorkspacePackages();
  for (const pack of packs) {
    const offenders: string[] = [];
    let sawWorkitTool = false;
    for (const entry of listTarball(pack.tarball)) {
      if (!entry.endsWith(".md") && !entry.endsWith(".mdc")) continue;
      if (!CONTENT_TREES.some((tree) => entry.startsWith(tree))) continue;
      const md = readTarballFile(pack.tarball, entry);
      const stale = LIVE_WORKFLOW_TOOL.exec(md);
      if (stale) offenders.push(`${entry}: ${stale[0]}`);
      if (LIVE_WORKIT_TOOL.test(md)) sawWorkitTool = true;
    }
    expect(offenders, `${pack.packageName} ships stale workflow_ tool references`).toEqual([]);
    if (
      pack.packageName !== OPENCODE &&
      pack.packageName !== CURSOR &&
      pack.packageName !== "@brainervirus/workit-mcp" &&
      pack.packageName !== "@brainervirus/workit-codex" &&
      pack.packageName !== "@brainervirus/workit-pi"
    )
      expect(sawWorkitTool, `${pack.packageName} ships renamed workit_ tool references`).toBe(true);
  }
});

test("adapter tarballs ship no legacy vendor trees", () => {
  const packs = packWorkspacePackages();
  for (const pack of packs) {
    const entries = listTarball(pack.tarball);
    expect(
      entries.some((e) => e.includes("vendor/superpowers")),
      pack.packageName,
    ).toBe(false);
    expect(
      entries.some((e) => e.startsWith("assets/vendor/")),
      pack.packageName,
    ).toBe(false);
  }
});

test("tracked CLI template mirrors stay byte-identical to the core templates", () => {
  // The CLI package tracks copies of the execution templates (shipped to
  // projects by hygiene scaffolding); a fix in one copy must land in both.
  for (const name of ["execution-contract.md", "plan-template.md"]) {
    const core = readFileSync(path.join(REPO_ROOT, "packages/workit-core/templates", name), "utf8");
    const mirror = readFileSync(
      path.join(REPO_ROOT, "packages/workit-cli/assets/templates", name),
      "utf8",
    );
    expect(mirror, name).toBe(core);
  }
});
