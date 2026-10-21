// Ruling mvid5onk: the heavy-command gate wraps a command only when no
// readable host deny/ask rule names it and wrapping does not raise its
// permission. The matcher is conservative; anything unreadable counts as
// naming it.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeRules,
  claudeSettingsFiles,
  codexRules,
  cursorRules,
  names,
  opencodeRules,
  wrapAllowed,
  type RuleRead,
} from "@/packages/workit-core/src/core/heavy-rules";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** A repo and a scratch home, so no real host config is read. */
const setup = () => {
  const repo = temp("wk-rules-repo-");
  mkdirSync(path.join(repo, ".git"));
  const home = temp("wk-rules-home-");
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  return { repo, home, env };
};

test("Given the matcher table, Then a deny rule names a command by any word's base name, a glob or a bare tool rule", () => {
  const words = ["npx", "jest"];
  expect(names("npx:*", words)).toBe(true);
  expect(names("jest:*", words)).toBe(true);
  expect(names("touch:*", words)).toBe(false);
  expect(names("", words)).toBe(true);
  expect(names("*", words)).toBe(true);
  expect(names("np*", words)).toBe(true);
  expect(names("npx jest --ci", words)).toBe(true);
  expect(names("/usr/bin/npx", words)).toBe(true);
});

test("Given an allow for workit alone, When `make test` is judged, Then wrapping is refused unless the host bypasses permissions", () => {
  const rules: RuleRead = { deny: [], allow: ["workit:*"] };
  expect(wrapAllowed(rules, ["make", "test"], "make test")).toEqual({
    ok: false,
    why: "allowlisted",
  });
  expect(wrapAllowed(rules, ["make", "test"], "make test", { bypass: true })).toEqual({ ok: true });
  // An allow for the command itself means wrapping raises nothing.
  expect(
    wrapAllowed({ deny: [], allow: ["workit:*", "make test"] }, ["make", "test"], "make test"),
  ).toEqual({ ok: true });
  // A literal workit prefix that cannot match the wrapper covers nothing.
  expect(
    wrapAllowed(
      { deny: [], allow: ["workit git push --release:*"] },
      ["make", "test"],
      "make test",
    ),
  ).toEqual({ ok: true });
  expect(wrapAllowed("unreadable", ["make"], "make")).toEqual({ ok: false, why: "named" });
});

test("Given Claude Code settings, When read, Then CLAUDE_CONFIG_DIR, the project settings and settings.local.json all count; missing files mean no rules", () => {
  const { repo, home, env } = setup();
  expect(claudeRules(repo, env)).toEqual({ deny: [], allow: [] });
  const config = path.join(home, "claude-config");
  write(
    path.join(config, "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(npx:*)"] } }),
  );
  write(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({ permissions: { ask: ["Bash(make:*)"] } }),
  );
  write(
    path.join(repo, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(workit:*)", "Read(*)"], deny: ["Edit"] } }),
  );
  expect(claudeRules(repo, { ...env, CLAUDE_CONFIG_DIR: config })).toEqual({
    deny: ["npx:*", "make:*"],
    allow: ["workit:*"],
  });
});

test("Given the managed settings path, Then it is read first on each platform", () => {
  expect(claudeSettingsFiles("/repo", { HOME: "/h" }, "linux")[0]).toBe(
    "/etc/claude-code/managed-settings.json",
  );
  expect(claudeSettingsFiles("/repo", { HOME: "/h" }, "darwin")[0]).toBe(
    "/Library/Application Support/ClaudeCode/managed-settings.json",
  );
  expect(claudeSettingsFiles("/repo", { HOME: "/h" }, "win32")[0]).toBe(
    "C:\\Program Files\\ClaudeCode\\managed-settings.json",
  );
});

test("Given malformed Claude settings, When read, Then they count as naming everything", () => {
  const { repo, env } = setup();
  write(path.join(repo, ".claude", "settings.json"), "{ not json");
  expect(claudeRules(repo, env)).toBe("unreadable");
});

test("Given OpenCode configs (global jsonc, project, agent permissions, env content), When read, Then bash and shell rules are unioned", () => {
  const { repo, home, env } = setup();
  write(
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    '{ // comment\n "permission": { "bash": { "npx *": "deny", "git status": "allow", } } }',
  );
  write(
    path.join(repo, "opencode.json"),
    JSON.stringify({ agent: { build: { permission: { shell: "ask" } } } }),
  );
  expect(
    opencodeRules(repo, {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: { "workit *": "allow" } } }),
    }),
  ).toEqual({ deny: ["npx *", ""], allow: ["git status", "workit *"] });
  write(path.join(repo, ".opencode", "opencode.json"), '{"permission": {"bash": {"x": "maybe"}}}');
  expect(opencodeRules(repo, env)).toBe("unreadable");
});

test("Given Codex .rules files, When read, Then forbidden and prompt rules deny, allow rules allow, and a doubtful rule means unreadable", () => {
  const { repo, home, env } = setup();
  write(
    path.join(home, ".codex", "rules", "default.rules"),
    'prefix_rule(pattern=["pwd"], decision="allow")\nprefix_rule(pattern=["npx", "jest"], decision="forbidden")\n',
  );
  write(
    path.join(repo, ".codex", "rules", "repo.rules"),
    'prefix_rule(pattern=["make"], decision="prompt")',
  );
  expect(codexRules(repo, env)).toEqual({ deny: ["npx jest", "make"], allow: ["pwd"] });
  write(
    path.join(repo, ".codex", "rules", "odd.rules"),
    'prefix_rule(pattern=[["npm", "pnpm"], "test"], decision="forbidden")',
  );
  expect(codexRules(repo, env)).toBe("unreadable");
});

test("Given Cursor CLI configs, When read, Then Shell(x) deny and allow entries count", () => {
  const { repo, home, env } = setup();
  write(
    path.join(home, ".cursor", "cli-config.json"),
    JSON.stringify({ permissions: { allow: ["Shell(ls)", "Read(**)"] } }),
  );
  write(
    path.join(repo, ".cursor", "cli.json"),
    JSON.stringify({ permissions: { deny: ["Shell(npx)"] } }),
  );
  expect(cursorRules(repo, env)).toEqual({ deny: ["npx"], allow: ["ls"] });
});
