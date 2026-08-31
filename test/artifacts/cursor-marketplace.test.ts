import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  CANONICAL_SKILLS,
  validateSkillManifests,
} from "../../packages/workit-core/src/core/skill-manifests";
import { validateMarketplace } from "../../packages/workit-core/scripts/validate-cursor-marketplace";
import { REPO_ROOT } from "../shared/helpers/packages";

// Task 9 Marketplace gate (CA-13/CA-15/CA-17/CA-21): the tracked Marketplace
// artifact validates against the official Cursor JSON schemas and every
// repository-specific invariant holds from a clean `git ls-files` checkout —
// no reliance on dist/ or other ignored build output.
//
// Official schema snapshots (test/fixtures/cursor-schemas/) are verbatim copies
// of the current official schemas, retrieved 2026-08-13 from:
//   - https://raw.githubusercontent.com/cursor/plugins/main/schemas/plugin.schema.json
//   - https://raw.githubusercontent.com/cursor/plugins/main/schemas/marketplace.schema.json
//
// `source` path resolution (Task 7 carry-forward, RESOLVED): the official
// marketplace.schema.json documents `plugins[].source` as "Path to the plugin
// directory (relative to the marketplace root)". The marketplace root is the
// directory that CONTAINS `.cursor-plugin/marketplace.json` — i.e. the repo
// root — NOT `.cursor-plugin/` itself. Evidence: the official cursor/plugins
// repo keeps `.cursor-plugin/marketplace.json` at the repo root and lists
// sources like `continual-learning` and `third_party/gmail` with no `../`
// prefix, even though `.cursor-plugin/` is a sibling of those directories.
// Therefore `source: "packages/workit-cursor"` is correct and kept verbatim.

const MARKETPLACE_REL = ".cursor-plugin/marketplace.json";
const PLUGIN_DIR_REL = "packages/workit-cursor";
const PLUGIN_MANIFEST_REL = path.join(PLUGIN_DIR_REL, ".cursor-plugin/plugin.json");

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

const ajv = () => {
  const instance = new Ajv({ strict: true, allErrors: true });
  addFormats(instance);
  return instance;
};

// Populate a temp dir with ONLY the git-tracked files (a clean checkout with no
// dist/, no vendor build output, no ignored files).
const cleanCheckoutCopy = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-marketplace-clean-"));
  const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (tracked.status !== 0) throw new Error(`git ls-files failed: ${tracked.stderr}`);
  for (const rel of tracked.stdout.trim().split("\n").filter(Boolean)) {
    const src = path.join(REPO_ROOT, rel);
    if (!existsSync(src)) continue;
    const dst = path.join(dir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
  return dir;
};

// Frontmatter block keys (leading `---` YAML-ish block) present in a file.
const frontmatterKeys = (file: string): Set<string> => {
  const head = readFileSync(file, "utf8").slice(0, 4096);
  if (!head.startsWith("---")) return new Set();
  const end = head.indexOf("\n---", 3);
  if (end === -1) return new Set();
  const keys = new Set<string>();
  for (const line of head.slice(3, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
};

test(
  "both official JSON schemas validate the tracked manifests (CA-13)",
  () => {
    const validate = ajv();
    const pluginSchema = JSON.parse(read("test/fixtures/cursor-schemas/plugin.schema.json"));
    const marketSchema = JSON.parse(read("test/fixtures/cursor-schemas/marketplace.schema.json"));
    const market = json(MARKETPLACE_REL);
    const plugin = json(PLUGIN_MANIFEST_REL);
    const marketValid = validate.validate(marketSchema, market);
    expect(validate.errors ?? [], "marketplace.json").toEqual([]);
    expect(marketValid).toBe(true);
    const pluginValid = validate.validate(pluginSchema, plugin);
    expect(validate.errors ?? [], "plugin.json").toEqual([]);
    expect(pluginValid).toBe(true);
  },
  { timeout: 60_000 },
);

test(
  "marketplace.json source resolves to the plugin dir relative to the repo root",
  () => {
    const market = json<{ plugins: { name: string; source: string }[] }>(MARKETPLACE_REL);
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry.source).toBe("packages/workit-cursor");
    const pluginRoot = path.join(REPO_ROOT, entry.source);
    expect(existsSync(path.join(pluginRoot, ".cursor-plugin/plugin.json"))).toBe(true);
    const plugin = json<{ name: string }>(PLUGIN_MANIFEST_REL);
    expect(plugin.name).toBe(entry.name);
  },
  { timeout: 60_000 },
);

test(
  "every manifest component path resolves inside the plugin root, logo exists (CA-14/CA-17)",
  () => {
    const plugin = json<Record<string, string | string[]>>(PLUGIN_MANIFEST_REL);
    const root = path.join(REPO_ROOT, PLUGIN_DIR_REL);
    const fields = ["skills", "rules", "mcpServers", "hooks"] as const;
    for (const field of fields) {
      const value = plugin[field];
      for (const rel of Array.isArray(value) ? value : [value]) {
        expect(rel, field).not.toContain("..");
        expect(rel, field).not.toMatch(/^\//);
        const abs = path.join(root, rel);
        expect(existsSync(abs), `${field}: ${rel}`).toBe(true);
      }
    }
    const logo = path.join(root, plugin.logo as string);
    expect(existsSync(logo), "logo").toBe(true);
  },
  { timeout: 60_000 },
);

test(
  "all declared skills and rules have valid frontmatter (CA-15)",
  () => {
    const root = path.join(REPO_ROOT, PLUGIN_DIR_REL);
    for (const [dir, skills] of [
      [path.join(root, "skills"), CANONICAL_SKILLS.workit],
      [path.join(root, "vendor/superpowers/skills"), CANONICAL_SKILLS.superpowers],
    ] as const) {
      expect(validateSkillManifests(dir, skills, "skills")).toBeNull();
      for (const skill of skills) {
        const keys = frontmatterKeys(path.join(dir, skill, "SKILL.md"));
        expect(keys.has("name"), `${skill}/SKILL.md name`).toBe(true);
        expect(keys.has("description"), `${skill}/SKILL.md description`).toBe(true);
      }
    }
    const rulesDir = path.join(root, "rules");
    for (const rule of readdirSync(rulesDir).filter((f) => f.endsWith(".mdc"))) {
      const keys = frontmatterKeys(path.join(rulesDir, rule));
      expect(keys.has("description"), `${rule} description`).toBe(true);
    }
  },
  { timeout: 60_000 },
);

test(
  "no active runtime path targets an ignored dist file (CA-17)",
  () => {
    for (const rel of [
      "packages/workit-cursor/mcp.json",
      "packages/workit-cursor/hooks/hooks-cursor.json",
    ]) {
      const raw = read(rel);
      expect(raw, rel).not.toContain("dist/");
      expect(raw, rel).not.toContain("run-server");
      expect(raw, rel).not.toContain("session-start.js");
    }
  },
  { timeout: 60_000 },
);

test(
  "rebuilding the sanitized vendor tree yields no diff (CA-15)",
  () => {
    expect(validateMarketplace(REPO_ROOT)).toEqual([]);
  },
  { timeout: 60_000 },
);

test(
  "vendor content drift in a non-last skill is detected (regression)",
  () => {
    const dir = cleanCheckoutCopy();
    try {
      const skill = path.join(
        dir,
        PLUGIN_DIR_REL,
        "vendor/superpowers/skills/brainstorming/SKILL.md",
      );
      appendFileSync(skill, "\n// sentinel drift line\n");
      const errors = validateMarketplace(dir);
      expect(errors.some((e) => e.includes("vendor drift"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "validate:cursor-marketplace passes on a clean git ls-files checkout (CA-21)",
  () => {
    const dir = cleanCheckoutCopy();
    try {
      const run = spawnSync("bun", ["run", "validate:cursor-marketplace", dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(run.stdout).toContain("marketplace validation passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "inline-object hooks/mcpServers never crash the component-path loop (T9)",
  () => {
    const dir = cleanCheckoutCopy();
    try {
      const manifestPath = path.join(dir, PLUGIN_MANIFEST_REL);
      const plugin = JSON.parse(readFileSync(manifestPath, "utf8"));
      plugin.hooks = { "post-tool-use": { command: "npx workit-cursor-session-start" } };
      plugin.mcpServers = { workit: { command: "npx", args: ["-y", "workit-cursor-mcp"] } };
      writeFileSync(manifestPath, JSON.stringify(plugin, null, 2));
      // The validator must not throw on the schema-valid inline-object form; it
      // either validates cleanly or reports schema errors — never a TypeError.
      const errors = validateMarketplace(dir);
      expect(Array.isArray(errors)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
