import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const HOOK_ENTRIES = [
  "packages/workit-codex/hooks/workit-hook.ts",
  "packages/workit-cursor/hooks/workit-hook.ts",
  "packages/workit-core/src/hooks/run.ts",
  "packages/workit-claude-code/src/hook.ts",
];
// Minified bytes. The design target is 300 KB; today's floor is the task
// engine plus zod that compact task context needs (~585 KB), so this pins the
// current size as a regression ceiling until that graph is split. S9b raised
// it by 10 KB: close gates now evaluate CLI-observed checks (worktree tree key
// from git/rev.ts, named-check config from check-config.ts). S15 raised it by
// 20 KB: the append-only task event store (store/: log, patch, reduce, paths)
// replaces whole-record snapshots and recovery copies.
const BUDGET = 650_000;
const FORBIDDEN = /\/(doctor|setup|setup-state|uninstall|host-install|init)\.ts$|\/src\/core\.ts$/;

test("a hook bundle loads no doctor/setup modules or the core barrel, within its size budget", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-hook-bundle-"));
  try {
    for (const [index, entry] of HOOK_ENTRIES.entries()) {
      const metafile = path.join(out, `meta-${index}.json`);
      const outfile = path.join(out, `bundle-${index}.js`);
      const built = spawnSync(
        process.execPath,
        [
          "build",
          path.join(ROOT, entry),
          "--target",
          "node",
          "--minify",
          "--outfile",
          outfile,
          `--metafile=${metafile}`,
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.some((input) => input.includes("workit-core/src/hooks/handle.ts")),
        entry,
      ).toBe(true);
      expect(
        inputs.filter((input) => FORBIDDEN.test(input)),
        entry,
      ).toEqual([]);
      expect(statSync(outfile).size, entry).toBeLessThanOrEqual(BUDGET);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// S18: setup/doctor/upgrade/uninstall/host-install live in the CLI package
// (src/admin), so no host plugin or MCP server may bundle them either.
const PLUGIN_ENTRIES = [
  "packages/workit-opencode/src/index.ts",
  "packages/workit-mcp/src/index.ts",
  "packages/workit-cursor/mcp/run-server.ts",
  "packages/workit-pi/extensions/workit.ts",
  "packages/workit-pi/src/worker.ts",
];
const ADMIN =
  /\/workit-cli\/src\/admin\/|\/(doctor|setup|setup-state|uninstall|host-install|registration|detect-hosts)\.ts$/;

test("a host plugin or MCP bundle loads no setup/doctor/admin modules", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-plugin-bundle-"));
  try {
    for (const [index, entry] of PLUGIN_ENTRIES.entries()) {
      const metafile = path.join(out, `meta-${index}.json`);
      const built = spawnSync(
        process.execPath,
        [
          "build",
          path.join(ROOT, entry),
          "--target",
          "node",
          "--outfile",
          path.join(out, `bundle-${index}.js`),
          `--metafile=${metafile}`,
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.filter((input) => ADMIN.test(input)),
        entry,
      ).toEqual([]);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// Codex runs its hook on every tool call plus PostToolUse after every shell
// call. The entry answers the calls that cannot matter (non-git shell
// commands, PostToolUse without a commit) before the runtime chunk loads, so
// it must stay a few hundred bytes; the runtime still answers the rest.
test("the Codex hook entry stays tiny and loads the runtime only for git/gh/glab commands", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-codex-entry-"));
  try {
    const built = spawnSync(
      process.execPath,
      [path.join(ROOT, "packages/workit-codex/scripts/build.ts"), out],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);
    const entry = path.join(out, "dist", "workit-hook.js");
    expect(statSync(entry).size).toBeLessThanOrEqual(4_096);
    const repo = path.join(out, "repo");
    spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
    mkdirSync(path.join(repo, ".git", "workit"));
    const run = (payload: Record<string, unknown>) =>
      JSON.parse(
        spawnSync("node", [entry], {
          input: JSON.stringify({ session_id: "t-1", cwd: repo, tool_name: "Bash", ...payload }),
          encoding: "utf8",
        }).stdout,
      );
    expect(
      run({ hook_event_name: "PostToolUse", tool_input: { command: "ls" }, tool_response: "" }),
    ).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
    expect(run({ hook_event_name: "PreToolUse", tool_input: { command: "npm test" } })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse" },
    });
    expect(
      run({ hook_event_name: "PreToolUse", tool_input: { command: "gh pr merge 3" } }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
