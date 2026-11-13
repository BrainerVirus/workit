// Round 2 item 5 through the built Codex hook entry: in a repo with no Workit
// task store, every writer verb or file redirect, and any text that may run a
// user-only Workit call, loads the runtime; reads, fd duplications and
// `>/dev/null` answer on the quiet path.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = mkdtempSync(path.join(tmpdir(), "wk-codex-reach-"));
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

/** The built entry with its runtime and failure chunks removed: only the quiet path answers. */
const quietOnly = (): string => {
  const out = path.join(base, "dist-build");
  const built = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dir, "../../packages/workit-codex/scripts/build.ts"), out],
    { encoding: "utf8", timeout: 300_000 },
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

test("G a repo with no task store, W Codex runs a write, a read or a user-only call, T a write and a user-only call load the runtime, a read stays quiet", () => {
  const entry = quietOnly();
  const quiet = (tool_name: string, command: string) => {
    const child = spawnSync("node", [entry], {
      input: JSON.stringify({
        session_id: "session-1",
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: { command },
      }),
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    return (
      child.status === 0 &&
      child.stdout.trim() === '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}'
    );
  };
  expect(quiet("apply_patch", "*** Begin Patch\n*** End Patch"), "apply_patch").toBe(false);
  for (const command of [
    "mkdir out",
    "rm -f a.txt",
    "cp a.txt b.txt",
    "echo x | tee a.txt",
    "sed -i s/a/b/ a.txt",
    "echo x > a.txt",
    "echo x >> a.txt",
    "ls 2>&1 > a.txt",
    "python3 gen.py",
    "node gen.mjs",
    "workit setup --yes",
    "env -u CLAUDECODE workit setup --yes",
    "AI_AGENT=1 workit uninstall --yes",
    "workit --json workspace seal",
  ])
    expect(quiet("bash", command), command).toBe(false);
  for (const command of [
    "ls",
    "cat a.txt",
    "rg needle src",
    "ls 2>&1 | tail -5",
    "ls >/dev/null",
    "ls > /dev/null 2>&1",
    "ls >&2",
    "workit task status",
  ])
    expect(quiet("bash", command), command).toBe(true);
}, 400_000);
