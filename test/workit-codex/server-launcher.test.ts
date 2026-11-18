// #328: the Codex hook entry's quiet path answers before the runtime loads for
// commands that cannot matter; a dev server must reach the gate (denied naming
// the exact `workit run --bg` call), and a pending RSS notice for the session
// must load the runtime once. Both entries: the source launcher under bun and
// the split dist entry under node.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noticeFile } from "@/packages/workit-core/src/core/procs";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const dirs: string[] = [];
let dist: string;
let env: NodeJS.ProcessEnv;
let root: string;

beforeAll(() => {
  const out = mkdtempSync(path.join(tmpdir(), "wk-codex-server-dist-"));
  const bin = mkdtempSync(path.join(tmpdir(), "wk-codex-server-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "wk-codex-server-home-"));
  root = mkdtempSync(path.join(tmpdir(), "wk-codex-server-repo-"));
  dirs.push(out, bin, home, root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  const built = spawnSync(
    process.execPath,
    [
      "build",
      LAUNCHER,
      "--splitting",
      "--outdir",
      out,
      "--entry-naming",
      "workit-hook.js",
      "--chunk-naming",
      "workit-hook-[hash].js",
      "--target",
      "node",
      "--format",
      "esm",
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
  dist = path.join(out, "workit-hook.js");
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    WORKIT_STATE_DIR: path.join(home, "state"),
  };
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const run = (entry: "source" | "dist", command: string, extra: Record<string, unknown> = {}) => {
  const payload = JSON.stringify({
    ...extra,
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
  });
  const child =
    entry === "source"
      ? spawnSync(process.execPath, [LAUNCHER], {
          input: payload,
          encoding: "utf8",
          env,
        })
      : spawnSync("node", [dist], { input: payload, encoding: "utf8", env });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    hookSpecificOutput: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
      additionalContext?: string;
    };
  };
};

for (const entry of ["source", "dist"] as const)
  test(`[${entry}] Given ng serve and npm run dev, When the Codex hook runs, Then each is denied naming the exact workit run --bg call`, () => {
    for (const command of ["ng serve --port 4200", "npm run dev"]) {
      const output = run(entry, command).hookSpecificOutput;
      expect(output.permissionDecision, command).toBe("deny");
      expect(output.permissionDecisionReason).toContain(
        `owned by this session: workit run --bg -- ${command} (`,
      );
    }
  }, 60_000);

for (const entry of ["source", "dist"] as const)
  test(`[${entry}] Given an RSS notice for the session, When a light command runs, Then the hook loads the runtime and delivers it once; the next call is quiet`, () => {
    const file = noticeFile(env, "session-1");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        session: "session-1",
        notices: [
          {
            id: "p1abc",
            cmd: "npm run dev",
            cwd: root,
            rssBytes: 3221225472,
            ceilingBytes: 2147483648,
            restart: "workit run --bg --restart p1abc",
            at: "2026-11-18T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(run(entry, "ls -la").hookSpecificOutput.additionalContext).toContain(
      "`workit run --bg --restart p1abc`",
    );
    expect(existsSync(file)).toBe(false);
    expect(run(entry, "ls -la")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
  }, 60_000);
