import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CANONICAL_SKILLS } from "../../packages/workit-core/src/core/skill-manifests";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import {
  listTarball,
  packWorkspacePackages,
  readTarballFile,
  REPO_ROOT,
} from "../shared/helpers/packages";

// Task 8 manifest gate (RR-07 / PT-10 / RR-10 / PT-11 / PT-12): the shipped
// OpenCode + Cursor manifests are package-relative and invoke Node explicitly,
// and the pinned toolchain/support-matrix constants declared in CI and in the
// package metadata stay in sync with SUPPORT_MATRIX. Deno is never advertised.

const CURSOR = "@brainervirus/workit-cursor";
const OPENCODE = "@brainervirus/workit-opencode";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

// Advisory #4 (cursor-npx-runtime-latest): the canonical selector is `@latest`
// with the mandatory `--prefer-online` flag; a future change must fail CI if
// any selector is missed. Every active Cursor runtime selector carries both,
// and only the doctor's intentional negative-rejection fixture may carry
// variants.
const CURSOR_RUNTIME_SELECTOR = /--package=@brainervirus\/workit-cursor@([^\s"'${}`]+)/g;
const CURSOR_RUNTIME_FLAG = "--prefer-online";
const CURSOR_DOCTOR_NEGATIVE_VARIANTS = [
  "latest",
  "latest-alpha",
  "0.8.5-alpha",
  "0.8.50",
  "0.8.5",
];

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

test("cursor mcp.json launches the published package via npx (CA-17)", () => {
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/mcp.json")
        : readTarballFile(byName(packWorkspacePackages(), CURSOR).tarball, "mcp.json");
    const mcp = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers.workit;
    expect(server, source).toBeDefined();
    expect(server.command, source).toBe("npx");
    expect(server.args, source).toEqual([
      "-y",
      "--prefer-online",
      "--package=@brainervirus/workit-cursor@latest",
      "workit-cursor-mcp",
      "${workspaceFolder}",
    ]);
    const joined = [...server.args].join(" ");
    expect(joined, source).not.toContain("dist/");
    expect(joined, source).not.toContain("run-server");
    expect(joined, source).not.toMatch(/\$HOME/);
    expect(joined, source).not.toContain(".local/share");
    expect(joined, source).not.toContain("Documents/projects");
    expect(joined, source).not.toMatch(/^\//);
  }
});

test("cursor hooks-cursor.json uses the documented single command string (CA-17)", () => {
  const packs = packWorkspacePackages();
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/hooks/hooks-cursor.json")
        : readTarballFile(byName(packs, CURSOR).tarball, "hooks/hooks-cursor.json");
    const hooks = JSON.parse(raw) as {
      version: number;
      hooks: { sessionStart: { command: string; args?: string[] }[] };
    };
    expect(hooks.version, source).toBe(1);
    const entry = hooks.hooks.sessionStart[0];
    expect(entry.command, source).toBe(
      "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
    );
    expect(entry.args, source).toBeUndefined();
    expect(JSON.stringify(entry), source).not.toContain("dist/");
    expect(JSON.stringify(entry), source).not.toContain("run-server");
    expect(JSON.stringify(entry), source).not.toMatch(/\$HOME/);
    expect(JSON.stringify(entry), source).not.toMatch(/^\//);
  }
});

test("active Cursor runtime selectors use the canonical @latest + --prefer-online (except the doctor negative fixture)", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "packages", "test"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);
  const files = tracked.stdout.trim().split("\n").filter(Boolean);

  const stale: string[] = [];
  for (const file of files) {
    const text = read(file);
    const fixture = file === "test/workit-core/doctor.test.ts";
    for (const match of text.matchAll(CURSOR_RUNTIME_SELECTOR)) {
      const selector = match[1];
      if (selector === "latest") {
        // --prefer-online is mandatory next to every active selector.
        if (!text.includes(CURSOR_RUNTIME_FLAG)) stale.push(`${file}: missing --prefer-online`);
        continue;
      }
      if (fixture && CURSOR_DOCTOR_NEGATIVE_VARIANTS.includes(selector)) continue;
      stale.push(`${file}: @brainervirus/workit-cursor@${selector}`);
    }
  }
  expect(stale).toEqual([]);

  // The canonical constant itself must stay the exact reviewed selector — a
  // bump to the shared constant alone would otherwise dodge the --package= scan
  // above.
  expect(read("packages/workit-core/src/core/registration.ts")).toContain(
    `CURSOR_RUNTIME_PACKAGE = "@brainervirus/workit-cursor@latest"`,
  );

  // Removing a negative-rejection variant must break loudly, never silently
  // narrow the allowlist.
  const doctor = read("test/workit-core/doctor.test.ts");
  for (const variant of CURSOR_DOCTOR_NEGATIVE_VARIANTS) {
    expect(doctor, variant).toContain(`@brainervirus/workit-cursor@${variant}`);
  }
});

test("cursor package.json declares the MCP and session-start npm executables (CA-16)", () => {
  const pkg = json<{ bin?: Record<string, string> }>("packages/workit-cursor/package.json");
  expect(pkg.bin).toEqual({
    "workit-cursor-mcp": "./dist/mcp-server.js",
    "workit-cursor-session-start": "./dist/cursor-session-start.js",
  });
  const packed = JSON.parse(
    readTarballFile(byName(packWorkspacePackages(), CURSOR).tarball, "package.json"),
  );
  expect(packed.bin, "packed").toEqual(pkg.bin);
});

test("cursor .cursor-plugin/plugin.json uses valid plugin-root-relative components", () => {
  const packs = packWorkspacePackages();
  const pkg = json<{ version: string }>("packages/workit-cursor/package.json");
  const packed = byName(packs, CURSOR).tarball;
  let packedPlugin: Record<string, string | string[]>;
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/.cursor-plugin/plugin.json")
        : readTarballFile(packed, ".cursor-plugin/plugin.json");
    const plugin = JSON.parse(raw) as Record<string, string | string[]>;
    if (source === "packed") packedPlugin = plugin;
    expect(plugin.version, source).toBe(pkg.version);
    expect(plugin.logo, source).toBe("assets/logo.svg");
    expect(plugin.skills, source).toEqual(["skills/", "vendor/superpowers/skills/"]);
    expect(plugin.rules, source).toBe("rules/");
    expect(plugin.mcpServers, source).toBe("mcp.json");
    expect(plugin.hooks, source).toBe("hooks/hooks-cursor.json");
    for (const field of [plugin.skills, plugin.rules, plugin.mcpServers, plugin.hooks]) {
      for (const value of Array.isArray(field) ? field : [field]) {
        expect(value, source).not.toContain("..");
        expect(value, source).not.toMatch(/^\//);
        expect(value, source).not.toContain("$HOME");
      }
    }
  }

  const entries = new Set(listTarball(packed));
  expect(entries.has("assets/logo.svg")).toBe(true);
  for (const field of [
    packedPlugin!.skills,
    packedPlugin!.rules,
    packedPlugin!.mcpServers,
    packedPlugin!.hooks,
  ]) {
    for (const value of Array.isArray(field) ? field : [field]) {
      expect(
        value.endsWith("/")
          ? [...entries].some((entry) => entry.startsWith(value))
          : entries.has(value),
        value,
      ).toBe(true);
    }
  }

  const packedSkills = [...entries].filter((entry) => entry.endsWith("/SKILL.md"));
  expect(packedSkills).toHaveLength(26);
  for (const [source, target] of [
    ["packages/workit-cursor/skills", "skills"],
    ["packages/workit-core/vendor/superpowers/skills", "vendor/superpowers/skills"],
  ] as const) {
    const skills = readdirSync(path.join(REPO_ROOT, source)).filter((name) =>
      existsSync(path.join(REPO_ROOT, source, name, "SKILL.md")),
    );
    for (const skill of skills) {
      expect(entries, `${target}/${skill}/SKILL.md`).toContain(`${target}/${skill}/SKILL.md`);
    }
  }
});

test("root .cursor-plugin/marketplace.json indexes packages/workit-cursor (CA-13)", () => {
  const market = json<{
    name: string;
    owner?: { name: string };
    plugins: { name: string; source: string }[];
  }>(".cursor-plugin/marketplace.json");
  expect(market.name).toBe("workit");
  expect(market.owner?.name).toBe("BrainerVirus");
  expect(market.plugins).toHaveLength(1);
  expect(market.plugins[0].name).toBe("workit");
  expect(market.plugins[0].source).toBe("packages/workit-cursor");
});

test("package plugin manifest carries complete metadata and a committed logo (CA-14)", () => {
  const plugin = json<Record<string, unknown>>("packages/workit-cursor/.cursor-plugin/plugin.json");
  expect(plugin.name).toBe("workit");
  expect(plugin.displayName).toBe("Workit");
  expect(plugin.author).toEqual({ name: "Cristhofer Pincetti" });
  expect(plugin.publisher).toBe("BrainerVirus");
  expect(plugin.repository).toBe("https://github.com/BrainerVirus/workit");
  expect(plugin.homepage).toBe("https://github.com/BrainerVirus/workit");
  expect(plugin.license).toBe("MIT");
  expect(plugin.logo).toBe("assets/logo.svg");
  expect(plugin.keywords).toBeInstanceOf(Array);
  expect(typeof plugin.category).toBe("string");
  expect(plugin.tags).toBeInstanceOf(Array);
  expect(existsSync(path.join(REPO_ROOT, "packages/workit-cursor/assets/logo.svg"))).toBe(true);
});

test("obsolete flat package marketplace.json is absent (CA-13)", () => {
  expect(existsSync(path.join(REPO_ROOT, "packages/workit-cursor/marketplace.json"))).toBe(false);
});

test("clean checkout tracks all 26 declared skills and four rules (CA-15)", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "packages/workit-cursor"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);
  const files = new Set(tracked.stdout.trim().split("\n").filter(Boolean));
  for (const skill of CANONICAL_SKILLS.workit) {
    expect(files.has(`packages/workit-cursor/skills/${skill}/SKILL.md`), skill).toBe(true);
  }
  for (const skill of CANONICAL_SKILLS.superpowers) {
    expect(
      files.has(`packages/workit-cursor/vendor/superpowers/skills/${skill}/SKILL.md`),
      skill,
    ).toBe(true);
  }
  for (const rule of [
    "ask-question-only.mdc",
    "cursor-todowrite.mdc",
    "no-worktrees.mdc",
    "sdd-docs-path.mdc",
  ]) {
    expect(files.has(`packages/workit-cursor/rules/${rule}`), rule).toBe(true);
  }
});

test("opencode package.json ships a package-relative plugin entry and pins the SDK build-only", () => {
  const pkg = json<{
    main: string;
    exports: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
  }>("packages/workit-opencode/package.json");
  expect(pkg.main).toBe("./dist/plugin.js");
  expect(Object.values(pkg.exports)).toContain("./dist/plugin.js");
  expect(pkg.dependencies?.["@opencode-ai/plugin"]).toBeUndefined();
  expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe(SUPPORT_MATRIX.opencode.current);
  expect(pkg.engines?.node).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
});

test("all platform packages declare the Node minimum and publish no OpenCode SDK runtime dependency", () => {
  const packs = packWorkspacePackages();
  for (const name of [OPENCODE, CURSOR]) {
    const raw = readTarballFile(byName(packs, name).tarball, "package.json");
    const pkg = JSON.parse(raw) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    };
    expect(pkg.engines?.node, name).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
    if (name === OPENCODE) {
      expect(pkg.dependencies?.["@opencode-ai/plugin"], name).toBeUndefined();
    }
  }
  const cli = json<{ engines?: { node?: string } }>("packages/workit-cli/package.json");
  expect(cli.engines?.node).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
});

test("ci.yml pins the declared support matrix (Bun/Node/OpenCode, 3 OS, no Deno)", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain(`BUN_VERSION: "${SUPPORT_MATRIX.bun}"`);
  expect(ci).toContain(`NODE_MINIMUM: "${SUPPORT_MATRIX.node.minimum}"`);
  expect(ci).toContain(`NODE_CURRENT: "${SUPPORT_MATRIX.node.current}"`);
  expect(ci).toContain(`OPENCODE_MINIMUM: "${SUPPORT_MATRIX.opencode.minimum}"`);
  expect(ci).toContain(`OPENCODE_CURRENT: "${SUPPORT_MATRIX.opencode.current}"`);
  expect(ci).toContain("bun-version: ${{ env.BUN_VERSION }}");
  for (const os of SUPPORT_MATRIX.os) {
    expect(ci).toContain(os);
  }
  expect(ci).toMatch(/node:\s*\[22\]/);
  expect(ci).not.toMatch(/[Dd]eno/);
});

test("bun.lock pins the declared Bun types and the current OpenCode SDK", () => {
  const lock = read("bun.lock");
  expect(lock).toContain(`"@types/bun": "${SUPPORT_MATRIX.bun}"`);
  expect(lock).toContain(`"@opencode-ai/plugin": "${SUPPORT_MATRIX.opencode.current}"`);
});
