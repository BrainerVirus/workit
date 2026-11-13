// #780 on OpenCode's own shell path: its permission hook (v2/permissions.ts)
// denies a raw `ytrack` write, plain or wrapped, naming the `workit youtrack …`
// call, including after execute.before rewrote an npx workit call; reads and
// `youtrack.writes: auto` keep the host's own decision.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { observeShellBefore, type ShellWorkdirs } from "@/packages/workit-opencode/src/v2/shell";
import { useConfigHome } from "../shared/grant-home";

const base = mkdtempSync(path.join(os.tmpdir(), "workit-v2-ytrack-"));
const root = path.join(base, "repo");
const config = path.join(base, "config");
const bin = path.join(base, "bin");
for (const dir of [path.join(root, ".git"), config, bin]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const KEYS = ["PATH", "WORKIT_STATE_DIR", "WORKIT_CONFIG_DIR"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
  process.env.WORKIT_CONFIG_DIR = config;
  rmSync(path.join(config, "workspaces.json"), { force: true });
});
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** execute.before, then the permission hook on the command it leaves, as OpenCode runs them. */
const permission = (command: string, effect = "allow") => {
  const workdirs: ShellWorkdirs = new Map();
  const call = { tool: "shell", sessionID: "ses_1", id: "call_1", input: { command } };
  observeShellBefore(root, call, workdirs);
  const event = {
    sessionID: "ses_1",
    action: "shell",
    resources: [call.input.command],
    effect,
    message: undefined as string | undefined,
  };
  evaluateShellPermission(root, event, workdirs);
  return event;
};

test("G OpenCode and the default ask, W a raw ytrack write plain, wrapped or respelled, T the permission hook denies naming the workit call", () => {
  for (const command of [
    "ytrack issue comment X-1 --body hi",
    "bash -c 'ytrack issue comment X-1 --body hi'",
    "npx ytrack issue comment X-1 --body hi",
    "/opt/bin/ytrack issue comment X-1 --body hi",
    "npx -y @workit-dev/cli check --name yt -- ytrack issue comment X-1 --body hi",
  ])
    for (const effect of ["allow", "ask"]) {
      const event = permission(command, effect);
      expect(event.effect, `${effect}: ${command}`).toBe("deny");
      expect(event.message, command).toContain("`workit youtrack note X-1 --markdown hi`");
    }
  const api = permission("ytrack api /issues/X-1 --method=DELETE");
  expect(api.effect).toBe("deny");
  expect(api.message).toContain("in their own terminal");
  // Not a plain command (a host override, a command before the call): handed to the user.
  for (const command of [
    "cd /tmp && ytrack issue comment X-1 --body hi",
    "echo hi | ytrack issue comment X-1 --body hi",
  ]) {
    const out = permission(command);
    expect(out.effect, command).toBe("deny");
    expect(out.message, command).not.toContain("`workit youtrack");
  }
  const host = permission("YTRACK_HOST=acme ytrack issue comment X-1 --body hi");
  expect(host.effect).toBe("deny");
  expect(host.message).toContain("in their own terminal");
  expect(host.message).not.toContain("`workit youtrack");
});

test("G OpenCode, W ytrack reads, or writes with youtrack.writes auto, T the host's own decision stands", () => {
  for (const command of ["ytrack issue view X-1", "ytrack api /users/me --fields login"])
    expect(permission(command).effect, command).toBe("allow");
  // Only the account's own, sealed file gives auto (#819): a temp account home, no redirect.
  const home = useConfigHome("wk-v2-ytrack-config-");
  try {
    process.env.WORKIT_CONFIG_DIR = home.configDir;
    writeFileSync(
      path.join(home.configDir, "workspaces.json"),
      `${JSON.stringify({
        workspaces: [
          { name: "yt", glob: `${root.replaceAll("\\", "/")}/**`, youtrack: { writes: "auto" } },
        ],
      })}\n`,
    );
    expect(permission("ytrack issue comment X-1 --body hi").effect).toBe("allow");
  } finally {
    home.restore();
  }
});
