// #780 through the Codex hook entry: it answers quietly, before the runtime
// loads, for shell commands that cannot matter, so a raw `ytrack` write,
// however it is wrapped or spelled, must reach the runtime, which denies it.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAST, POSIX_SHAPES, ROUTED_MENTIONS } from "../workit-core/hooks/ytrack-shapes";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const base = mkdtempSync(path.join(tmpdir(), "wk-codex-ytrack-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const root = path.join(base, "repo");
mkdirSync(home, { recursive: true });
spawnSync("git", ["init", "-q", "-b", "feature/x", root], { timeout: 20_000 });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  WORKIT_STATE_DIR: path.join(base, "state"),
  WORKIT_CONFIG_DIR: path.join(base, "config"),
};

const run = (command: string) => {
  const child = spawnSync(process.execPath, [LAUNCHER], {
    input: JSON.stringify({
      session_id: "session-1",
      cwd: root,
      model: "gpt-5",
      permission_mode: "default",
      transcript_path: null,
      hook_event_name: "PreToolUse",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "bash",
      tool_input: { command },
    }),
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return (
    JSON.parse(child.stdout) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
};

test("G the Codex hook entry, W raw ytrack writes plain, wrapped or respelled, T the runtime denies them; reads stay quiet", () => {
  for (const command of [
    "ytrack issue comment X-1 --body hi",
    "/opt/bin/ytrack issue comment X-1 --body hi",
    'y"t"rack issue comment X-1 --body hi',
  ]) {
    const out = run(command);
    expect(out.permissionDecision, command).toBe("deny");
    expect(out.permissionDecisionReason, command).toContain(
      "`workit youtrack note X-1 --markdown hi`",
    );
  }
  const api = run("ytrack api /issues/X-1 -X DELETE");
  expect(api.permissionDecision).toBe("deny");
  expect(api.permissionDecisionReason).toContain("in their own terminal");
  // Not a plain command (a host override, a command before the call): handed to the user.
  for (const command of [
    "cd /tmp && ytrack issue comment X-1 --body hi",
    "echo hi | ytrack issue comment X-1 --body hi",
  ]) {
    const out = run(command);
    expect(out.permissionDecision, command).toBe("deny");
    expect(out.permissionDecisionReason, command).not.toContain("`workit youtrack");
  }
  const host = run("env YTRACK_HOST=acme ytrack issue comment X-1 --body hi");
  expect(host.permissionDecision).toBe("deny");
  expect(host.permissionDecisionReason).toContain("in their own terminal");
  expect(host.permissionDecisionReason).not.toContain("`workit youtrack");
  for (const command of ["ytrack issue view X-1", "ytrack work-item list X-1", "ls"])
    expect(run(command).permissionDecision, command).toBeUndefined();
}, 60_000);

/**
 * The built entry with its runtime and failure chunks removed: a call that
 * loads the runtime fails, so only the quiet path answers.
 */
const quietOnly = (): string => {
  const out = path.join(base, "dist-build");
  const built = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dir, "../../packages/workit-codex/scripts/build.ts"), out],
    { encoding: "utf8", timeout: 120_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  const dist = path.join(out, "dist");
  for (const file of readdirSync(dist))
    if (
      file !== "workit-hook.js" &&
      /runCodexHook|answerRuntimeFailure/.test(readFileSync(path.join(dist, file), "utf8"))
    )
      rmSync(path.join(dist, file));
  return path.join(dist, "workit-hook.js");
};

test("G the Codex hook entry, W a command only mentions ytrack in a path or an argument, T it answers quietly; every shape the gate decides reaches the runtime", () => {
  const entry = quietOnly();
  const quiet = (command: string) => {
    const child = spawnSync("node", [entry], {
      input: JSON.stringify({
        session_id: "session-1",
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        tool_input: { command },
      }),
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    return (
      child.status === 0 &&
      child.stdout.trim() === '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}'
    );
  };
  expect(quiet("ls")).toBe(true);
  for (const command of FAST) expect(quiet(command), command).toBe(true);
  // The shared test routes a bare mention; the gate then decides nothing.
  for (const command of ROUTED_MENTIONS) {
    expect(quiet(command), command).toBe(false);
    expect(run(command).permissionDecision, command).toBeUndefined();
  }
  for (const command of POSIX_SHAPES) expect(quiet(command), command).toBe(false);
}, 180_000);
