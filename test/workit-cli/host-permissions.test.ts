import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import {
  applyHostPermissions,
  CLAUDE_ALLOW,
  CLAUDE_ASK,
  codexRulesText,
  CURSOR_ALLOW,
  CURSOR_DENY,
  removeOwnedEntries,
  permissionDiff,
  permissionHealth,
  planHostPermissions,
} from "@/packages/workit-cli/src/admin/host-permissions";
import { applyUninstall, planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { codexRules } from "@/packages/workit-core/src/core/heavy-rules";
import { WORKIT_USER_ONLY } from "@/packages/workit-core/src/hooks/delivery-verbs";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";

// Issue #297: `workit setup` writes a Workit-owned, reversible permission
// block per host after one consent. Every test runs against a scratch HOME and
// state dir; the real ~/.claude, ~/.codex and ~/.cursor are never touched.
const scratch = mkdtempSync(path.join(tmpdir(), "workit-host-perms-"));
const realState = process.env.WORKIT_STATE_DIR;
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = path.join(scratch, "process-state");
});
afterAll(() => {
  if (realState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = realState;
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
    WORKIT_STATE_DIR: path.join(home, "state"),
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
  autoMode: {
    environment: ["$defaults", "Org-specific CLIs: acme — deploy tool"],
  },
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
  expect(value.permissions.deny[0]).toBe("Bash(rm *)");
  expect(value.permissions.deny.slice(1).every((e: string) => e.startsWith("Edit(//"))).toBe(true);
  expect(value.permissions.allow[0]).toBe("Bash(npm test)");
  expect(value.permissions.allow.filter((e: string) => e === "Bash(workit git *)")).toHaveLength(1);
  expect(value.permissions.allow).toContain("Bash(workit ledger *)");
  expect(value.permissions.ask).toEqual([
    "Bash(workit pr merge *--unverified*)",
    "Bash(workit stack land *--unverified*)",
    "Bash(workit git push *--overwrite-unintegrated*)",
    "Bash(workit release notes approve*)",
    "Bash(workit grant set*)",
    "Bash(workit grant raise*)",
    "Bash(workit ledger void*)",
    "Bash(workit approve*)",
    "Bash(workit setup*)",
    "Bash(workit uninstall*)",
    "Bash(workit install*)",
    "Bash(workit workspace seal*)",
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
  expect(value.autoMode.allow[1]).toContain("Does NOT cover `workit release notes approve`");
  expect(value.env.FOO).toBe("1");
  expect(value.env.CLAUDE_CODE_SHELL).toMatch(/[\\/]bash$/);

  const plan = planUninstall({ home, env });
  const claude = plan.hosts.find((h) => h.host === "claude-code")!;
  expect(claude.actions.map((a) => [a.kind, a.path])).toEqual([
    ["edit-json-remove", settings],
    ["forget-ownership", path.join(env.WORKIT_STATE_DIR!, "host-permissions.json")],
  ]);
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
  const plan = planHostPermissions({
    hosts: ["claude-code"],
    env,
    home,
    bash: null,
  });
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
  expect(rules.deny).toEqual([
    "workit grant",
    "workit release notes approve",
    "workit grant set",
    "workit grant raise",
    "workit ledger void",
    "workit approve",
    "workit setup",
    "workit uninstall",
    "workit install",
    "workit workspace seal",
  ]);
  applyUninstall(planUninstall({ home, env }), { home, env });
  expect(existsSync(file)).toBe(false);
});

test("Given hosts without a permission layer or not installed, When setup runs, Then each gets a note and nothing is written", async () => {
  const { env, home } = sandbox();
  const run = await cli(["setup", "--hosts=opencode,pi,cursor", "--yes"], env);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("opencode: not installed");
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
  "workit check --name test -- rm -rf x",
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

test("Given the lease verbs, Then Claude Code, Cursor and Codex allow `workit check <name>` and `workit lock status|wait`", () => {
  const codexAllows = [
    ...codexRulesText().matchAll(/pattern = \[([^\]]*)\],\n\s*decision = "allow"/gu),
  ].map((m) => JSON.parse(`[${m[1]}]`) as string[]);
  for (const command of [
    "workit check test",
    "workit check lint",
    "workit check typecheck",
    "workit lock status",
    "workit lock wait --timeout 60",
  ]) {
    expect(
      CURSOR_ALLOW.some((rule) => cursorMatches(rule, command)),
      command,
    ).toBe(true);
    expect(
      CLAUDE_ALLOW.some((rule) => claudeMatches(rule, command)),
      command,
    ).toBe(true);
    const words = command.split(" ");
    expect(
      codexAllows.some((p) => p.every((w, i) => words[i] === w)),
      command,
    ).toBe(true);
  }
});

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
    CLAUDE_ASK.some((rule) =>
      claudeMatches(rule, "workit git push --force-with-lease --overwrite-unintegrated"),
    ),
  ).toBe(true);
});

test("Given a drifted Claude Code block, When doctor runs, Then its permission row warns with the setup command", async () => {
  const { env, home, settings } = sandbox();
  await cli(["setup", "--hosts=claude-code", "--yes"], env);
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.autoMode.allow = ["$defaults"];
  writeFileSync(settings, JSON.stringify(value));
  const report = runDoctor({
    home,
    env,
    stateDir: env.WORKIT_STATE_DIR,
    cwd: scratch,
  });
  const row = report.checks.find((c) => c.id === "claude_permissions");
  expect(row?.status).toBe("warn");
  expect(row?.fix).toBe("workit setup --hosts=claude-code");
  expect(report.checks.find((c) => c.id === "codex_permissions")?.status).toBe("info");
});

/** Rewrite Workit's ownership record in `env`'s state dir. */
const editRecord = (env: NodeJS.ProcessEnv, edit: (record: any) => void) => {
  const file = path.join(env.WORKIT_STATE_DIR!, "host-permissions.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  edit(record);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
};

test("Given the upgrade refresh, When no block was written, Then nothing is planned; When the user removed a Workit entry, Then it is not re-added; When this version offers a new entry, Then only that entry is added, without the shell", async () => {
  const fresh = sandbox();
  writeFileSync(fresh.settings, "{}\n");
  const none = planHostPermissions({
    hosts: ["claude-code"],
    refreshOnly: true,
    env: fresh.env,
    home: fresh.home,
  });
  expect(none.changes).toEqual([]);

  const { env, home, settings } = sandbox();
  await cli(["setup", "--hosts=claude-code", "--no-shell", "--yes"], env);
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.permissions.allow = value.permissions.allow.filter(
    (e: string) => e !== "Bash(workit ci *)" && e !== "Bash(workit stack *)",
  );
  writeFileSync(settings, JSON.stringify(value, null, 2) + "\n");
  const refresh = () =>
    planHostPermissions({
      hosts: ["claude-code"],
      refreshOnly: true,
      shell: false,
      env,
      home,
    });
  // The user removed both: the refresh leaves them out.
  expect(refresh().changes).toEqual([]);
  // An older Workit never offered `stack`: this version adds it, not `ci`.
  editRecord(env, (record) => {
    const offered = record.hosts["claude-code"].offered;
    offered["permissions.allow"] = offered["permissions.allow"].filter(
      (e: string) => e !== "Bash(workit stack *)",
    );
  });
  const plan = refresh();
  expect(plan.changes).toHaveLength(1);
  expect(plan.changes[0]?.owned.lists).toEqual({
    "permissions.allow": ["Bash(workit stack *)"],
  });
  expect(plan.changes[0]?.after).not.toContain("Bash(workit ci *)");
  expect(plan.changes[0]?.after).not.toContain("CLAUDE_CODE_SHELL");
});

test("Given a Cursor block an older Workit wrote, When `workit upgrade --apply --confirm` runs, Then it adds only the new entry and prints the diff it applied", async () => {
  const { env, home } = sandbox();
  const cliConfig = path.join(home, ".cursor", "cli-config.json");
  mkdirSync(path.dirname(cliConfig), { recursive: true });
  writeFileSync(cliConfig, JSON.stringify({ permissions: { allow: ["Shell(ls)"] } }));
  expect((await cli(["setup", "--hosts=cursor", "--yes"], env)).code).toBe(0);
  const value = JSON.parse(readFileSync(cliConfig, "utf8"));
  value.permissions.allow = value.permissions.allow.filter(
    (e: string) => e !== "Shell(workit ci)" && e !== "Shell(workit ledger)",
  );
  writeFileSync(cliConfig, JSON.stringify(value, null, 2) + "\n");
  editRecord(env, (record) => {
    const cursor = record.hosts.cursor;
    for (const lists of [cursor.offered, cursor.owned.lists])
      lists["permissions.allow"] = lists["permissions.allow"].filter(
        (e: string) => e !== "Shell(workit ci)",
      );
  });
  let stdout = "";
  const code = await runUpgradeCommand(["--hosts=cursor", "--apply", "--confirm"], {
    home,
    // No agent session in this test, whatever runs it.
    env: {
      ...env,
      CLAUDECODE: "",
      WORKIT_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      OPENCODE_SESSION_ID: "",
      PI_SESSION_ID: "",
      CURSOR_AGENT: "",
    },
    run: () => ({ status: 1, stdout: "" }),
    activeHosts: () => [],
    // The closing doctor is not under test here; never run the real subset.
    doctor: () => ({ checks: [] }),
    out: { write: (text) => void (stdout += text) },
  });
  expect(code, stdout).toBe(0);
  const allow = JSON.parse(readFileSync(cliConfig, "utf8")).permissions.allow;
  expect(allow).toContain("Shell(workit ci)");
  expect(allow).not.toContain("Shell(workit ledger)");
  const report = JSON.parse(stdout);
  expect(report.permissions.written).toEqual([
    { host: "cursor", file: cliConfig, status: "written" },
  ]);
  expect(report.permissions.changes[0].diff).toMatch(/^\+ +"Shell\(workit ci\)",?$/mu);
});

test("Given a tampered ownership record, When uninstall runs, Then only Workit-shaped entries go and the user's deny rule and env survive", async () => {
  const { env, home, settings } = sandbox();
  writeFileSync(settings, JSON.stringify(USER_SETTINGS, null, 2) + "\n");
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.env.ANTHROPIC_BASE_URL = "https://example.test";
  writeFileSync(settings, JSON.stringify(value, null, 2) + "\n");
  editRecord(env, (record) => {
    const owned = record.hosts["claude-code"].owned;
    owned.lists["permissions.deny"].push("Bash(rm *)");
    owned.lists["permissions.allow"].push("Bash(npm test)");
    owned.lists["autoMode.environment"].push("Org-specific CLIs: acme — deploy tool");
    owned.env.ANTHROPIC_BASE_URL = "https://example.test";
    owned.env.FOO = "1";
    owned.created.push("model");
  });
  const result = applyUninstall(planUninstall({ home, env }), { home, env });
  expect(result.ok).toBe(true);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.permissions.deny).toEqual(["Bash(rm *)"]);
  expect(after.permissions.allow).toEqual(["Bash(npm test)"]);
  expect(after.autoMode.environment).toEqual(USER_SETTINGS.autoMode.environment);
  expect(after.env).toEqual({
    FOO: "1",
    ANTHROPIC_BASE_URL: "https://example.test",
  });
  expect(after.model).toBe("opus");
  expect(after.permissions.ask).toBeUndefined();
});

test("Given a tampered ownership record naming the user's own `Bash(workit …)` ask rules and CLAUDE_CODE_SHELL, When uninstall runs, Then only entries a Workit version offered go", async () => {
  const { env, home, settings } = sandbox();
  const user = {
    permissions: { ask: ["Bash(workit grant *)", "Bash(workit pr merge *)"] },
    env: { CLAUDE_CODE_SHELL: "/opt/my/bash" },
  };
  writeFileSync(settings, JSON.stringify(user, null, 2) + "\n");
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  editRecord(env, (record) => {
    const owned = record.hosts["claude-code"].owned;
    owned.lists["permissions.ask"].push("Bash(workit grant *)", "Bash(workit pr merge *)");
    owned.lists["permissions.allow"].push("Bash(workit grant *)");
    owned.env.CLAUDE_CODE_SHELL = "/opt/my/bash";
  });
  const result = applyUninstall(planUninstall({ home, env }), { home, env });
  expect(result.ok).toBe(true);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.permissions.ask).toEqual(["Bash(workit grant *)", "Bash(workit pr merge *)"]);
  expect(after.env).toEqual({ CLAUDE_CODE_SHELL: "/opt/my/bash" });
});

const OLD_AUTO_ALLOW =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `--unverified`, `--admin` or any bypass flag.";
/** The line from #615 until `setup`, `uninstall`, `install` and `workspace seal` became user-only. */
const V2_AUTO_ALLOW =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `workit release notes approve`, `workit grant set|raise`, `--unverified`, `--admin` or any bypass flag: the user decides those.";

test.each([
  ["the #297 line", OLD_AUTO_ALLOW],
  ["the #615 line", V2_AUTO_ALLOW],
])(
  "Given a block with %s, When `workit upgrade` refreshes, Then the old line is replaced once and uninstall removes the new one",
  async (_name, oldLine) => {
    const { env, home, settings } = sandbox();
    writeFileSync(settings, JSON.stringify(USER_SETTINGS, null, 2) + "\n");
    expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
    const value = JSON.parse(readFileSync(settings, "utf8"));
    value.autoMode.allow = ["$defaults", oldLine];
    writeFileSync(settings, JSON.stringify(value, null, 2) + "\n");
    editRecord(env, (record) => {
      const host = record.hosts["claude-code"];
      host.owned.lists["autoMode.allow"] = [oldLine];
      host.offered["autoMode.allow"] = [oldLine];
    });
    const plan = planHostPermissions({
      home,
      env,
      hosts: ["claude-code"],
      refreshOnly: true,
    });
    expect(applyHostPermissions(plan, { home, env })[0].status).toBe("written");
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.autoMode.allow).toHaveLength(2);
    expect(after.autoMode.allow[1]).not.toBe(oldLine);
    for (const words of WORKIT_USER_ONLY)
      expect(after.autoMode.allow[1]).toContain(
        words.join(" ") === "grant set" || words.join(" ") === "grant raise"
          ? "`workit grant set|raise`"
          : `\`workit ${words.join(" ")}\``,
      );

    const result = applyUninstall(planUninstall({ home, env }), { home, env });
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(USER_SETTINGS);
  },
);

test("Given settings with the old auto-mode lines and the current one and no record, When uninstall runs, Then every Workit line is removed", async () => {
  const { env, settings: file } = sandbox();
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  const current = JSON.parse(readFileSync(file, "utf8")).autoMode.allow.at(-1) as string;
  expect(current).toStartWith("Workit-gated delivery:");
  for (const allow of [
    [OLD_AUTO_ALLOW],
    [V2_AUTO_ALLOW],
    [OLD_AUTO_ALLOW, V2_AUTO_ALLOW, current],
  ]) {
    const settings = { autoMode: { allow: ["$defaults", ...allow] } };
    const { next } = removeOwnedEntries(settings, null, "claude-code");
    expect(next.autoMode, allow.join("\n")).toEqual({ allow: ["$defaults"] });
  }
});

test("Given Codex and Cursor, When rules are written, Then Codex prompts and Cursor denies the user-only calls", () => {
  expect(codexRulesText()).toContain(
    'pattern = ["workit","release","notes","approve"],\n    decision = "prompt"',
  );
  expect(codexRulesText()).toContain(
    'pattern = ["workit","grant","raise"],\n    decision = "prompt"',
  );
  expect(CURSOR_DENY).toContain("Shell(workit release notes approve)");
  // Host-approval channel: Codex and Cursor are fallback-only until probed (hosts.md).
  expect(codexRulesText()).toContain('pattern = ["workit","approve"],\n    decision = "prompt"');
  expect(CURSOR_DENY).toContain("Shell(workit approve)");
  // Whole verbs: host setup, removal and the workspace seal, previews included.
  for (const words of [["setup"], ["uninstall"], ["install"], ["workspace", "seal"]]) {
    expect(codexRulesText()).toContain(
      `pattern = ${JSON.stringify(["workit", ...words])},\n    decision = "prompt"`,
    );
    expect(CURSOR_DENY).toContain(`Shell(workit ${words.join(" ")})`);
    expect(CLAUDE_ASK).toContain(`Bash(workit ${words.join(" ")}*)`);
  }
});

// A command that only mentions a user-only call or a bypass flag in its text
// (a verdict's --how, a changelog entry) is no such call: no ask rule may match
// it. The real calls still ask: anchored rules here, the PreToolUse hook for a
// global option before the verb (hooks/delivery-verbs-ledger-void.test.ts).
const MENTIONS = [
  'workit ledger verdict verified --how "mentions release notes approve and ledger void"',
  `workit changelog apply --entries '{"Fixed":["pr merge --unverified"]}'`,
  'workit pr create --body "never use git push --overwrite-unintegrated or grant set here"',
  'workit ledger decision "ran workit approve ap_aaaaaaaa" --why x',
];

test("Given a command that only mentions a user-only call or bypass flag, Then no Claude Code ask rule matches it", () => {
  for (const command of MENTIONS)
    expect(
      CLAUDE_ASK.filter((rule) => claudeMatches(rule, command)),
      command,
    ).toEqual([]);
});

test("Given a real user-only call or bypass flag, Then a Claude Code ask rule matches it, and its --cwd form meets no allow rule", () => {
  for (const command of [
    "workit release notes approve 1.0.0",
    "workit ledger void mwbe83fk --reason x",
    "workit approve ap_aaaaaaaa ap_bbbbbbbb",
    "workit grant set ws merge=true",
    "workit setup --preview",
    "workit uninstall --hosts=cursor --yes",
    "workit install --hosts=cursor --yes",
    "workit workspace seal",
    "workit pr merge --unverified --reason x",
    "workit stack land --unverified --reason x",
    "workit git push --force-with-lease --overwrite-unintegrated",
  ])
    expect(
      CLAUDE_ASK.some((rule) => claudeMatches(rule, command)),
      command,
    ).toBe(true);
  expect(
    CLAUDE_ALLOW.filter((rule) => claudeMatches(rule, "workit --cwd /a ledger void x")),
  ).toEqual([]);
});

test("Given mid-command ask globs an older Workit wrote and one the user wrote, When setup refreshes, Then only Workit's are removed, and uninstall keeps the user's", async () => {
  const { env, home, settings } = sandbox();
  const userGlob = "Bash(workit * grant set*)";
  writeFileSync(settings, JSON.stringify({ permissions: { ask: [userGlob] } }, null, 2) + "\n");
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  const old = ["Bash(workit * --unverified*)", "Bash(workit * ledger void*)"];
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.permissions.ask.push(...old);
  writeFileSync(settings, JSON.stringify(value, null, 2) + "\n");
  editRecord(env, (record) => {
    const host = record.hosts["claude-code"];
    host.owned.lists["permissions.ask"].push(...old);
    host.offered["permissions.ask"].push(...old);
  });

  const plan = planHostPermissions({
    home,
    env,
    hosts: ["claude-code"],
    refreshOnly: true,
  });
  expect(applyHostPermissions(plan, { home, env })[0].status).toBe("written");
  const ask = JSON.parse(readFileSync(settings, "utf8")).permissions.ask as string[];
  expect(ask).toContain(userGlob);
  for (const entry of old) expect(ask).not.toContain(entry);
  expect(ask.filter((rule) => rule.startsWith("Bash(workit * ") && rule !== userGlob)).toEqual([]);

  expect(applyUninstall(planUninstall({ home, env }), { home, env }).ok).toBe(true);
  expect(JSON.parse(readFileSync(settings, "utf8")).permissions.ask).toEqual([userGlob]);
});

// #820: native deny rules for the guarded paths ride the same managed block.
const realHome = (home: string) => realpathSync(home).replaceAll("\\", "/");
const guardedTails = ["state/issued*", "state/approvals", ".config/workit/workspaces.json"];

test("Given a fixture home and settings.json with the user's own rules, When `workit setup --hosts=claude-code --yes` runs, Then permissions.deny gains an Edit(//…) rule for every guarded path, a second setup changes nothing, and uninstall restores the user's file byte for byte", async () => {
  const { env, home, settings } = sandbox();
  const original = JSON.stringify(USER_SETTINGS, null, 2) + "\n";
  writeFileSync(settings, original);
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  const written = readFileSync(settings, "utf8");
  const deny = JSON.parse(written).permissions.deny as string[];
  const root = realHome(home).replace(/^\/+/u, "");
  expect(deny[0]).toBe("Bash(rm *)");
  for (const tail of [
    "state/issued*",
    "state/issued*/**",
    "state/approvals",
    "state/approvals/**",
    ".config/workit/workspaces.json",
    ".config/workit/workspaces.json.seal",
  ])
    expect(deny).toContain(`Edit(//${root}/${tail})`);

  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  expect(readFileSync(settings, "utf8")).toBe(written);
  expect(applyUninstall(planUninstall({ home, env }), { home, env }).ok).toBe(true);
  expect(readFileSync(settings, "utf8")).toBe(original);
});

test("Given a deny rule Workit wrote for a guarded path that moved and the user's own rule of the same shape, When setup runs again, Then only Workit's stale rule goes", async () => {
  const { env, home, settings } = sandbox();
  const user = "Edit(//srv/bench/state/approvals/**)";
  writeFileSync(settings, JSON.stringify({ permissions: { deny: [user] } }, null, 2) + "\n");
  expect((await cli(["setup", "--hosts=claude-code", "--yes"], env)).code).toBe(0);
  const stale = "Edit(//old/home/.local/state/workit/issued*)";
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.permissions.deny.push(stale);
  writeFileSync(settings, JSON.stringify(value, null, 2) + "\n");
  editRecord(env, (record) =>
    record.hosts["claude-code"].owned.lists["permissions.deny"].push(stale),
  );

  const plan = planHostPermissions({ home, env, hosts: ["claude-code"] });
  expect(plan.changes).toHaveLength(1);
  expect(permissionDiff(plan.changes[0])).toMatch(
    /^- +"Edit\(\/\/old\/home\/\.local\/state\/workit\/issued\*\)"$/mu,
  );
  expect(applyHostPermissions(plan, { home, env })[0].status).toBe("written");
  const deny = JSON.parse(readFileSync(settings, "utf8")).permissions.deny as string[];
  expect(deny).toContain(user);
  expect(deny).not.toContain(stale);
  const record = JSON.parse(
    readFileSync(path.join(env.WORKIT_STATE_DIR!, "host-permissions.json"), "utf8"),
  );
  expect(record.hosts["claude-code"].owned.lists["permissions.deny"]).not.toContain(stale);

  expect(applyUninstall(planUninstall({ home, env }), { home, env }).ok).toBe(true);
  expect(JSON.parse(readFileSync(settings, "utf8")).permissions.deny).toEqual([user]);
});

test("Given Cursor CLI config with the user's deny rule, When setup and uninstall run, Then Write(<abs>) rules for every guarded path come and go and the file is restored byte for byte", async () => {
  const { env, home } = sandbox();
  const file = path.join(home, ".cursor", "cli-config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const original =
    JSON.stringify({ permissions: { allow: [], deny: ["Shell(rm)"] } }, null, 2) + "\n";
  writeFileSync(file, original);
  expect((await cli(["setup", "--hosts=cursor", "--yes"], env)).code).toBe(0);
  const deny = JSON.parse(readFileSync(file, "utf8")).permissions.deny as string[];
  expect(deny[0]).toBe("Shell(rm)");
  for (const rule of CURSOR_DENY) expect(deny).toContain(rule);
  for (const tail of [...guardedTails, "state/approvals/*", ".config/workit/workspaces.json.seal"])
    expect(deny).toContain(`Write(${realHome(home)}/${tail})`);
  expect(applyUninstall(planUninstall({ home, env }), { home, env }).ok).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(original);
});

const OPENCODE_USER = {
  $schema: "https://opencode.ai/config.json",
  plugins: ["acme-plugin"],
  permission: { bash: "ask", edit: { "*": "allow", "/srv/secret/*": "deny" } },
};

test("Given OpenCode's global opencode.json with the user's edit rules, When setup runs twice and uninstall runs, Then the guarded paths' deny patterns come after the user's (the last match wins), nothing changes the second time, and the file is restored byte for byte", async () => {
  const { env, home } = sandbox();
  const file = path.join(home, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify(OPENCODE_USER, null, 2) + "\n";
  writeFileSync(file, original);
  expect((await cli(["setup", "--hosts=opencode", "--yes"], env)).code).toBe(0);
  const written = readFileSync(file, "utf8");
  const edit = JSON.parse(written).permission.edit as Record<string, string>;
  expect(Object.keys(edit).slice(0, 2)).toEqual(["*", "/srv/secret/*"]);
  expect(edit["*"]).toBe("allow");
  for (const tail of [...guardedTails, "state/approvals/*", ".config/workit/workspaces.json.seal"])
    expect(edit[`${realHome(home)}/${tail}`]).toBe("deny");
  expect(JSON.parse(written).permission.bash).toBe("ask");

  expect((await cli(["setup", "--hosts=opencode", "--yes"], env)).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(written);
  const plan = planUninstall({ home, env });
  expect(plan.hosts.find((h) => h.host === "opencode")!.actions.map((a) => a.kind)).toEqual([
    "edit-json-remove",
    "forget-ownership",
  ]);
  expect(applyUninstall(plan, { home, env }).ok).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(original);
});

test("Given OpenCode configs Workit cannot merge into (permission.edit one action for every path, only an opencode.jsonc), When setup runs, Then each is reported blocked and left byte for byte", async () => {
  const single = sandbox();
  const file = path.join(single.home, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ permission: { edit: "allow" } }, null, 2) + "\n";
  writeFileSync(file, text);
  const run = await cli(["setup", "--hosts=opencode", "--yes"], single.env);
  expect(run.stdout).toContain("permission.edit is one action for every path");
  expect(readFileSync(file, "utf8")).toBe(text);

  const commented = sandbox();
  const jsonc = path.join(commented.home, ".config", "opencode", "opencode.jsonc");
  mkdirSync(path.dirname(jsonc), { recursive: true });
  writeFileSync(jsonc, '{\n  // mine\n  "permission": {}\n}\n');
  const second = await cli(["setup", "--hosts=opencode", "--yes"], commented.env);
  expect(second.stdout).toContain("opencode.jsonc holds the OpenCode config");
  expect(existsSync(path.join(commented.home, ".config", "opencode", "opencode.json"))).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "Given a state dir reached through a symlink, When `workit setup --yes` runs, Then it is blocked with the symlinked dir and the WORKIT_STATE_DIR fix, and neither the host file nor the record is written",
  async () => {
    const { env, home, settings } = sandbox();
    const real = path.join(home, "real-state");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, path.join(home, "state-link"));
    env.WORKIT_STATE_DIR = path.join(home, "state-link");
    const original = JSON.stringify(USER_SETTINGS, null, 2) + "\n";
    writeFileSync(settings, original);

    const run = await cli(["setup", "--hosts=claude-code", "--yes"], env);
    expect(run.code).not.toBe(0);
    const out = run.stdout + run.stderr;
    expect(out).toContain(`${path.join(home, "state-link")} is a symbolic link`);
    expect(out).toContain(`export WORKIT_STATE_DIR=${realpathSync(real)}`);
    expect(out).not.toMatch(/^\s+at /mu);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(path.join(real, "host-permissions.json"))).toBe(false);

    // A plan made before the link appeared is refused at apply, the same way.
    const plan = planHostPermissions({
      home,
      env: { ...env, WORKIT_STATE_DIR: real },
      hosts: ["claude-code"],
    });
    expect(plan.refused).toBeUndefined();
    const applied = applyHostPermissions(plan, { home, env });
    expect(applied[0].status).toBe("failed");
    expect(applied[0].detail).toContain("is a symbolic link");
    expect(readFileSync(settings, "utf8")).toBe(original);
  },
);

test("Given a home whose path holds parentheses, When setup writes Claude Code's rules, Then each parenthesis is spelled [(] or [)] and Cursor's rule keeps it as is", async () => {
  const { env, home } = sandbox();
  const odd = path.join(home, "Work (x86)");
  mkdirSync(path.join(odd, ".claude"), { recursive: true });
  mkdirSync(path.join(odd, ".cursor"), { recursive: true });
  const oddEnv = { ...env, HOME: odd, WORKIT_STATE_DIR: path.join(odd, "state") };
  expect((await cli(["setup", "--hosts=claude-code,cursor", "--yes"], oddEnv)).code).toBe(0);
  const root = realHome(odd);
  const claude = JSON.parse(readFileSync(path.join(odd, ".claude", "settings.json"), "utf8"));
  expect(claude.permissions.deny).toContain(
    `Edit(//${root.replace(/^\/+/u, "").replace("(x86)", "[(]x86[)]")}/state/issued*)`,
  );
  const cursor = JSON.parse(readFileSync(path.join(odd, ".cursor", "cli-config.json"), "utf8"));
  expect(cursor.permissions.deny).toContain(`Write(${root}/state/issued*)`);
});
