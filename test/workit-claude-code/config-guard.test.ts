// The launcher's fast paths answer `{}` before the runtime loads. An Edit,
// Write or shell write to the config dir's workspaces.json must reach the
// runtime, whose write gate denies it, even in a repo with no task store.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-config-guard-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: path.join(base, "state"),
  XDG_CONFIG_HOME: undefined,
  WORKIT_CONFIG: undefined,
  WORKIT_CONFIG_DIR: undefined,
};

const payload = (toolName: string, toolInput: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  session_id: "11111111-2222-3333-4444-555555555555",
  transcript_path: "/tmp/x.jsonl",
  cwd: repo,
  permission_mode: "default",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: "toolu_config",
});

type Output = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
const decide = (toolName: string, toolInput: Record<string, unknown>, extra = {}) => {
  const run = runHook(PLUGIN_DIR, payload(toolName, toolInput), { ...env, ...extra });
  expect(run.status, run.stderr).toBe(0);
  return (run.json as Output).hookSpecificOutput;
};

test("Given a repo with no task store, When an Edit, Write or shell write targets the config file, Then the launcher sends it to the runtime, which denies it", () => {
  const forms = [
    { extra: {}, dir: path.join(base, ".config", "workit") },
    { extra: { XDG_CONFIG_HOME: path.join(base, "xdg") }, dir: path.join(base, "xdg", "workit") },
    { extra: { WORKIT_CONFIG: path.join(base, "wc") }, dir: path.join(base, "wc") },
  ];
  for (const { extra, dir } of forms) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "workspaces.json");
    for (const tool of ["Edit", "Write"]) {
      const out = decide(tool, { file_path: file, content: "{}" }, extra);
      expect(out?.permissionDecision, `${tool} ${file}`).toBe("deny");
      expect(out?.permissionDecisionReason).toContain("workit grant set <ws>");
    }
    expect(decide("Bash", { command: `cp /tmp/x.json ${dir}/` }, extra)?.permissionDecision).toBe(
      "deny",
    );
  }
  expect(
    decide("Bash", { command: "echo '{}' > ~/.config/workit/workspaces.json" })?.permissionDecision,
  ).toBe("deny");
  expect(decide("Write", { file_path: path.join(repo, "a.ts"), content: "x" })).toBeUndefined();
  expect(decide("Bash", { command: `cat ${base}/.config/workit/workspaces.json` })).toBeUndefined();
}, 60_000);
