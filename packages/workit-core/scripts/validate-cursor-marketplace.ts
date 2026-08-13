#!/usr/bin/env bun
// Cursor Marketplace validator (Task 9, CA-13/CA-15/CA-17/CA-21): validates the
// tracked Marketplace artifact against the official Cursor JSON schemas plus the
// repository-specific invariants that a JSON Schema cannot express. Runs from a
// clean `git ls-files` checkout — it never reads dist/ or other ignored build
// output, so `bun run validate:cursor-marketplace` is a truthful clean-checkout
// gate for CI.
//
// Official schema snapshots (test/fixtures/cursor-schemas/) are verbatim copies
// of the current official schemas, retrieved 2026-08-13 from:
//   - https://raw.githubusercontent.com/cursor/plugins/main/schemas/plugin.schema.json
//   - https://raw.githubusercontent.com/cursor/plugins/main/schemas/marketplace.schema.json
//
// `source` path resolution (Task 7 carry-forward, RESOLVED): the official
// marketplace.schema.json documents `plugins[].source` as "Path to the plugin
// directory (relative to the marketplace root)". The marketplace root is the
// directory that CONTAINS `.cursor-plugin/marketplace.json` — the repo root —
// NOT `.cursor-plugin/` itself. Evidence: the official cursor/plugins repo keeps
// `.cursor-plugin/marketplace.json` at the repo root and lists sources such as
// `continual-learning` and `third_party/gmail` with no `../` prefix, even though
// `.cursor-plugin/` is a sibling of those directories. Therefore
// `source: "packages/workit-cursor"` is correct and kept verbatim.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { CANONICAL_SKILLS, validateSkillManifests } from "../src/core/skill-manifests";
import { copySanitizedVendor } from "./vendor-assets";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const root = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;

const MARKETPLACE_REL = ".cursor-plugin/marketplace.json";

const frontmatterKeys = (file: string): Set<string> => {
  const head = readFileSync(file, "utf8").slice(0, 4096);
  const keys = new Set<string>();
  if (!head.startsWith("---")) return keys;
  const end = head.indexOf("\n---", 3);
  if (end === -1) return keys;
  for (const line of head.slice(3, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
};

const treesEqual = (a: string, b: string): string[] => {
  const diffs: string[] = [];
  // Thread the tree root so each file is keyed by its ROOT-relative path —
  // otherwise every `SKILL.md` collapses to one map entry and only the
  // last-read (readdir-order-dependent) skill is actually compared.
  const walk = (rootDir: string, dir: string, into: Map<string, string>): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rootDir, p, into);
      else into.set(path.relative(rootDir, p).split(path.sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  walk(a, a, left);
  walk(b, b, right);
  for (const [rel, content] of left) {
    if (!right.has(rel)) diffs.push(`missing in rebuilt: ${rel}`);
    else if (right.get(rel) !== content) diffs.push(`content drift: ${rel}`);
  }
  for (const rel of right.keys()) if (!left.has(rel)) diffs.push(`extra in rebuilt: ${rel}`);
  return diffs;
};

export const validateMarketplace = (rootArg: string): string[] => {
  const errors: string[] = [];

  if (!existsSync(path.join(rootArg, MARKETPLACE_REL))) {
    errors.push(`missing ${MARKETPLACE_REL}`);
    return errors;
  }

  // 1. Official JSON Schema evaluation (AJV + ajv-formats), verbatim snapshots.
  const validate = new Ajv({ strict: true, allErrors: true });
  addFormats(validate);
  const schemaDir = path.join(rootArg, "test/fixtures/cursor-schemas");
  const pluginSchema = JSON.parse(
    readFileSync(path.join(schemaDir, "plugin.schema.json"), "utf8"),
  );
  const marketSchema = JSON.parse(
    readFileSync(path.join(schemaDir, "marketplace.schema.json"), "utf8"),
  );
  const market = JSON.parse(readFileSync(path.join(rootArg, MARKETPLACE_REL), "utf8"));
  if (!validate.validate(marketSchema, market)) {
    errors.push(
      `marketplace.json invalid: ${(validate.errors ?? []).map((e) => e.message).join("; ")}`,
    );
  }

  // 2. Resolve each plugin source relative to the repo root; name must match.
  for (const entry of (market.plugins ?? []) as { name: string; source: string }[]) {
    const pluginDir = path.join(rootArg, entry.source);
    const manifestRel = path.join(entry.source, ".cursor-plugin/plugin.json");
    if (!existsSync(path.join(pluginDir, ".cursor-plugin/plugin.json"))) {
      errors.push(`plugin ${entry.name}: source ${entry.source} has no .cursor-plugin/plugin.json`);
      continue;
    }
    const plugin = JSON.parse(readFileSync(path.join(pluginDir, ".cursor-plugin/plugin.json"), "utf8"));
    if (!validate.validate(pluginSchema, plugin)) {
      errors.push(
        `plugin ${entry.name} plugin.json invalid: ${(validate.errors ?? []).map((e) => e.message).join("; ")}`,
      );
    }
    if (plugin.name !== entry.name) {
      errors.push(`plugin ${entry.name}: plugin.json name ${plugin.name} does not match index`);
    }

    // 3. Component paths resolve inside the plugin root (no `..`, no absolute).
    for (const field of ["skills", "rules", "mcpServers", "hooks"] as const) {
      const value = plugin[field];
      for (const rel of Array.isArray(value) ? (value as string[]) : [value as string]) {
        if (rel.includes("..") || rel.startsWith("/")) {
          errors.push(`plugin ${entry.name}: ${field} path escapes root: ${rel}`);
          continue;
        }
        if (!existsSync(path.join(pluginDir, rel))) {
          errors.push(`plugin ${entry.name}: ${field} path missing: ${rel}`);
        }
      }
    }

    // 4. Logo resolves inside the plugin root and exists.
    const logo = plugin.logo as string | undefined;
    if (logo && (logo.includes("..") || logo.startsWith("/"))) {
      errors.push(`plugin ${entry.name}: logo path escapes root: ${logo}`);
    } else if (logo && !existsSync(path.join(pluginDir, logo))) {
      errors.push(`plugin ${entry.name}: logo missing: ${logo}`);
    }

    // 5. Skills and rules carry valid frontmatter.
    const skillRoots: [string, readonly string[]][] = [
      [path.join(pluginDir, "skills"), CANONICAL_SKILLS.workit],
      [path.join(pluginDir, "vendor/superpowers/skills"), CANONICAL_SKILLS.superpowers],
    ];
    for (const [dir, expected] of skillRoots) {
      const mismatch = validateSkillManifests(dir, expected, "skills");
      if (mismatch) errors.push(`plugin ${entry.name}: ${mismatch}`);
      for (const skill of expected) {
        const keys = frontmatterKeys(path.join(dir, skill, "SKILL.md"));
        if (!keys.has("name")) errors.push(`plugin ${entry.name}: ${skill}/SKILL.md missing frontmatter name`);
        if (!keys.has("description")) errors.push(`plugin ${entry.name}: ${skill}/SKILL.md missing frontmatter description`);
      }
    }
    const rulesDir = path.join(pluginDir, "rules");
    if (existsSync(rulesDir)) {
      for (const rule of readdirSync(rulesDir).filter((f) => f.endsWith(".mdc"))) {
        const keys = frontmatterKeys(path.join(rulesDir, rule));
        if (!keys.has("description")) errors.push(`plugin ${entry.name}: ${rule} missing frontmatter description`);
      }
    }

    // 6. No active runtime path targets an ignored dist file.
    for (const rel of ["mcp.json", "hooks/hooks-cursor.json"]) {
      const p = path.join(pluginDir, rel);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      if (raw.includes("dist/") || raw.includes("run-server") || raw.includes("session-start.js")) {
        errors.push(`plugin ${entry.name}: ${rel} references ignored runtime output`);
      }
    }

    // 7. Rebuilding the sanitized vendor tree yields no diff.
    const sourceVendor = path.join(rootArg, "packages/workit-core/vendor/superpowers/skills");
    const trackedVendor = path.join(pluginDir, "vendor/superpowers/skills");
    if (existsSync(sourceVendor) && existsSync(trackedVendor)) {
      const rebuilt = mkdtempSync(path.join(os.tmpdir(), "wk-vendor-rebuild-"));
      try {
        copySanitizedVendor(sourceVendor, rebuilt);
        for (const diff of treesEqual(rebuilt, trackedVendor)) {
          errors.push(`plugin ${entry.name}: vendor drift: ${diff}`);
        }
      } finally {
        rmSync(rebuilt, { recursive: true, force: true });
      }
    } else {
      errors.push(`plugin ${entry.name}: missing vendor source or tracked tree`);
    }
  }

  return errors;
};

if (import.meta.main) {
  const errors = validateMarketplace(root);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${e}\n`);
    process.stderr.write(`marketplace validation FAILED (${errors.length} error${errors.length === 1 ? "" : "s"})\n`);
    process.exit(1);
  }
  console.log(`marketplace validation passed (root: ${root})`);
}
