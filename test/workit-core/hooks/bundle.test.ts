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
// replaces whole-record snapshots and recovery copies. The raw-git steering
// and ledger hash chain left the Codex bundle at ~660 KB; skill nudges (the
// trigger table, skill.loaded rows) add ~5 KB; the core's change-only per-turn
// context (lifted out of the Claude plugin for Codex) adds ~1.5 KB; stop
// control (stop.ts plus the endpoint resolution in autonomy.ts) adds ~6 KB
// (Cursor ~678 KB), so the ceiling was 682 KB. Task attribution across
// branches (#264, #267: base resolution, inherited decisions, the core worker
// retry hint) adds ~5 KB; raw branch-policy checks on every shell form, git-flow
// routes, the raw-push new-name, tag and --mirror checks and per-preset
// guidance (#266) add ~10 KB; real session identity (#276) adds the issued-id
// registry. Measured Cursor ~692 KB, so the ceiling is 696 KB; lazy
// schemas (#273) should win it back. Closing the raw-git and forge-API deny
// bypasses (#281: aliases, eval/xargs/brace bodies, pwsh, forge API merges,
// remote and refspec resolution, tokenizing every command) adds ~18 KB
// (Cursor ~710 KB); bounded shell analysis and the review's bypass closures
// add ~6 KB (Cursor ~716 KB); the ledger's verdict-gate trust checks and
// issued-id tokens (#289) add ~6 KB (Cursor ~722.5 KB); the live-session
// guard (#274) with its review fixes adds ~8.5 KB (Cursor ~731 KB), so the
// ceiling was 732 KB. The heavy-command gate (#325: catalog, wrappers,
// patterns, host permission rules, see-through gates) adds ~21 KB (Cursor
// ~751.9 KB), so the ceiling was 753 KB. Standing-order deltas for running
// workers (#320: hooks/standing.ts, the revision signal) add ~4.2 KB to every
// hook entry. Every size above was measured with a local Bun older than the
// pinned one; the pinned Bun (package.json packageManager, CI's BUN_VERSION)
// minifies the same graph to ~477-497 KB (Cursor 496,734 B after #320), so the
// ceiling was 500 KB, measured with that Bun (Cursor 499,796 B at v8.22.1).
// Dropping the eager z.compile() of the operation schemas (#273: parseOperation
// re-parsed with the canonical schema anyway) removes zod's compiler (~30 KB)
// and ~28 ms of codegen from every runtime hook start: Cursor 469,397 B, Codex
// 465,763 B, core run 465,299 B, Claude Code 449,479 B. The ceiling is that max
// plus ~40 KB of headroom for wave 1.5 (#388), rounded to 510 KB. Implementer
// worktree confinement (#310) adds ~10.5 KB: Cursor 479,926 B, Codex 476,292 B,
// core run 475,828 B, Claude Code 460,007 B. Wave 1.5 left Cursor at 509,968 B.
// Host bundles then took only their own adapter (hooks/process.ts) and hooks
// read task context through core/task-view.ts instead of the recording engine
// (task-engine.ts): Cursor 494,579 B, Codex 429,657 B, core run 442,143 B,
// Claude Code 430,370 B. The test prints each size and its headroom. Another
// Bun gives different sizes, so the size check runs only on the pinned version.
const BUDGET = 510_000;
const PINNED_BUN = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { packageManager?: string }
).packageManager?.replace(/^bun@/, "");
const sizeCheckApplies = Bun.version === PINNED_BUN;
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
      const size = statSync(outfile).size;
      // Printed so a PR sees how much room its hook change leaves.
      console.log(
        `hook bundle ${entry}: ${size} B, ${BUDGET - size} B under ${BUDGET} (Bun ${Bun.version}${sizeCheckApplies ? "" : `, unpinned; the budget applies on ${PINNED_BUN}`})`,
      );
      if (sizeCheckApplies) expect(size, entry).toBeLessThanOrEqual(BUDGET);
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
// call. The entry answers the calls that cannot matter (shell commands with
// no git/gh/glab and no heavy word (core/heavy-words.ts),
// PostToolUse without a commit) before the runtime chunk loads, so
// it must stay a few hundred bytes; the runtime still answers the rest.
test("the Codex hook entry stays tiny and loads the runtime only for git/gh/glab and maybe-heavy commands", () => {
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
    expect(run({ hook_event_name: "PreToolUse", tool_input: { command: "ls -la" } })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse" },
    });
    expect(
      run({ hook_event_name: "PreToolUse", tool_input: { command: "gh pr merge 3" } }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
