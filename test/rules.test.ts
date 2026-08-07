import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRule, listRules, readRule, writeRule,
  compileRuleCursor, compileRuleOpenCode, compiledOpenCodeSections, writeCompiledCursorRules,
  type CanonicalRule,
} from "../src/core/rules";

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-rules-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  return dir;
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
    expect(read.source).toBe("config");
    expect(read.rule.name).toBe("my-rule");
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
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
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
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
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});
