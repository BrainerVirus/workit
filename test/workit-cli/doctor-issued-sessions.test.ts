// workit doctor `hook_issued_sessions`: a Claude Code or Codex plugin hook
// older than the CLI records no SubagentStart session ids, and every real
// verifier's --session is then refused. The doctor flags it by hook content.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOOK_ISSUED_MARKER,
  runDoctor,
  type DoctorCheck,
} from "@/packages/workit-cli/src/admin/doctor";
import { ISSUED_SESSIONS_MARKER } from "@/packages/workit-core/src/host-session";
import cliPkg from "@/packages/workit-cli/package.json" with { type: "json" };

test("the doctor looks for exactly the marker the hook writes", () => {
  expect(HOOK_ISSUED_MARKER).toBe(ISSUED_SESSIONS_MARKER);
});

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-issued-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

let n = 0;
const freshHome = () => {
  const home = path.join(scratch, `home-${++n}`);
  const cwd = path.join(scratch, `work-${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
};

const issuedCheck = (home: string, cwd: string): DoctorCheck =>
  runDoctor({
    host: "cli",
    cliVersion: cliPkg.version,
    home,
    cwd,
    configDir: path.join(home, "config"),
    stateDir: path.join(home, "state"),
    dev: path.join(home, "no-dev"),
    env: { HOME: home, PATH: emptyBin },
  }).checks.find((c) => c.id === "hook_issued_sessions")!;

const hookSource = (records: boolean) =>
  `#!/usr/bin/env node\n// workit hook\n${records ? `const marker = "${ISSUED_SESSIONS_MARKER}";\n` : ""}`;

/** A Claude Code user-scope Workit plugin install whose hook does or does not record ids. */
const claudeInstall = (home: string, records: boolean) => {
  const root = path.join(home, ".claude", "plugins", "cache", "workit", "workit", "8.9.0");
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "workit", repository: "https://github.com/brainervirus/workit" }),
  );
  writeFileSync(path.join(root, "dist", "workit-hook.js"), hookSource(records));
  writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "workit@workit": [{ installPath: root, version: "8.9.0", scope: "user" }] },
    }),
  );
};

/** An enabled Codex Workit plugin whose hook chunks do or do not record ids. */
const codexInstall = (home: string, records: boolean) => {
  const codexHome = path.join(home, ".codex");
  const root = path.join(codexHome, "plugins", "cache", "workit", "workit", "8.9.0");
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), '{"name":"workit"}');
  writeFileSync(path.join(root, "package.json"), '{"version":"8.9.0"}');
  writeFileSync(path.join(root, "dist", "workit-hook.js"), 'import "./workit-hook-a.js";\n');
  writeFileSync(path.join(root, "dist", "workit-hook-a.js"), hookSource(records));
  writeFileSync(path.join(codexHome, "config.toml"), `[plugins."workit@workit"]\nenabled = true\n`);
};

test("Given no Claude Code or Codex plugin hook, When doctor runs, Then hook_issued_sessions passes as skipped", () => {
  const { home, cwd } = freshHome();
  expect(issuedCheck(home, cwd)).toMatchObject({ status: "pass" });
  expect(issuedCheck(home, cwd).detail).toContain("skipping");
});

test("Given a Claude Code plugin hook older than the CLI, When doctor runs, Then it warns and names the plugin update", () => {
  const { home, cwd } = freshHome();
  claudeInstall(home, false);
  const stale = issuedCheck(home, cwd);
  expect(stale.status).toBe("warn");
  expect(stale.detail).toContain("records no SubagentStart session ids");
  expect(stale.fix).toContain("claude plugin update workit@workit");
  expect(stale.fix).toContain("relaunch the verifier");
  claudeInstall(home, true);
  expect(issuedCheck(home, cwd).status).toBe("pass");
});

test("Given a Codex plugin hook older than the CLI, When doctor runs, Then it warns and names the plugin reinstall; a current hook passes", () => {
  const { home, cwd } = freshHome();
  codexInstall(home, false);
  const stale = issuedCheck(home, cwd);
  expect(stale.status).toBe("warn");
  expect(stale.fix).toContain("codex plugin add workit@workit");
  codexInstall(home, true);
  expect(issuedCheck(home, cwd).status).toBe("pass");
});
