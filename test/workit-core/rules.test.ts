import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRule,
  compileRuleCursor,
  rulesDir,
  writeCompiledCursorRules,
  type CanonicalRule,
} from "@/packages/workit-core/src/core/rules";

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

/** Seed a canonical user rule the way a user authors it under the config dir. */
const writeRule = (rule: CanonicalRule) => {
  const dir = path.join(rulesDir(), rule.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "rule.md"),
    `---\nname: ${rule.name}\ndescription: ${rule.description}\nplatforms: [${rule.platforms.join(", ")}]\n---\n${rule.body}`,
    "utf8",
  );
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

test("compileRuleCursor emits mdc frontmatter", () => {
  const rule: CanonicalRule = {
    name: "no-worktrees",
    description: "NEVER use worktrees",
    platforms: ["cursor"],
    body: "# No worktrees\n\nNever.\n",
  };
  const mdc = compileRuleCursor(rule);
  expect(mdc).toContain("description: NEVER use worktrees");
  expect(mdc).toContain("alwaysApply: true");
  expect(mdc).toContain("# No worktrees");
});

test("writeCompiledCursorRules writes mdc files", () => {
  const dir = cfgDir();
  try {
    writeRule({ name: "beta", description: "b", platforms: ["cursor"], body: "# Beta\n" });
    const target = mkdtempSync(path.join(os.tmpdir(), "wf-rules-out-"));
    const files = writeCompiledCursorRules(target);
    expect(files).toContain(path.join(target, "beta.mdc"));
    expect(existsSync(path.join(target, "beta.mdc"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap is the static v1 contract without compiled rule sections", async () => {
  const dir = cfgDir();
  try {
    writeRule({
      name: "zeta",
      description: "z",
      platforms: ["opencode"],
      body: "# Zeta\n\nDo zeta.\n",
    });
    const fresh = await import(`../../packages/workit-opencode/src/bootstrap?rules=${Date.now()}`);
    const bootstrap = fresh.getWorkitBootstrap();
    expect(bootstrap).toContain("<workit-contract>");
    expect(bootstrap).not.toContain("## zeta");
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
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
