import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import {
  applyHostPermissions,
  planHostPermissions,
} from "@/packages/workit-cli/src/admin/host-permissions";

// #820: `native_deny` says per host whether the deny rules for the guarded
// paths (<state>/issued*, <state>/approvals/, the account config's
// workspaces.json and its seal) are present, missing or stale, and what the
// host's OS sandbox is set to. Fixture homes only: no real host dir is read.

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-native-deny-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// `opencode --version` (the opencode_version row) creates ~/.config/opencode in
// the fixture home, which would make OpenCode look installed: keep it off PATH.
const PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => !["opencode", "opencode.exe"].some((bin) => existsSync(path.join(dir, bin))))
  .join(path.delimiter);

const fixture = (name: string) => {
  const home = path.join(base, name);
  mkdirSync(home, { recursive: true });
  const stateDir = path.join(home, ".local", "state", "workit");
  const env: NodeJS.ProcessEnv = { PATH, HOME: home, WORKIT_STATE_DIR: stateDir };
  const doctor = (): DoctorCheck =>
    runDoctor({
      host: "cli",
      home,
      cwd: home,
      workspaceRoot: home,
      configDir: path.join(home, ".config", "workit"),
      stateDir,
      env,
      only: "upgrade",
    }).checks.find((check) => check.id === "native_deny")!;
  const setup = (hosts: string[]) =>
    applyHostPermissions(planHostPermissions({ home, env, hosts }), { home, env });
  const claudeSettings = path.join(home, ".claude", "settings.json");
  return { home, env, stateDir, doctor, setup, claudeSettings };
};

test("G Claude Code with Workit's block and its sandbox on, W doctor runs, T native_deny passes and reports the sandbox", () => {
  const f = fixture("claude-present");
  mkdirSync(path.dirname(f.claudeSettings), { recursive: true });
  writeFileSync(f.claudeSettings, JSON.stringify({ sandbox: { enabled: true } }));
  expect(f.setup(["claude-code"])[0].status).toBe("written");
  const row = f.doctor();
  expect(row.status).toBe("pass");
  expect(row.detail).toBe("claude-code: present (sandbox on)");
});

test("G Workit's Claude Code block whose deny rule for the seal was removed, W doctor runs, T native_deny warns missing with the setup command", () => {
  const f = fixture("claude-missing");
  mkdirSync(path.dirname(f.claudeSettings), { recursive: true });
  f.setup(["claude-code"]);
  const value = JSON.parse(readFileSync(f.claudeSettings, "utf8"));
  value.permissions.deny = value.permissions.deny.filter(
    (rule: string) => !rule.endsWith(".seal)"),
  );
  writeFileSync(f.claudeSettings, JSON.stringify(value));
  const row = f.doctor();
  expect(row.status).toBe("warn");
  expect(row.detail).toMatch(
    /^claude-code: missing 1 \(Edit\(\/\/.+\/workspaces\.json\.seal\)\) \(sandbox off\)$/u,
  );
  expect(row.fix).toBe("workit setup --hosts=claude-code");
});

test("G a host the user never ran setup for, W doctor runs, T native_deny is info with the setup command, not a warning", () => {
  const f = fixture("cursor-never");
  mkdirSync(path.join(f.home, ".cursor"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".cursor", "cli-config.json"),
    JSON.stringify({ sandbox: { mode: "enabled" } }),
  );
  const row = f.doctor();
  expect(row.status).toBe("info");
  expect(row.detail).toMatch(
    /^cursor: missing 5 \(Write\(.+\/issued\*\), …\) \(sandbox\.mode enabled\)$/u,
  );
  expect(row.fix).toBe("workit setup --hosts=cursor");
});

test("G an OpenCode deny pattern Workit recorded writing for a path that moved, W doctor runs, T native_deny warns stale naming it", () => {
  const f = fixture("opencode-stale");
  const config = path.join(f.home, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(config), { recursive: true });
  f.setup(["opencode"]);
  const old = "/old/home/.local/state/workit/issued*";
  const value = JSON.parse(readFileSync(config, "utf8"));
  value.permission.edit[old] = "deny";
  value.permission.edit["/srv/mine/approvals/*"] = "deny";
  writeFileSync(config, JSON.stringify(value));
  const record = path.join(f.stateDir, "host-permissions.json");
  const owned = JSON.parse(readFileSync(record, "utf8"));
  owned.hosts.opencode.owned.lists["permission.edit"].push(old);
  writeFileSync(record, JSON.stringify(owned));
  const row = f.doctor();
  expect(row.status).toBe("warn");
  expect(row.detail).toBe(`opencode: stale (${old} names a path that moved)`);
  expect(row.fix).toBe("workit setup --hosts=opencode");
});

test("G Codex whose sandbox lets commands write the state dir, and Pi, W doctor runs, T native_deny reports Codex's sandbox mode with the risk and Pi's missing permission layer", () => {
  const f = fixture("codex-pi");
  mkdirSync(path.join(f.home, ".codex"), { recursive: true });
  mkdirSync(path.join(f.home, ".pi"), { recursive: true });
  const local = path.join(realpathSync(f.home), ".local");
  writeFileSync(
    path.join(f.home, ".codex", "config.toml"),
    `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ["/tmp/x", "${local}"]\n`,
  );
  const row = f.doctor();
  expect(row.status).toBe("warn");
  expect(row.detail).toContain(
    `codex: no path deny rule (sandbox_mode "workspace-write"; writable_roots in ${path.join(f.home, ".codex", "config.toml")} holds ${local}, which holds a guarded path)`,
  );
  expect(row.detail).toContain("pi: no permission layer");
  expect(row.fix).toContain("codex: writable_roots in");

  const safe = fixture("codex-safe");
  mkdirSync(path.join(safe.home, ".codex"), { recursive: true });
  writeFileSync(path.join(safe.home, ".codex", "config.toml"), `model = "x"\n`);
  const quiet = safe.doctor();
  expect(quiet.status).toBe("pass");
  expect(quiet.detail).toBe(
    "codex: no path deny rule (sandbox_mode not set (Codex picks one per project trust))",
  );
});
