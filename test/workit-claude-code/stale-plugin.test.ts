// A session that loaded an older Workit plugin than the one installed tells
// the agent once, on SessionStart or the first PreToolUse; the fast path stays
// a fast path once it has said so.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installedPlugin, runHook } from "./plugin-helpers";

const base = mkdtempSync(path.join(tmpdir(), "wk-stale-plugin-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A cache-layout copy of the plugin running as `running`, with `installed` in the registry. */
const layout = (name: string, running: string, installed: string) => {
  const config = path.join(base, name, ".claude");
  const versions = path.join(config, "plugins", "cache", "workit", "workit");
  const dir = path.join(versions, running);
  cpSync(installedPlugin(), dir, { recursive: true });
  writeFileSync(
    path.join(config, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "workit@workit": [
          { scope: "user", installPath: path.join(versions, installed), version: installed },
        ],
      },
    }),
  );
  return { dir, env: { WORKFLOW_TOOLKIT_STATE: path.join(base, name, "state") } };
};

const context = (json: unknown): string =>
  String(
    (json as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput
      ?.additionalContext ?? "",
  );

const start = (cwd: string, session: string) => ({
  hook_event_name: "SessionStart",
  session_id: session,
  cwd,
  source: "resume",
});
const bash = (cwd: string, session: string) => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  cwd,
  tool_name: "Bash",
  tool_input: { command: "ls" },
});

test("G the hook runs from 8.26.0 while 8.26.1 is installed, W SessionStart then PreToolUse, T the agent hears it once", () => {
  const { dir, env } = layout("stale-start", "8.26.0", "8.26.1");
  const first = runHook(dir, start(base, "s1"), env);
  expect(first.status).toBe(0);
  expect(context(first.json)).toContain("loaded Workit 8.26.0 but 8.26.1 is installed");
  expect(context(first.json)).toContain("fully quit Claude Code");
  expect(context(first.json)).toContain("not `/resume`");
  // Once per session: the next event and the next tool call say nothing.
  expect(context(runHook(dir, start(base, "s1"), env).json)).not.toContain("8.26.1 is installed");
  expect(context(runHook(dir, bash(base, "s1"), env).json)).toBe("");
});

test("G a stale session that never saw SessionStart, W its first PreToolUse runs, T the line rides it and a later call is the plain fast path", () => {
  const { dir, env } = layout("stale-tool", "8.26.0", "8.26.1");
  const first = runHook(dir, bash(base, "s2"), env);
  expect(context(first.json)).toContain("8.26.1 is installed");
  const second = runHook(dir, bash(base, "s2"), env);
  expect(second.stdout.trim()).toBe("{}");
  // A subagent never repeats it; another session hears it.
  expect(runHook(dir, { ...bash(base, "s3"), agent_id: "a1" }, env).stdout.trim()).toBe("{}");
  expect(context(runHook(dir, bash(base, "s3"), env).json)).toContain("8.26.1 is installed");
});

test("G the running plugin is the installed one, or a local pin, W SessionStart and PreToolUse run, T no restart line and the fast path answers {}", () => {
  const current = layout("current", "8.26.1", "8.26.1");
  expect(context(runHook(current.dir, start(base, "s4"), current.env).json)).not.toContain(
    "installed.",
  );
  expect(runHook(current.dir, bash(base, "s4"), current.env).stdout.trim()).toBe("{}");
  const pin = path.join(base, "pin");
  mkdirSync(pin, { recursive: true });
  cpSync(installedPlugin(), pin, { recursive: true });
  expect(runHook(pin, bash(base, "s5"), current.env).stdout.trim()).toBe("{}");
});
