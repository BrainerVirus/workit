import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { changelogApply } from "../../packages/workit-core/src/core/changelog";
import { postUpdate } from "../../packages/workit-core/src/core/youtrack";
import { buildHandoffPrompt } from "../../packages/workit-core/src/tools/handoff";
import { docsValidate } from "../../packages/workit-core/src/core/docs-validate";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CURSOR_ROOT = path.join(REPO_ROOT, "packages", "workit-cursor");

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-"));
}

function filesUnder(target: string): string[] {
  const readFileSafe = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  if (!path.extname(target) && !readFileSafe(target)) {
    return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(target, entry.name);
      return entry.isDirectory() ? filesUnder(child) : [child];
    });
  }
  return [target];
}

const readFileSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

test("changelog rejects missing entries without throwing", () => {
  expect(changelogApply({ workspace_root: os.tmpdir() })).toEqual({
    error: "entries required unless normalize_only",
  });
});

test("changelog rejects a path outside workspace_root", () => {
  const root = temporaryDirectory();
  try {
    const result = changelogApply({
      entries: { Fixed: ["outside"] },
      path: "../outside.md",
      workspace_root: root,
    });
    expect(result.error).toMatch(/inside workspace_root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changelog preserves rich Markdown while consolidating categories", () => {
  const root = temporaryDirectory();
  try {
    const changelog = path.join(root, "CHANGELOG.md");
    writeFileSync(
      changelog,
      `# Changelog

## [Unreleased]

<!-- keep this comment -->

### Added

- Existing feature
  - nested detail
  continuation text

### Notes

Keep this custom section.

### Added

- Existing feature
- Second feature
  with continuation

## [1.0.0] - 2026-01-01

### Added

- Historical feature
`,
    );

    const result = changelogApply({
      entries: { Added: ["New feature", "Existing feature"] },
      workspace_root: root,
    });
    expect(result.error).toBeUndefined();
    const output = readFileSync(changelog, "utf8");
    const unreleased = output.split("## [1.0.0]")[0];
    expect((unreleased.match(/^### Added$/gm) ?? []).length).toBe(1);
    expect(unreleased).toMatch(/### Added\n\n- New feature/);
    expect((unreleased.match(/^- Existing feature$/gm) ?? []).length).toBe(1);
    expect((unreleased.match(/^- New feature$/gm) ?? []).length).toBe(1);
    for (const preserved of [
      "<!-- keep this comment -->",
      "  - nested detail",
      "  continuation text",
      "### Notes",
      "Keep this custom section.",
      "  with continuation",
      "## [1.0.0] - 2026-01-01",
      "- Historical feature",
    ]) {
      expect(output).toContain(preserved);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff includes every parsed task row", () => {
  const root = temporaryDirectory();
  try {
    mkdirSync(path.join(root, "docs", "repair"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "repair", "spec.md"),
      "# Repair\n\n**Branch:** `bugfix/handoff-test`\n",
    );
    writeFileSync(
      path.join(root, "docs", "repair", "plan.md"),
      `# Repair plan

**Spec:** \`docs/repair/spec.md\`
**Branch:** \`bugfix/handoff-test\`

### Task 1: First repair

- [ ] **Step 1:** Work

### Task 2: Second repair

- [ ] **Step 1:** Work
`,
    );
    spawnSync("git", ["init", "-q"], { cwd: root });

    const result = buildHandoffPrompt(root, "docs/repair/plan.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.prompt).toContain("- Task 1: First repair");
      expect(result.prompt).toContain("- Task 2: Second repair");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs validate rejects task number gaps", () => {
  const root = temporaryDirectory();
  try {
    mkdirSync(path.join(root, "docs", "gap"), { recursive: true });
    const spec = "docs/gap/spec.md";
    const plan = "docs/gap/plan.md";
    writeFileSync(path.join(root, spec), "# Gap\n\n**Branch:** `feature/gap`\n");
    writeFileSync(
      path.join(root, plan),
      `# Gap\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gap\`\n\n### Task 1: One\n\n- [ ] **Step 1:** x**\n\n### Task 3: Skip\n\n- [ ] **Step 1:** x**\n`,
    );

    const result = docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/task/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question choices use Cursor AskQuestion without an MCP adapter", () => {
  const targets = [
    path.join(CURSOR_ROOT, "mcp"),
    path.join(CURSOR_ROOT, "skills"),
    path.join(CURSOR_ROOT, "rules"),
    path.join(REPO_ROOT, "packages", "workit-core", "templates"),
    path.join(CURSOR_ROOT, "hooks"),
    path.join(REPO_ROOT, "packages", "workit-core", "scripts"),
    path.join(CURSOR_ROOT, "README.md"),
  ].flatMap((target) => filesUnder(target));
  const offenders = targets
    .filter((file) => !file.includes(`${path.sep}mcp${path.sep}test${path.sep}`))
    .filter((file) => {
      const source = readFileSafe(file);
      return (
        source?.includes("workflow_prepare_question") || source?.includes("prepare-question.sh")
      );
    })
    .map((file) => path.relative(REPO_ROOT, file));

  expect(offenders).toEqual([]);
  const pr = readFileSync(path.join(CURSOR_ROOT, "skills/wk-pr/SKILL.md"), "utf8");
  const issue = readFileSync(path.join(CURSOR_ROOT, "skills/wk-issue-update/SKILL.md"), "utf8");
  expect(pr).toMatch(/AskQuestion/);
  expect(pr).toMatch(/MR\/PR/);
  expect(issue).toMatch(/AskQuestion/);
  expect(issue).toMatch(/YouTrack/);
});

test("YouTrack post orchestration accepts injected operations", () => {
  expect(postUpdate.length).toBe(2);
});

test("YouTrack partial time failure never hides a posted comment", () => {
  let comments = 0;
  let timeLogs = 0;
  const result = postUpdate(
    {
      confirmed: true,
      issueId: "NSR-40",
      markdown: "Reviewed update",
      minutes: 30,
    },
    {
      postComment() {
        comments += 1;
        return { data: { ok: true } };
      },
      logTime() {
        timeLogs += 1;
        return { error: "time failed" };
      },
    },
  );

  expect(comments).toBe(1);
  expect(timeLogs).toBe(1);
  expect(result).toEqual({
    ok: false,
    partial: true,
    issueId: "NSR-40",
    postedComment: true,
    loggedMinutes: 0,
    error: "time failed",
    retry: "workflow_youtrack_log_time",
  });
});

test("release notes require and expose an explicit range", () => {
  const root = temporaryDirectory();
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(path.join(root, "file.txt"), "release\n");
    spawnSync("git", ["add", "file.txt"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "release fixture"], { cwd: root });
    const script = path.join(REPO_ROOT, "packages/workit-core/scripts/release-notes-context.sh");

    const missing = spawnSync("bash", [script], { cwd: root, encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/release tag or range required/);

    const explicit = spawnSync("bash", [script, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toMatch(/^requested: HEAD$/m);
    expect(explicit.stdout).toMatch(/^range: .+$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin and MCP versions are synchronized", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(CURSOR_ROOT, ".cursor-plugin/plugin.json"), "utf8"),
  );
  const opencode = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  expect(manifest.version).toBe(opencode.version);
});

test("cursor MCP manifests stay package-relative (mcp.json, marketplace.json, hooks-cursor.json)", () => {
  const mcpJson = JSON.parse(readFileSync(path.join(CURSOR_ROOT, "mcp.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(path.join(CURSOR_ROOT, "marketplace.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(path.join(CURSOR_ROOT, "hooks/hooks-cursor.json"), "utf8"));
  const launcher = readFileSync(path.join(CURSOR_ROOT, "mcp/run-server.sh"), "utf8");

  const server = mcpJson.mcpServers.workit;
  const joined = [server.command, ...(server.args ?? [])]
    .join(" ")
    .replace("${workspaceFolder}", "");
  expect(joined).not.toMatch(/\$HOME/);
  expect(joined).not.toContain(".local/share");
  expect(joined).not.toContain("Documents/projects");
  expect(joined).toMatch(/run-server\.sh/);

  expect(marketplace.homepage).toBe("https://github.com/BrainerVirus/workit");
  expect(marketplace.repository).toBe("https://github.com/BrainerVirus/workit.git");
  expect(hooks.hooks.sessionStart).toEqual([{ command: "./hooks/session-start" }]);
  expect(launcher).not.toMatch(/Documents\/projects/);
  expect(launcher).not.toMatch(/\$HOME\/\.local\/share\/workflow-toolkit/);
});

test("root tsconfig includes Cursor MCP source in strict typechecking", () => {
  const tsconfig = JSON.parse(readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8"));
  expect(tsconfig.include).toContain("packages/workit-cursor/mcp/**/*.ts");
  expect(tsconfig.compilerOptions.strict).toBe(true);
});

test("cursor MCP server registers the full required tool surface", () => {
  const server = readFileSync(path.join(CURSOR_ROOT, "mcp/server.ts"), "utf8");
  const required = [
    "workflow_toolkit_init_status",
    "workflow_toolkit_status",
    "workflow_toolkit_init_apply",
    "workflow_docs_validate",
    "workflow_flow_status",
    "workflow_spec_approve",
    "workflow_plan_approve",
    "workflow_plan_menu",
    "workflow_handoff_prompt",
    "workflow_youtrack_verify_token",
    "workflow_youtrack_parse_issue",
    "workflow_youtrack_context",
    "workflow_youtrack_parse_duration",
    "workflow_youtrack_log_time",
    "workflow_youtrack_draft",
    "workflow_youtrack_post",
    "workflow_present_ascii",
    "workflow_present_flow",
  ];
  const registered = (server.match(/registerTool\(\s*\n?\s*"([a-z_]+)"/g) ?? []).join("\n");
  for (const name of required) {
    expect(registered).toContain(`"${name}"`);
  }
});

test("docs validate accepts the new docs/<slug> layout", () => {
  const root = temporaryDirectory();
  try {
    mkdirSync(path.join(root, "docs", "mirror"), { recursive: true });
    const spec = "docs/mirror/spec.md";
    const plan = "docs/mirror/plan.md";
    writeFileSync(path.join(root, spec), "# Mirror\n\n**Branch:** `feature/mirror`\n");
    writeFileSync(
      path.join(root, plan),
      `# Mirror\n\n**Spec:** \`docs/mirror/spec.md\`\n**Branch:** \`feature/mirror\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`,
    );
    const result = docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root });
    expect(result.ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { changelogUnreleasedStats } from "../../packages/workit-core/src/core/changelog";

test("changelog accepts array entries with type/text", () => {
  const root = temporaryDirectory();
  try {
    writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Old\n",
    );
    const result = changelogApply({
      entries: [
        { type: "fixed", text: "Array fix" },
        { category: "added", entry: "Array add" },
      ],
      workspace_root: root,
    });
    expect(result.error).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changelog rejects entries missing category or text", () => {
  expect(
    changelogApply({ entries: [{ category: "Fixed" }], workspace_root: os.tmpdir() }).error,
  ).toMatch(/category \+ text/);
  expect(changelogApply({ entries: [{ text: "x" }], workspace_root: os.tmpdir() }).error).toMatch(
    /category \+ text/,
  );
});

test("changelog rejects invalid categories", () => {
  expect(
    changelogApply({ entries: [{ category: "Nope", text: "x" }], workspace_root: os.tmpdir() })
      .error,
  ).toMatch(/invalid category/);
  expect(changelogApply({ entries: { Nope: ["x"] }, workspace_root: os.tmpdir() }).error).toMatch(
    /invalid category/,
  );
});

test("changelog rejects non-object non-array entries", () => {
  expect(changelogApply({ entries: "nonsense", workspace_root: os.tmpdir() }).error).toMatch(
    /object or array/,
  );
});

test("changelog stats: missing file, no unreleased, and duplicate headings", () => {
  const root = temporaryDirectory();
  try {
    expect(changelogUnreleasedStats(root)).toEqual({ exists: false });
    writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- x\n",
    );
    expect(changelogUnreleasedStats(root)).toEqual({ exists: true, has_unreleased: false });
    writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n- a\n\n### Added\n- b\n",
    );
    const stats = changelogUnreleasedStats(root);
    expect(stats.exists).toBe(true);
    expect(stats.has_unreleased).toBe(true);
    expect(stats.category_headings).toEqual(["Added", "Added"]);
    expect(stats.duplicate_category_headings).toEqual(["Added"]);
    expect(stats.needs_normalize).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { asciiWireframe, flowDiagram } from "../../packages/workit-core/src/core/present";

test("present renders ascii and mermaid via real scripts", () => {
  const ascii = asciiWireframe({ title: "T", rows: [{ type: "header", label: "Title" }] });
  expect(ascii.error).toBeUndefined();
  expect(ascii.data.format).toBe("ascii-wireframe");
  const flow = flowDiagram({ nodes: [{ id: "a", label: "Start" }], edges: [] });
  expect(flow.error).toBeUndefined();
  expect(flow.data.format).toBe("mermaid");
});

test("present surfaces script failures", () => {
  const broken = asciiWireframe("not-json{");
  expect(broken.error).toBeDefined();
});

test("no docs/superpowers paths remain in sources", () => {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const root = path.resolve(import.meta.dir, "..", "..");
  const skipDirs = new Set(["node_modules", ".git", ".cache", "docs", "vendor"]);
  const selfFile = path.basename(import.meta.file ?? "");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|sh|md|json)$/.test(entry)) continue;
      if (entry === selfFile) continue;
      if (
        full
          .split(path.sep)
          .join("/")
          .includes("packages/workit-core/scripts/update-superpowers.sh")
      )
        continue; // sed patterns intentionally reference the old layout
      const content = readFileSync(full, "utf8");
      if (content.includes("docs/superpowers")) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});

test("no wf- entry-point references remain in skills, commands, or plugin descriptions", () => {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const coreRoot = path.join(path.resolve(import.meta.dir, "..", ".."), "packages", "workit-core");
  const targets = [
    path.join(coreRoot, "skills"),
    path.join(coreRoot, "commands"),
    path.join(coreRoot, "..", "workit-opencode", "src", "plugin.ts"),
  ];
  const offenders: string[] = [];
  const scanFile = (full: string) => {
    if (!/\.(md|ts)$/.test(path.basename(full))) return;
    const content = readFileSync(full, "utf8");
    if (/(^|[^a-z])wf-/.test(content)) {
      offenders.push(path.relative(coreRoot, full));
    }
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      scanFile(full);
    }
  };
  for (const target of targets) {
    if (statSync(target).isDirectory()) walk(target);
    else scanFile(target);
  }
  expect(offenders).toEqual([]);
});

test("no python3 invocations remain in packages/* (CA-11)", () => {
  const { statSync: stat } = require("node:fs") as typeof import("node:fs");
  const packagesDir = path.join(REPO_ROOT, "packages");
  const offenders: string[] = [];
  const scanFile = (full: string) => {
    if (!/\.(ts|sh|py|js|json)$/.test(path.basename(full))) return;
    const content = readFileSync(full, "utf8");
    if (content.includes("python3")) offenders.push(path.relative(REPO_ROOT, full));
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = path.join(dir, entry);
      if (stat(full).isDirectory()) walk(full);
      else scanFile(full);
    }
  };
  walk(packagesDir);
  expect(offenders).toEqual([]);
});
