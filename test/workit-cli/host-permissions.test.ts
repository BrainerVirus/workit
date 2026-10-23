import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import {
  applyHostPermissions,
  CLAUDE_ALLOW,
  CLAUDE_ASK,
  codexRulesText,
  CURSOR_ALLOW,
  permissionHealth,
  planHostPermissions,
} from "@/packages/workit-cli/src/admin/host-permissions";
import { applyUninstall, planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { codexRules } from "@/packages/workit-core/src/core/heavy-rules";

// Issue #297: `workit setup` writes a Workit-owned, reversible permission
// block per host after one consent. Every test runs against a scratch HOME and
// state dir; the real ~/.claude, ~/.codex and ~/.cursor are never touched.
const scratch = mkdtempSync(path.join(tmpdir(), "workit-host-perms-"));
const realState = process.env.WORKFLOW_TOOLKIT_STATE;
beforeAll(() => {
  process.env.WORKFLOW_TOOLKIT_STATE = path.join(scratch, "process-state");
});
afterAll(() => {
  if (realState === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = realState;
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
const sandbox = (extra: NodeJS.ProcessEnv = {}) => {
  const home = path.join(scratch, `home-${(n += 1)}`);
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    SHELL: "/bin/zsh",
    WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
    ...extra,
  };
  return { home, env, settings: path.join(home, ".claude", "settings.json") };
};
afterEach(() => undefined);

const cli = async (argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env,
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
};

const USER_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm *)"] },
  autoMode: { environment: ["$defaults", "Org-specific CLIs: acme — deploy tool"] },
  env: { FOO: "1" },
};

test("Given a settings.json with user entries, When `workit setup --hosts claude-code --yes` runs twice, Then Workit's entries are present once, user entries are untouched, and uninstall restores the original", async () => {
  const { env, settings, home } = sandbox();
  writeFileSync(settings, JSON.stringify(USER_SETTINGS, null, 2) + "\n");

  const first = await cli(["setup", "--hosts", "claude-code", "--yes"], env);
  expect(first.code).toBe(0);
  expect(first.stdout).toMatch(/^\+ +"Bash\(workit pr \*\)",$/mu);
  const written = readFileSync(settings, "utf8");
  const second = await cli(["setup", "--hosts", "claude-code", "--yes"], env);
  expect(second.code).toBe(0);
  expect(readFileSync(settings, "utf8")).toBe(written);

  const value = JSON.parse(written);
  expect(value.model).toBe("opus");
  expect(value.permissions.deny).toEqual(["Bash(rm *)"]);
  expect(value.permissions.allow[0]).toBe("Bash(npm test)");
  expect(value.permissions.allow.filter((e: string) => e === "Bash(workit git *)")).toHaveLength(1);
  expect(value.permissions.allow).toContain("Bash(workit ledger *)");
  expect(value.permissions.ask).toEqual([
    "Bash(workit * --unverified*)",
    "Bash(workit * --overwrite-unintegrated*)",
  ]);
  expect(value.autoMode.environment.slice(0, 2)).toEqual([
    "$defaults",
    "Org-specific CLIs: acme — deploy tool",
  ]);
  expect(value.autoMode.environment).toHaveLength(3);
  expect(value.autoMode.environment[2]).toStartWith("Org-specific CLIs: workit");
  expect(value.autoMode.allow).toHaveLength(2);
  expect(value.autoMode.allow[0]).toBe("$defaults");
  expect(value.autoMode.allow[1]).toStartWith("Workit-gated delivery:");
  expect(value.env.FOO).toBe("1");
  expect(value.env.CLAUDE_CODE_SHELL).toMatch(/[\\/]bash$/);

  const plan = planUninstall({ home, env });
  const claude = plan.hosts.find((h) => h.host === "claude-code")!;
  expect(claude.actions.map((a) => a.path)).toEqual([settings]);
  const result = applyUninstall(plan, { home, env });
  expect(result.ok).toBe(true);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(USER_SETTINGS);
});

test("Given a user who already set CLAUDE_CODE_SHELL and a bash shell, When setup runs, Then the shell setting is left alone", async () => {
  const zsh = sandbox();
  writeFileSync(zsh.settings, JSON.stringify({ env: { CLAUDE_CODE_SHELL: "/opt/bash" } }));
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], zsh.env)).code).toBe(0);
  expect(JSON.parse(readFileSync(zsh.settings, "utf8")).env).toEqual({
    CLAUDE_CODE_SHELL: "/opt/bash",
  });

  const bash = sandbox({ SHELL: "/bin/bash" });
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], bash.env)).code).toBe(0);
  expect(JSON.parse(readFileSync(bash.settings, "utf8")).env).toBeUndefined();

  const optOut = sandbox();
  expect(
    (await cli(["setup", "--hosts=claude-code", "--no-shell", "--yes"], optOut.env)).code,
  ).toBe(0);
  expect(JSON.parse(readFileSync(optOut.settings, "utf8")).env).toBeUndefined();
});

test.each([["CLAUDECODE"], ["WORKIT_SESSION_ID"], ["CODEX_THREAD_ID"]])(
  "Given an agent session (%s set), When setup would write host config, Then it refuses with the user-run command and writes nothing",
  async (variable) => {
    const { env, settings } = sandbox({ [variable]: "1" });
    writeFileSync(settings, "{}\n");
    const run = await cli(["setup", "--hosts=claude-code", "--yes"], env);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain(`${variable} is set`);
    expect(run.stderr).toContain("workit setup --hosts=claude-code");
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
  },
);

test("Given no --yes outside a terminal, When setup runs, Then it shows the diff, asks for consent and writes nothing", async () => {
  const { env, settings } = sandbox();
  const run = await cli(["setup", "--hosts=claude-code"], env);
  expect(run.code).toBe(3);
  expect(run.stdout).toContain("--- " + settings + " (new file)");
  expect(run.stderr).toContain("consent");
  expect(existsSync(settings)).toBe(false);
});

test("Given a malformed settings.json, When setup runs, Then it is left byte-for-byte untouched", async () => {
  const { env, settings } = sandbox();
  writeFileSync(settings, "{ not json");
  const run = await cli(["setup", "--hosts=claude-code", "--yes"], env);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("is not valid JSON; left untouched");
  expect(readFileSync(settings, "utf8")).toBe("{ not json");
});

test("Given a reviewed plan, When the file changes before apply, Then apply refuses it", () => {
  const { env, settings, home } = sandbox();
  writeFileSync(settings, "{}\n");
  const plan = planHostPermissions({ hosts: ["claude-code"], env, home, bash: null });
  writeFileSync(settings, '{"model":"sonnet"}\n');
  const [entry] = applyHostPermissions(plan, { env, home });
  expect(entry?.status).toBe("failed");
  expect(entry?.detail).toContain("changed after the preview");
  expect(readFileSync(settings, "utf8")).toBe('{"model":"sonnet"}\n');
});

test("Given Cursor CLI config with user allows, When setup and uninstall run, Then Workit's Shell entries come and go exactly", async () => {
  const { env, home } = sandbox();
  const cliConfig = path.join(home, ".cursor", "cli-config.json");
  mkdirSync(path.dirname(cliConfig), { recursive: true });
  const original = {
    version: 1,
    permissions: { allow: ["Shell(ls)"], deny: [] },
    editor: { vimMode: false },
  };
  writeFileSync(cliConfig, JSON.stringify(original));
  expect((await cli(["setup", "--hosts=cursor", "--yes"], env)).code).toBe(0);
  const value = JSON.parse(readFileSync(cliConfig, "utf8"));
  expect(value.permissions.allow[0]).toBe("Shell(ls)");
  expect(value.permissions.allow).toContain("Shell(workit pr)");
  expect(value.editor).toEqual({ vimMode: false });
  applyUninstall(planUninstall({ home, env }), { home, env });
  expect(JSON.parse(readFileSync(cliConfig, "utf8"))).toEqual(original);
});

test("Given a Codex home, When setup and uninstall run, Then Workit's rules file is written, parsed flat by the heavy gate, and removed", async () => {
  const { env, home } = sandbox();
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  expect((await cli(["setup", "--hosts=codex", "--yes"], env)).code).toBe(0);
  const file = path.join(home, ".codex", "rules", "workit.rules");
  expect(readFileSync(file, "utf8")).toBe(codexRulesText());
  const rules = codexRules(scratch, env);
  expect(rules).not.toBe("unreadable");
  if (rules === "unreadable") return;
  expect(rules.allow).toContain("workit pr");
  expect(rules.allow).not.toContain("workit check");
  expect(rules.deny).toEqual(["workit grant"]);
  applyUninstall(planUninstall({ home, env }), { home, env });
  expect(existsSync(file)).toBe(false);
});

test("Given hosts without a permission layer or not installed, When setup runs, Then each gets a note and nothing is written", async () => {
  const { env, home } = sandbox();
  const run = await cli(["setup", "--hosts=opencode,pi,cursor", "--yes"], env);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("opencode: nothing to write");
  expect(run.stdout).toContain("pi: nothing to write");
  expect(run.stdout).toContain("cursor: not installed");
  expect(existsSync(path.join(home, ".cursor"))).toBe(false);
});

test("Given Workit's block, When it is whole, partial or absent, Then the doctor health says ok, drift or absent", async () => {
  const { env, home, settings } = sandbox();
  expect(permissionHealth("claude-code", { env, home }).state).toBe("absent");
  await cli(["setup", "--hosts=claude-code", "--yes"], env);
  expect(permissionHealth("claude-code", { env, home }).state).toBe("ok");
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.permissions.allow = value.permissions.allow.filter(
    (e: string) => e !== "Bash(workit pr *)",
  );
  writeFileSync(settings, JSON.stringify(value));
  const health = permissionHealth("claude-code", { env, home });
  expect(health.state).toBe("drift");
  expect("detail" in health ? health.detail : "").toContain("Bash(workit pr *)");
  expect(permissionHealth("codex", { env, home }).state).toBe("no-host");
});

// --- no rule on any host matches an arbitrary-command or authority verb ------

// Claude Code's documented matcher: `*` matches any text; a trailing ` *` also
// matches the bare command (code.claude.com/docs/en/permissions).
const claudeMatches = (rule: string, command: string): boolean => {
  const body = /^Bash\((.*)\)$/u.exec(rule)?.[1] ?? "";
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  const pattern = body.endsWith(" *") ? escaped.replace(/ \.\*$/u, "(?: .*)?") : escaped;
  return new RegExp(`^${pattern}$`, "u").test(command);
};
// cursor-agent 2026.09.26 `matchesShell`: the pattern, or the pattern then a space.
const cursorMatches = (rule: string, command: string): boolean => {
  const full = /^Shell\((.*)\)$/u.exec(rule)?.[1] ?? "";
  return command === full || command.startsWith(`${full} `);
};

const FORBIDDEN = [
  "workit check -- rm -rf x",
  "workit check test",
  "workit lock run -- rm -rf x",
  "workit grant set work merge=true",
  "workit grant unset work merge",
  "workit gc --prune-recovery --yes",
  "workit test-audit run",
];

test.each(FORBIDDEN)(
  "Given `%s`, Then no Claude Code, Cursor or Codex allow rule matches it",
  (command) => {
    expect(CLAUDE_ALLOW.filter((rule) => claudeMatches(rule, command))).toEqual([]);
    expect(CURSOR_ALLOW.filter((rule) => cursorMatches(rule, command))).toEqual([]);
    const codexAllows = [
      ...codexRulesText().matchAll(/pattern = \[([^\]]*)\],\n\s*decision = "allow"/gu),
    ].map((m) => JSON.parse(`[${m[1]}]`) as string[]);
    const words = command.split(" ");
    expect(codexAllows.filter((p) => p.every((w, i) => words[i] === w))).toEqual([]);
  },
);

test("Given a delivery call, Then the Claude Code allow rules match it and a bypass flag meets an ask rule", () => {
  for (const command of [
    "workit pr merge --pr 7",
    "workit git --cwd /w push",
    "workit doctor",
    "workit --version",
  ])
    expect(
      CLAUDE_ALLOW.some((rule) => claudeMatches(rule, command)),
      command,
    ).toBe(true);
  expect(
    CLAUDE_ASK.some((rule) => claudeMatches(rule, "workit pr merge --unverified --reason x")),
  ).toBe(true);
  expect(
    CLAUDE_ASK.some((rule) => claudeMatches(rule, "workit stack land --overwrite-unintegrated")),
  ).toBe(true);
});
