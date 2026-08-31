# Toolkit Config Phase 2 — Editable templates + canonical rules compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/toolkit-config/spec.md`
**Branch:** `feature/toolkit-config-phase2`

**Goal:** Make issue templates (issue-update/greeting/headers) editable from `~/.config/workflow-toolkit/templates/` via an assisted tool, and add canonical multi-platform rules (compiled to Cursor `.mdc` and OpenCode contract sections) with assisted editing.

**Architecture:** `src/core/templates.ts` reads templates from the config dir with repo fallback and powers `workit_template_edit` / `workit_template_list`; `buildDraft` and greeting read the config templates. `src/core/rules.ts` holds the canonical rule model + compiler (`compileRuleCursor` → `.mdc`, `compileRuleOpenCode` → contract section) and powers `workit_rule_list` / `workit_rule_edit`; sync-runtime emits `.mdc` files; the bootstrap appends compiled OpenCode sections.

**Tech Stack:** TypeScript + zod (existing), `bun test`, node:fs (existing patterns). No new dependencies.

## Global Constraints

- Templates live in `~/.config/workflow-toolkit/templates/{issue-update.md,greeting.md,headers.md}`; read with fallback to repo templates (`templates/` in the toolkit).
- Canonical rules live in `~/.config/workflow-toolkit/rules/<name>/rule.md` with frontmatter `name`, `description`, `platforms` (`[cursor, opencode]`), markdown body.
- Compiler: Cursor output = `.mdc` (frontmatter `description` + `alwaysApply: true` + body); OpenCode output = contract section (`## <name>` heading + body).
- User rules override repo defaults by name (repo defaults in `rules/` of the toolkit, if any).
- `workit_template_edit` / `workit_rule_edit` require `confirmed: true` and write only to the config dir.
- Missing template/rule file → repo fallback; never hard-fail.
- `bun run check` green after each task. Version stays `0.4.0`.

---

### Task 1: Editable templates

**Files:**
- Create: `src/core/templates.ts`
- Modify: `src/core/youtrack.ts` (`buildDraft` reads the issue-update template from config with fallback)
- Modify: `src/tools/docs-repo.ts` or new `src/tools/templates.ts` (register `workit_template_list`, `workit_template_edit`)
- Modify: `cursor/mcp/server.ts` (same two tools)
- Modify: `src/tools/index.ts` (register the new tool group)
- Test: `test/templates.test.ts` + `test/template-tools.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/core/config.ts`
- Produces:
  - `readTemplate(name: "issue-update" | "greeting" | "headers"): { source: "config" | "repo"; content: string }` — config path first, repo fallback
  - `writeTemplate(name, content, confirmed): { ok: true; path } | { ok: false; error }`
  - `listTemplates(): { name: string; source: "config" | "repo" | "missing"; path: string }[]`
  - Tools `workit_template_list`, `workit_template_edit { name, confirmed }` (agent-assisted: skill reads current, applies edits, writes back)

- [ ] **Step 1: Write the failing test**

Create `test/templates.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTemplate, writeTemplate, listTemplates } from "../src/core/templates";

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-templates-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  return dir;
};

test("readTemplate falls back to repo when config template missing", () => {
  const dir = cfgDir();
  try {
    const tpl = readTemplate("issue-update");
    expect(tpl.source).toBe("repo");
    expect(tpl.content.length).toBeGreaterThan(0);
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test("writeTemplate then readTemplate returns config source", () => {
  const dir = cfgDir();
  try {
    const written = writeTemplate("issue-update", "# Mi template\n\n{{userNotes}}\n", true);
    expect(written.ok).toBe(true);
    const tpl = readTemplate("issue-update");
    expect(tpl.source).toBe("config");
    expect(tpl.content).toContain("Mi template");
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test("writeTemplate requires confirmed", () => {
  const dir = cfgDir();
  try {
    const no = writeTemplate("issue-update", "x", false);
    expect(no.ok).toBe(false);
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test("listTemplates reports sources", () => {
  const dir = cfgDir();
  try {
    writeTemplate("greeting", "hola", true);
    const list = listTemplates();
    const issue = list.find((t) => t.name === "issue-update");
    const greeting = list.find((t) => t.name === "greeting");
    expect(issue?.source).toBe("repo");
    expect(greeting?.source).toBe("config");
  } finally { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/templates.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config";

export type TemplateName = "issue-update" | "greeting" | "headers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const templatePath = (name: TemplateName): string => path.join(configDir(), "templates", `${name}.md`);

export const readTemplate = (name: TemplateName): { source: "config" | "repo"; content: string } => {
  const cfg = templatePath(name);
  if (existsSync(cfg)) return { source: "config", content: readFileSync(cfg, "utf8") };
  return { source: "repo", content: readFileSync(path.join(repoRoot, "templates", `${name}.md`), "utf8") };
};

export const writeTemplate = (
  name: TemplateName,
  content: string,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const file = templatePath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { ok: true, path: file };
};

export const listTemplates = (): { name: TemplateName; source: "config" | "repo" | "missing"; path: string }[] =>
  (["issue-update", "greeting", "headers"] as TemplateName[]).map((name) => {
    const cfg = templatePath(name);
    const repoFile = path.join(repoRoot, "templates", `${name}.md`);
    if (existsSync(cfg)) return { name, source: "config", path: cfg };
    if (existsSync(repoFile)) return { name, source: "repo", path: repoFile };
    return { name, source: "missing", path: cfg };
  });
```

- [ ] **Step 4: Create repo default templates**

Create `templates/issue-update.md` (the current hardcoded structure):

```markdown
# Actualización

{{greeting}}

{{projectOpener}}

{{userNotes}}

{{progressExcerpt}}

{{gitCommits}}

{{attachments}}
```

Create `templates/greeting.md`:

```markdown
{{greetingText}}
```

Create `templates/headers.md`:

```markdown
## Adjunto capturas

## Archivos adjuntos
```

- [ ] **Step 5: Wire `buildDraft` in `src/core/youtrack.ts` to the template**

Modify `buildDraft` to read `issue-update` template and replace placeholders:

```typescript
import { readTemplate } from "./templates";

export function buildDraft({ issueId, projectName, userNotes, greeting, facts, includeProjectOpener, includeFacts }: {...}): Record<string, any> {
  const tpl = readTemplate("issue-update").content;
  const filled = tpl
    .replaceAll("{{greeting}}", greeting ? `${greeting}` : "")
    .replaceAll("{{projectOpener}}", includeProjectOpener && projectName ? `Hoy estuve full con ${projectName}.` : "")
    .replaceAll("{{userNotes}}", (userNotes ?? "").trim())
    .replaceAll("{{progressExcerpt}}", includeFacts && facts?.progress_excerpt?.length
      ? facts.progress_excerpt.map((l: string) => `- ${l}`).join("\n") : "")
    .replaceAll("{{gitCommits}}", includeFacts && facts?.git_commits?.length
      ? facts.git_commits.map((c: string) => `- ${c}`).join("\n") : "")
    .replaceAll("{{attachments}}", "");
  return { issueId, markdown: filled };
}
```

Note: the repo default template reproduces the exact current output (header `# Actualización` + blank line + parts), so existing tests keep passing.

- [ ] **Step 6: Register `workit_template_list` and `workit_template_edit`**

Create `src/tools/templates.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { listTemplates, readTemplate, writeTemplate, type TemplateName } from "../core/templates";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createTemplateTools() {
  return {
    workit_template_list: tool({
      description: "List editable templates (issue-update, greeting, headers) with their source",
      args: {},
      execute: async () => output(ok({ templates: listTemplates() })),
    }),
    workit_template_edit: tool({
      description: "Write an edited template to the toolkit config dir (agent-assisted)",
      args: {
        name: tool.schema.enum(["issue-update", "greeting", "headers"]),
        content: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ name, content, confirmed }) => {
        const result = writeTemplate(name as TemplateName, content, confirmed);
        return output(result.ok ? ok(result) : fail(result.error));
      },
    }),
  };
}
```

Register in `src/tools/index.ts` (add `...createTemplateTools()`).

Mirror both tools in `cursor/mcp/server.ts` with zod schemas.

- [ ] **Step 7: Run tests**

Run: `bun test test/templates.test.ts && bun run check`
Expected: PASS (existing `buildDraft` tests keep passing since the repo default template reproduces the current output).

- [ ] **Step 8: Commit**

```bash
git add src/core/templates.ts src/core/youtrack.ts src/tools/templates.ts src/tools/index.ts cursor/mcp/server.ts templates/issue-update.md templates/greeting.md templates/headers.md test/templates.test.ts
git commit -m "feat(templates): editable issue/greeting/headers templates with assisted edit tools"
```

---

### Task 2: Canonical rules + compiler

**Files:**
- Create: `src/core/rules.ts`
- Create: `src/tools/rules.ts` (`workit_rule_list`, `workit_rule_edit`)
- Modify: `src/tools/index.ts`
- Modify: `cursor/mcp/server.ts`
- Modify: `src/bootstrap.ts` (append compiled OpenCode rule sections)
- Modify: `scripts/sync-runtime.sh` (emit `.mdc` from compiled Cursor rules)
- Test: `test/rules.test.ts` + `test/rules-tools.test.ts`

**Interfaces:**
- Consumes: `configDir()` from `src/core/config.ts`
- Produces:
  - `type CanonicalRule = { name: string; description: string; platforms: ("cursor" | "opencode")[]; body: string }`
  - `parseRule(markdown: string): CanonicalRule | { error: string }` — frontmatter + body
  - `listRules(): { name: string; platforms: string[]; source: "config" | "repo" }[]` — merges repo defaults + user rules (user wins by name)
  - `readRule(name: string): { source: "config" | "repo" | "missing"; rule: CanonicalRule }`
  - `writeRule(rule: CanonicalRule, confirmed): { ok: true; path } | { ok: false; error }`
  - `compileRuleCursor(rule): string` — `.mdc` content (frontmatter description + alwaysApply + body)
  - `compileRuleOpenCode(rule): string` — `## <name>` section
  - `compiledOpenCodeSections(): string` — all user rules for opencode (for bootstrap)
  - `writeCompiledCursorRules(targetDir: string): string[]` — writes `.mdc` files (for sync-runtime)

- [ ] **Step 1: Write the failing test**

Create `test/rules.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/rules.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config";

export type RulePlatform = "cursor" | "opencode";
export type CanonicalRule = {
  name: string;
  description: string;
  platforms: RulePlatform[];
  body: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const rulesDir = () => path.join(configDir(), "rules");

export const parseRule = (markdown: string): CanonicalRule | { error: string } => {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return { error: "rule must start with frontmatter (--- name/description/platforms ---)" };
  const meta: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const name = meta.name ?? "";
  const description = meta.description ?? "";
  const platforms = (meta.platforms ?? "")
    .replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().replace(/['"]/g, ""))
    .filter(Boolean) as RulePlatform[];
  if (!name || !description || platforms.length === 0) {
    return { error: "rule frontmatter requires name, description, and platforms" };
  }
  return { name, description, platforms, body: fm[2].trim() + "\n" };
};

export const listRules = (): { name: string; platforms: string[]; source: "config" | "repo" }[] => {
  const result: { name: string; platforms: string[]; source: "config" | "repo" }[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed) continue;
      result.push({ name: parsed.name, platforms: parsed.platforms, source: "config" });
    }
  }
  return result;
};

export const readRule = (name: string): { source: "config" | "repo" | "missing"; rule: CanonicalRule } => {
  const file = path.join(rulesDir(), name, "rule.md");
  if (existsSync(file)) {
    return { source: "config", rule: parseRule(readFileSync(file, "utf8")) as CanonicalRule };
  }
  return { source: "missing", rule: { name, description: "", platforms: [], body: "" } };
};

export const writeRule = (
  rule: CanonicalRule,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const dir = path.join(rulesDir(), rule.name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rule.md");
  const md = `---\nname: ${rule.name}\ndescription: ${rule.description}\nplatforms: [${rule.platforms.join(", ")}]\n---\n${rule.body}`;
  writeFileSync(file, md, "utf8");
  return { ok: true, path: file };
};

export const compileRuleCursor = (rule: CanonicalRule): string =>
  `---\ndescription: ${rule.description}\nalwaysApply: true\n---\n\n${rule.body}`;

export const compileRuleOpenCode = (rule: CanonicalRule): string =>
  `## ${rule.name}\n\n${rule.body}`;

export const compiledOpenCodeSections = (): string => {
  const sections: string[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed || !parsed.platforms.includes("opencode")) continue;
      sections.push(compileRuleOpenCode(parsed));
    }
  }
  return sections.join("\n\n");
};

export const writeCompiledCursorRules = (targetDir: string): string[] => {
  const written: string[] = [];
  const dir = rulesDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry, "rule.md");
      if (!existsSync(file)) continue;
      const parsed = parseRule(readFileSync(file, "utf8"));
      if ("error" in parsed || !parsed.platforms.includes("cursor")) continue;
      const out = path.join(targetDir, `${parsed.name}.mdc`);
      writeFileSync(out, compileRuleCursor(parsed), "utf8");
      written.push(out);
    }
  }
  return written;
};
```

- [ ] **Step 4: Wire compiled sections into `src/bootstrap.ts`**

After the locale section, append user rule sections:

```typescript
import { compiledOpenCodeSections } from "./core/rules";
// ...
const userSections = compiledOpenCodeSections();
cached = `${marker}
... existing contract ...

## Locale

Answer the user in \`${config.locale}\` unless a specific template declares otherwise.

${contract}

${userSections}
</workflow-toolkit-contract>`;
```

- [ ] **Step 5: Wire compiled `.mdc` into `scripts/sync-runtime.sh`**

After the vendored skills rsync, emit cursor rules:

```bash
# Canonical user rules -> Cursor .mdc
RULES_DIR="${SHARE}/rules"          # repo defaults (if any)
CONFIG_RULES_DIR="${HOME}/.config/workflow-toolkit/rules"
# The MCP server compiles config rules; sync emits from config dir via a small bun call
if [ -d "$CONFIG_RULES_DIR" ]; then
  "$HOME/.bun/bin/bun" -e "
    import('${SHARE}/src/core/rules.ts').then(async ({ writeCompiledCursorRules }) => {
      const out = writeCompiledCursorRules('${PLUGIN_DIR}/rules');
      console.log('compiled cursor rules:', out.length);
    });
  " >/dev/null 2>&1 || true
fi
```

(Alternatively, emit via the MCP server at startup; the sync approach keeps it deterministic and testable.)

- [ ] **Step 6: Register `workit_rule_list` and `workit_rule_edit`**

Create `src/tools/rules.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { listRules, readRule, writeRule, type CanonicalRule } from "../core/rules";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createRuleTools() {
  return {
    workit_rule_list: tool({
      description: "List canonical rules (config + repo) with platforms and source",
      args: {},
      execute: async () => output(ok({ rules: listRules() })),
    }),
    workit_rule_edit: tool({
      description: "Write a canonical rule to the toolkit config dir (agent-assisted)",
      args: {
        name: tool.schema.string(),
        description: tool.schema.string(),
        platforms: tool.schema.array(tool.schema.enum(["cursor", "opencode"])),
        body: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ name, description, platforms, body, confirmed }) => {
        const rule: CanonicalRule = { name, description, platforms, body };
        const result = writeRule(rule, confirmed);
        return output(result.ok ? ok(result) : fail(result.error));
      },
    }),
  };
}
```

Register in `src/tools/index.ts`; mirror both in `cursor/mcp/server.ts`.

- [ ] **Step 7: Run tests**

Run: `bun test test/rules.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/rules.ts src/tools/rules.ts src/tools/index.ts cursor/mcp/server.ts src/bootstrap.ts scripts/sync-runtime.sh test/rules.test.ts
git commit -m "feat(rules): canonical multi-platform rules with compiler, edit/list tools, bootstrap + sync wiring"
```

---

## Post-plan checklist (Phase 2)

- [ ] `bun run check` green after each task.
- [ ] `src/core/templates.ts` exports `readTemplate`, `writeTemplate`, `listTemplates`; repo fallback works.
- [ ] `buildDraft` reads the issue-update template (config first, repo fallback); existing tests unchanged.
- [ ] `workit_template_list` / `workit_template_edit` on both platforms.
- [ ] `src/core/rules.ts` exports parse/list/read/write + compilers; `compiledOpenCodeSections` and `writeCompiledCursorRules` work.
- [ ] Bootstrap appends user rule sections; sync-runtime emits `.mdc` files.
- [ ] `workit_rule_list` / `workit_rule_edit` on both platforms.
- [ ] Missing config dir never hard-fails any tool.
