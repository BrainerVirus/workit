import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { changelogApply } from "../lib/changelog-apply.js";
import { postUpdate } from "../lib/youtrack.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function temporaryDirectory(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function filesUnder(target) {
  if (!path.extname(target) && !readFileSafe(target)) {
    return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(target, entry.name);
      return entry.isDirectory() ? filesUnder(child) : [child];
    });
  }
  return [target];
}

function readFileSafe(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

test("changelog rejects missing entries without throwing", () => {
  assert.deepEqual(changelogApply({ workspace_root: os.tmpdir() }), {
    error: "entries required unless normalize_only",
  });
});

test("changelog rejects a path outside workspace_root", (t) => {
  const root = temporaryDirectory(t);
  const result = changelogApply({
    entries: { Fixed: ["outside"] },
    path: "../outside.md",
    workspace_root: root,
  });
  assert.match(result.error, /inside workspace_root/);
});

test("changelog preserves rich Markdown while consolidating categories", (t) => {
  const root = temporaryDirectory(t);
  const changelog = path.join(root, "CHANGELOG.md");
  writeFileSync(changelog, `# Changelog

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
`);

  const result = spawnSync(
    "python3",
    [path.join(PLUGIN_ROOT, "scripts/changelog/apply-unreleased.py")],
    {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        entries: { Added: ["New feature", "Existing feature"] },
      }),
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = readFileSync(changelog, "utf8");
  const unreleased = output.split("## [1.0.0]")[0];
  assert.equal((unreleased.match(/^### Added$/gm) ?? []).length, 1);
  assert.match(unreleased, /### Added\n\n- New feature/);
  assert.equal((unreleased.match(/^- Existing feature$/gm) ?? []).length, 1);
  assert.equal((unreleased.match(/^- New feature$/gm) ?? []).length, 1);
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
    assert.match(output, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("handoff includes every parsed task row", (t) => {
  const root = temporaryDirectory(t);
  const specs = path.join(root, "docs/superpowers/specs");
  const plans = path.join(root, "docs/superpowers/plans");
  mkdirSync(specs, { recursive: true });
  mkdirSync(plans, { recursive: true });
  writeFileSync(
    path.join(specs, "repair-design.md"),
    "# Repair\n\n**Branch:** `bugfix/handoff-test`\n",
  );
  writeFileSync(
    path.join(plans, "repair.md"),
    `# Repair plan

**Spec:** \`docs/superpowers/specs/repair-design.md\`
**Branch:** \`bugfix/handoff-test\`

### Task 1: First repair

- [ ] **Step 1:** Work

### Task 2: Second repair

- [ ] **Step 1:** Work
`,
  );
  spawnSync("git", ["init", "-q"], { cwd: root });

  const result = spawnSync(
    "bash",
    [
      path.join(PLUGIN_ROOT, "scripts/collect-handoff-context.sh"),
      "docs/superpowers/specs/repair-design.md docs/superpowers/plans/repair.md",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- Task 1: First repair/);
  assert.match(result.stdout, /- Task 2: Second repair/);
});

test("question choices use Cursor AskQuestion without an MCP adapter", () => {
  const targets = [
    "mcp",
    "skills",
    "rules",
    "templates",
    "hooks",
    "scripts",
    "README.md",
  ].flatMap((target) => filesUnder(path.join(PLUGIN_ROOT, target)));
  const offenders = targets
    .filter((file) => !file.includes(`${path.sep}mcp${path.sep}test${path.sep}`))
    .filter((file) => {
      const source = readFileSafe(file);
      return source?.includes("workflow_prepare_question") || source?.includes("prepare-question.sh");
    })
    .map((file) => path.relative(PLUGIN_ROOT, file));

  assert.deepEqual(offenders, []);
  const pr = readFileSync(path.join(PLUGIN_ROOT, "skills/wf-pr/SKILL.md"), "utf8");
  const issue = readFileSync(
    path.join(PLUGIN_ROOT, "skills/wf-issue-update/SKILL.md"),
    "utf8",
  );
  assert.match(pr, /AskQuestion/);
  assert.match(pr, /MR\/PR/);
  assert.match(issue, /AskQuestion/);
  assert.match(issue, /YouTrack/);
});

test("YouTrack post orchestration accepts injected operations", () => {
  assert.equal(postUpdate.length, 2);
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

  assert.equal(comments, 1);
  assert.equal(timeLogs, 1);
  assert.deepEqual(result, {
    ok: false,
    partial: true,
    issueId: "NSR-40",
    postedComment: true,
    loggedMinutes: 0,
    error: "time failed",
    retry: "workflow_youtrack_log_time",
  });
});

test("release notes require and expose an explicit range", (t) => {
  const root = temporaryDirectory(t);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, "file.txt"), "release\n");
  spawnSync("git", ["add", "file.txt"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "release fixture"], { cwd: root });
  const script = path.join(PLUGIN_ROOT, "scripts/release-notes-context.sh");

  const missing = spawnSync("bash", [script], { cwd: root, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /release tag or range required/);

  const explicit = spawnSync("bash", [script, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /^requested: HEAD$/m);
  assert.match(explicit.stdout, /^range: .+$/m);

  const server = readFileSync(path.join(PLUGIN_ROOT, "mcp/server.js"), "utf8");
  assert.match(server, /range_or_tag:\s*z\.string\(\)\.min\(1\)/);
  assert.match(server, /requested:\s*repo\.requested/);
  assert.match(server, /range:\s*repo\.range/);
});

test("plugin and MCP versions are synchronized at 0.3.13", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PLUGIN_ROOT, ".cursor-plugin/plugin.json"), "utf8"),
  );
  const server = readFileSync(path.join(PLUGIN_ROOT, "mcp/server.js"), "utf8");
  const mcpVersion = server.match(/new McpServer\(\{[\s\S]*?version:\s*"([^"]+)"/)[1];
  assert.equal(manifest.version, "0.3.13");
  assert.equal(mcpVersion, manifest.version);
});
