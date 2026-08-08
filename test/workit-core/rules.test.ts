import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRule, listRules, readRule, writeRule,
  compileRuleCursor, compileRuleOpenCode, compiledOpenCodeSections, writeCompiledCursorRules,
  type CanonicalRule,
} from "../../packages/workit-core/src/core/rules";

const savedEnv = new Map<string, string | undefined>();

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-rules-"));
  savedEnv.set("WORKFLOW_TOOLKIT_CONFIG", process.env.WORKFLOW_TOOLKIT_CONFIG);
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  return dir;
};

const cleanupEnv = () => {
  const value = savedEnv.get("WORKFLOW_TOOLKIT_CONFIG");
  if (value === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = value;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  savedEnv.clear();
};

const RULE_MD = `---
name: my-rule
description: My custom rule
platforms: [cursor, opencode]
---
# My rule

Do the thing.
`;

test("parseRule extracts frontmatter and body", () => {
  const rule = parseRule(RULE_MD);
  expect("error" in rule).toBe(false);
  if (!("error" in rule)) {
    expect(rule.name).toBe("my-rule");
    expect(rule.platforms).toEqual(["cursor", "opencode"]);
    expect(rule.body).toContain("Do the thing.");
  }
});

test("parseRule rejects bad frontmatter", () => {
  const bad = parseRule("no frontmatter here");
  expect("error" in bad).toBe(true);
});

test("writeRule + readRule round trip", () => {
  const dir = cfgDir();
  try {
    const rule: CanonicalRule = {
      name: "my-rule", description: "My custom rule",
      platforms: ["cursor", "opencode"], body: "# My rule\n\nDo the thing.\n",
    };
    const written = writeRule(rule, true);
    expect(written.ok).toBe(true);
    const read = readRule("my-rule");
    if ("error" in read) throw new Error(read.error);
    expect(read.source).toBe("config");
    expect(read.rule.name).toBe("my-rule");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("compileRuleCursor emits mdc frontmatter", () => {
  const rule: CanonicalRule = {
    name: "no-worktrees", description: "NEVER use worktrees",
    platforms: ["cursor"], body: "# No worktrees\n\nNever.\n",
  };
  const mdc = compileRuleCursor(rule);
  expect(mdc).toContain("description: NEVER use worktrees");
  expect(mdc).toContain("alwaysApply: true");
  expect(mdc).toContain("# No worktrees");
});

test("compileRuleOpenCode emits a contract section", () => {
  const rule: CanonicalRule = {
    name: "my-rule", description: "d", platforms: ["opencode"], body: "# My rule\n\nDo it.\n",
  };
  const section = compileRuleOpenCode(rule);
  expect(section).toContain("## my-rule");
  expect(section).toContain("Do it.");
});

test("compiledOpenCodeSections includes user rules", () => {
  const dir = cfgDir();
  try {
    writeRule({ name: "alpha", description: "a", platforms: ["opencode"], body: "# Alpha\n\nDo alpha.\n" }, true);
    writeRule({ name: "cursor-only", description: "c", platforms: ["cursor"], body: "# C\n" }, true);
    const sections = compiledOpenCodeSections();
    expect(sections).toContain("## alpha");
    expect(sections).not.toContain("## cursor-only");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("writeCompiledCursorRules writes mdc files", () => {
  const dir = cfgDir();
  try {
    writeRule({ name: "beta", description: "b", platforms: ["cursor"], body: "# Beta\n" }, true);
    const target = mkdtempSync(path.join(os.tmpdir(), "wf-rules-out-"));
    const files = writeCompiledCursorRules(target);
    expect(files).toContain(path.join(target, "beta.mdc"));
    expect(existsSync(path.join(target, "beta.mdc"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("bootstrap appends compiled opencode rule sections", async () => {
  const dir = cfgDir();
  try {
    writeRule({ name: "zeta", description: "z", platforms: ["opencode"], body: "# Zeta\n\nDo zeta.\n" }, true);
    const fresh = await import(`../../packages/workit-opencode/src/bootstrap?rules=${Date.now()}`);
    const bootstrap = fresh.getWorkflowBootstrap();
    expect(bootstrap).toContain("## zeta");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("writeRule rejects traversal rule names", () => {
  const dir = cfgDir();
  try {
    const bad = writeRule({ name: "../evil", description: "x", platforms: ["cursor"], body: "# X\n" }, true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("invalid rule name");
    const ok = writeRule({ name: "good-rule", description: "x", platforms: ["cursor"], body: "# X\n" }, true);
    expect(ok.ok).toBe(true);
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("parseRule strips quotes and rejects unknown platforms", () => {
  const quoted = parseRule(`---
name: "my rule"
description: 'desc here'
platforms: [cursor, bogus]
---
Body
`);
  expect("error" in quoted).toBe(true);
  const good = parseRule(`---
name: "my-rule"
description: "desc"
platforms: [cursor]
---
Body
`);
  expect("error" in good).toBe(false);
  if (!("error" in good)) expect(good.name).toBe("my-rule");
});
