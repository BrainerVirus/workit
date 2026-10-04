// S14 plugin shape: manifest, marketplace entry, hooks registration, agents,
// generated skills, and the source/dist resolution of the local pin.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WORKIT_METHOD_SKILLS } from "@/packages/workit-core/src/core/skill-manifests";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import {
  SYNC_MANIFEST_PATHS,
  syncManifests,
} from "@/packages/workit-core/scripts/sync-release-manifests";
import { installedPlugin, PLUGIN_DIR } from "./plugin-helpers";

const REPO = path.resolve(PLUGIN_DIR, "..", "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const CLI_VERSION = json(path.join(REPO, "packages", "workit-cli", "package.json")).version;

const frontmatter = (file: string): Record<string, string> => {
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter`);
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
};

test("the plugin manifest is versioned with its package and kept in lockstep by the release sync", () => {
  const manifest = json(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
  const pkg = json(path.join(PLUGIN_DIR, "package.json"));
  // Claude reads the version from plugin.json; npm from package.json.
  expect(manifest.version).toBe(pkg.version);
  // Not compared with the current release: a branch cut before the latest
  // release legitimately carries the previous version until the
  // post-release manifest sync, which owns both files.
  const synced = [
    "packages/workit-claude-code/package.json",
    "packages/workit-claude-code/.claude-plugin/plugin.json",
  ];
  for (const rel of synced) expect(SYNC_MANIFEST_PATHS, rel).toContain(rel);
  const tree = mkdtempSync(path.join(tmpdir(), "workit-claude-sync-"));
  try {
    for (const rel of SYNC_MANIFEST_PATHS) {
      mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      cpSync(path.join(REPO, rel), path.join(tree, rel));
    }
    syncManifests(tree, "v99.0.0");
    for (const rel of synced) expect(json(path.join(tree, rel)).version, rel).toBe("99.0.0");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  expect(manifest.name).toBe("workit");
  expect(manifest.repository).toBe("https://github.com/BrainerVirus/workit");
  // Default component scan: no path overrides that could drift from the layout.
  for (const key of ["hooks", "skills", "agents", "commands", "mcpServers"])
    expect(manifest[key], key).toBeUndefined();
  // Everything runtime is bundled, so an npm-sourced install needs no node_modules.
  expect(pkg.dependencies).toBeUndefined();
});

test("the root marketplace installs the published npm package and pins no version", () => {
  const market = json(path.join(REPO, ".claude-plugin", "marketplace.json"));
  const pkg = json(path.join(PLUGIN_DIR, "package.json"));
  expect(market.name).toBe("workit");
  expect(market.plugins).toHaveLength(1);
  const [entry] = market.plugins;
  expect(entry.name).toBe("workit");
  expect(entry.source).toEqual({ source: "npm", package: pkg.name });
  // plugin.json carries the version; a second one makes validate/tag reject.
  expect(entry.version).toBeUndefined();
});

test("hooks.json registers the designed events through the exec-form launcher, never a shell", () => {
  const hooks = json(path.join(PLUGIN_DIR, "hooks", "hooks.json")).hooks as Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; args?: string[]; if?: string }>;
    }>
  >;
  expect(Object.keys(hooks).toSorted()).toEqual(
    // Only events whose hook changes Claude's behavior are registered: Stop,
    // SubagentStop and PostToolUse are no-ops until the evidence model lands,
    // and PreCompact cannot inject context (SessionStart compact restores it).
    ["PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"].toSorted(),
  );
  for (const [event, groups] of Object.entries(hooks))
    for (const group of groups)
      for (const hook of group.hooks) {
        expect(hook.type, event).toBe("command");
        expect(hook.command, event).toBe("node");
        expect(hook.args, event).toEqual(["${CLAUDE_PLUGIN_ROOT}/bin/workit-hook.mjs"]);
      }
  expect(hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact|fork");
  expect(hooks.PreToolUse.map((group) => [group.matcher, group.hooks[0].if])).toEqual([
    ["Bash", "Bash(git *)"],
    ["PowerShell", "PowerShell(git *)"],
  ]);
});

test("agents: verifier and reviewer are read-only, implementer runs in an isolated worktree", () => {
  const agents = path.join(PLUGIN_DIR, "agents");
  expect(readdirSync(agents).toSorted()).toEqual(["implementer.md", "reviewer.md", "verifier.md"]);
  for (const name of ["verifier", "reviewer"]) {
    const meta = frontmatter(path.join(agents, `${name}.md`));
    expect(meta.name).toBe(name);
    expect(meta.disallowedTools).toContain("Write");
    expect(meta.disallowedTools).toContain("Edit");
    expect(meta.tools).not.toContain("Write");
  }
  const implementer = frontmatter(path.join(agents, "implementer.md"));
  expect(implementer.isolation).toBe("worktree");
  expect(readFileSync(path.join(agents, "implementer.md"), "utf8")).toContain("goal, scope (files");
  // Author is not verifier: the read-only agents record ledger verdicts, the
  // implementer never verdicts its own work.
  const body = (name: string) => readFileSync(path.join(agents, `${name}.md`), "utf8");
  for (const name of ["verifier", "reviewer"])
    expect(body(name), name).toContain("workit ledger verdict");
  expect(body("verifier")).toMatch(/never pass `--self`/);
  expect(body("implementer")).toContain("Never record a verdict on your own work");
  expect(body("implementer")).not.toMatch(/workit ledger verdict/);
  expect(body("implementer")).toContain("workit git branch");
  // Subagents inherit the lead's WORKIT_SESSION_ID; each role acts under its own.
  for (const name of ["verifier", "reviewer", "implementer"])
    expect(body(name), name).toContain('WORKIT_SESSION_ID="$WORKIT_SESSION_ID:');
  // Plugin subagents may ignore these keys; the design forbids relying on them.
  for (const name of ["verifier", "reviewer", "implementer"]) {
    const meta = frontmatter(path.join(agents, `${name}.md`));
    for (const key of ["hooks", "mcpServers", "permissionMode"])
      expect(meta[key], `${name}.${key}`).toBeUndefined();
  }
});

test("skills are generated from workit-core, namespaced without the workit- prefix, and never committed", () => {
  const skills = path.join(installedPlugin(), "skills");
  const expected = WORKIT_METHOD_SKILLS.map((name) => name.replace(/^workit-/, "")).toSorted();
  expect(readdirSync(skills).toSorted()).toEqual(expected);
  for (const name of expected) {
    const file = path.join(skills, name, "SKILL.md");
    expect(frontmatter(file).name, name).toBe(name);
    const source = readFileSync(
      path.join(REPO, "packages", "workit-core", "skills", `workit-${name}`, "SKILL.md"),
      "utf8",
    );
    // Only the frontmatter name changes; host mapping lives in the session
    // addendum, so the body (and its references/) is the canonical one.
    expect(readFileSync(file, "utf8"), name).toBe(
      source.replace(`name: workit-${name}`, `name: ${name}`),
    );
  }
  const tracked = spawnSync("git", ["ls-files", "packages/workit-claude-code/skills"], {
    cwd: REPO,
    encoding: "utf8",
  });
  expect(tracked.stdout.trim()).toBe("");
});

test.skipIf(process.platform === "win32")(
  "given the local pin, bin/workit --version resolves the monorepo source; the installed layout resolves dist/",
  () => {
    const trace = (dir: string) =>
      spawnSync(path.join(dir, "bin", "workit"), ["--version"], {
        encoding: "utf8",
        env: { ...process.env, WORKIT_SHIM_TRACE: "1" },
        timeout: 60_000,
      });
    const pinned = trace(PLUGIN_DIR);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(pinned.stderr).toMatch(/workit-shim: source .*workit-cli[\\/]src[\\/]main\.ts/);
    expect(pinned.stdout.trim()).toBe(CLI_VERSION);
    const installed = trace(installedPlugin());
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stderr).toContain(`workit-shim: dist ${installedPlugin()}/dist/workit.js`);
    expect(installed.stdout.trim()).toBe(CLI_VERSION);
  },
  90_000,
);

test("CI and the eval workflow pin the support-matrix Claude Code CLI", () => {
  for (const workflow of ["ci.yml", "claude-eval.yml"]) {
    const text = readFileSync(path.join(REPO, ".github", "workflows", workflow), "utf8");
    expect(text, workflow).toContain(`CLAUDE_CODE_VERSION: "${SUPPORT_MATRIX.claudeCode.cli}"`);
  }
  const ci = readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  expect(ci).toContain("plugin validate --strict packages/workit-claude-code");
  expect(ci).toContain("plugin validate --strict .");
});
