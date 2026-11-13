// Ruling hook-reach-2026-11-13 through the built Codex hook entry: with no
// Workit task store a plain write inside the repo and a read answer on the
// quiet path (only a write that may reach a guarded path loads the runtime:
// test/workit-core/hooks/write-reach.test.ts); with a store every writer verb
// or file redirect does; apply_patch and any text that may run a user-only
// Workit call always do.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = mkdtempSync(path.join(tmpdir(), "wk-codex-reach-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const plain = path.join(home, "src", "proj", "plain");
const stored = path.join(home, "src", "proj", "stored");
for (const repo of [plain, stored])
  spawnSync("git", ["init", "-q", "-b", "feature/x", repo], { timeout: 20_000 });
mkdirSync(path.join(stored, ".git", "workit", "tasks"), { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  WORKIT_STATE_DIR: path.join(home, ".local", "state", "workit"),
  WORKIT_CONFIG_DIR: path.join(home, ".config", "workit"),
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

const WRITES = (repo: string) => [
  "mkdir out",
  `mkdir -p ${repo}/out`,
  "rm -f a.txt",
  "cp a.txt b.txt",
  "echo x | tee a.txt",
  "echo x > a.txt",
  "echo x >> a.txt",
  `echo x > ${path.join(base, "elsewhere.txt")}`,
  "sed -i s/a/b/ a.txt",
  "ls 2>&1 > a.txt",
  "ls >&2x",
];
const READS = [
  "ls",
  "cat a.txt",
  "find . -name '*.ts'",
  "awk '{print $1}' a.ts",
  "ls 2>&1 | tail -5",
  "ls >/dev/null",
  "ls > /dev/null 2>&1",
  "ls >&2",
  "workit task status",
];

test("G Codex, W a write, a read, apply_patch or a user-only call with or without a task store, T only store writes, apply_patch and user-only calls load the runtime", () => {
  const entry = quietOnly();
  const quiet = (cwd: string, tool_name: string, command: string) => {
    const child = spawnSync("node", [entry], {
      input: JSON.stringify({
        session_id: "session-1",
        cwd,
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
  for (const cwd of [plain, stored])
    expect(quiet(cwd, "apply_patch", "*** Begin Patch\n*** End Patch"), cwd).toBe(false);
  for (const command of [...WRITES(plain), ...READS, "sed -n 1,5p a.ts", "rg '=>' ."])
    expect(quiet(plain, "bash", command), `no store: ${command}`).toBe(true);
  for (const command of WRITES(stored))
    expect(quiet(stored, "bash", command), `store: ${command}`).toBe(false);
  for (const command of READS)
    expect(quiet(stored, "bash", command), `store: ${command}`).toBe(true);
  for (const command of [
    "workit setup --yes",
    "env -u CLAUDECODE workit setup --yes",
    "AI_AGENT=1 workit uninstall --yes",
    "workit --json workspace seal",
    "workit gr\\\nant set a b=c",
    "work\\\nit setup --yes",
    "workit s$'e'tup --yes",
  ])
    expect(quiet(plain, "bash", command), command).toBe(false);
}, 400_000);
