// S14 plugin shape: manifest, marketplace entry, hooks registration, agents,
// generated skills, and the source/dist resolution of the local pin.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { WORKIT_METHOD_SKILLS } from "@/packages/workit-core/src/core/skill-manifests";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import { installedPlugin, PLUGIN_DIR } from "./plugin-helpers";

const REPO = path.resolve(PLUGIN_DIR, "..", "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

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

test("the plugin manifest tracks the released version and the canonical repository", () => {
  const manifest = json(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
  const pkg = json(path.join(PLUGIN_DIR, "package.json"));
  const core = json(path.join(REPO, "packages", "workit-core", "package.json"));
  expect(manifest.name).toBe("workit");
  expect(manifest.version).toBe(core.version);
  expect(pkg.version).toBe(core.version);
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
    [
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ].toSorted(),
  );
  for (const [event, groups] of Object.entries(hooks))
    for (const group of groups)
      for (const hook of group.hooks) {
        expect(hook.type, event).toBe("command");
        expect(hook.command, event).toBe("node");
        expect(hook.args, event).toEqual(["${CLAUDE_PLUGIN_ROOT}/bin/workit-hook.mjs"]);
      }
  expect(hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
  expect(hooks.PreToolUse.map((group) => [group.matcher, group.hooks[0].if])).toEqual([
    ["Bash", "Bash(git *)"],
    ["PowerShell", "PowerShell(git *)"],
  ]);
  expect(hooks.PostToolUse.map((group) => [group.matcher, group.hooks[0].if])).toEqual([
    ["Bash", "Bash(workit *)"],
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
    const generated = readFileSync(file, "utf8");
    expect(generated, name).toContain("## In Claude Code");
    // The method body is the canonical one, untouched.
    expect(generated, name).toContain(source.slice(source.indexOf("\n---\n") + 5).trim());
  }
  const tracked = spawnSync("git", ["ls-files", "packages/workit-claude-code/skills"], {
    cwd: REPO,
    encoding: "utf8",
  });
  expect(tracked.stdout.trim()).toBe("");
});

test.skipIf(process.platform === "win32")(
  "given the local pin, bin/workit resolves the monorepo source; the installed layout resolves dist/",
  () => {
    const trace = (dir: string) =>
      spawnSync(path.join(dir, "bin", "workit"), ["--help"], {
        encoding: "utf8",
        env: { ...process.env, WORKIT_SHIM_TRACE: "1" },
        timeout: 60_000,
      });
    const pinned = trace(PLUGIN_DIR);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(pinned.stderr).toMatch(
      /workit-shim: source .*workit-cli[\\/]src[\\/](main\.ts|index\.tsx)/,
    );
    expect(pinned.stdout).toContain("workit");
    const installed = trace(installedPlugin());
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stderr).toContain(`workit-shim: dist ${installedPlugin()}/dist/workit.js`);
    expect(installed.stdout).toContain("workit");
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
