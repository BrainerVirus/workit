#!/usr/bin/env bun
// Build the Claude Code plugin payload:
//   dist/workit-hook.js  the hook entry (src/hook.ts → core/hooks claude-code)
//   dist/workit.js       the bundled workit CLI for bin/workit
//   assets/templates/    templates the bundled CLI resolves at runtime
//   skills/<name>/       generated from workit-core/skills: `workit-review`
//                        becomes plugin skill `review` (invoked /workit:review)
// Usage: bun scripts/build.ts [target-dir] [--skills-only]
// The target defaults to this package; the pack sandbox passes its copy.
// `--skills-only` is the local-pin step: the hooks and bin/workit run from
// source there, so only the generated skills are needed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKIT_METHOD_SKILLS } from "../../workit-core/src/core/skill-manifests";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.resolve(packageDir, "..");
const coreDir = path.join(packagesDir, "workit-core");
const args = process.argv.slice(2);
const skillsOnly = args.includes("--skills-only");
const targetArg = args.find((arg) => !arg.startsWith("--"));
const target = targetArg ? path.resolve(targetArg) : packageDir;

const PREFIX = "workit-";

/** Plugin skills are namespaced by the plugin (`/workit:<name>`), so the
 * `workit-` prefix is dropped from the directory and the frontmatter name. */
const pluginSkillName = (name: string): string =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;

const CLAUDE_NOTE = `

## In Claude Code

Workit operations (\`task\`, \`evidence\`, \`policy\`, \`decision\`, …) run through
the \`workit\` CLI on the Bash tool: \`workit <family> <action> --json\`
(\`workit --help\` lists the verbs). The plugin's \`verifier\`, \`reviewer\`
and \`implementer\` agents take independent verification, fresh-context
review and isolated implementation.
`;

const transformSkill = (text: string, from: string, to: string): string => {
  const renamed = text.replace(new RegExp(`^name:\\s*${from}\\s*$`, "m"), `name: ${to}`);
  if (renamed === text) throw new Error(`skill ${from}: frontmatter name: ${from} not found`);
  return `${renamed.trimEnd()}\n${CLAUDE_NOTE}`;
};

const buildSkills = () => {
  const skills = path.join(target, "skills");
  rmSync(skills, { recursive: true, force: true });
  mkdirSync(skills, { recursive: true });
  for (const name of WORKIT_METHOD_SKILLS) {
    const source = path.join(coreDir, "skills", name);
    if (!existsSync(path.join(source, "SKILL.md")))
      throw new Error(`missing canonical Workit method skill in core: ${name}`);
    const out = path.join(skills, pluginSkillName(name));
    cpSync(source, out, { recursive: true });
    const file = path.join(out, "SKILL.md");
    writeFileSync(file, transformSkill(readFileSync(file, "utf8"), name, pluginSkillName(name)));
  }
};

const bundle = (entry: string, outfile: string, minify = false) => {
  const result = spawnSync(
    process.execPath,
    [
      "build",
      entry,
      "--outfile",
      outfile,
      "--target",
      "node",
      "--format",
      "esm",
      "--banner",
      "#!/usr/bin/env node",
      ...(minify ? ["--minify"] : []),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(1);
  }
};

if (!skillsOnly) {
  const dist = path.join(target, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // Minified: every hook is a fresh node process, so parse time is startup time.
  bundle(path.join(packageDir, "src", "hook.ts"), path.join(dist, "workit-hook.js"), true);
  // TODO(S9a, PR #163): bundle workit-cli/src/main.ts unconditionally once it
  // is on main; until then the current index.tsx entry is the CLI.
  const cliSrc = path.join(packagesDir, "workit-cli", "src");
  const cliEntry = existsSync(path.join(cliSrc, "main.ts"))
    ? path.join(cliSrc, "main.ts")
    : path.join(cliSrc, "index.tsx");
  bundle(cliEntry, path.join(dist, "workit.js"));
  const assets = path.join(target, "assets");
  rmSync(assets, { recursive: true, force: true });
  const templates = path.join(coreDir, "templates");
  if (existsSync(templates)) cpSync(templates, path.join(assets, "templates"), { recursive: true });
}
buildSkills();

console.log(
  `claude-code: built ${skillsOnly ? "" : "dist/ (hook + CLI), assets/ and "}${WORKIT_METHOD_SKILLS.length} plugin skills (${target})`,
);
