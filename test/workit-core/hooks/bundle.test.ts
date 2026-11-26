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
// Confinement following shell variables, loops and inline-script paths (#744) adds
// ~4.5 KB of its own code, no new module: core run 511,558 B, so the ceiling is 512 KB.
// temporary: #744+#748; the read-only TaskStore split for hooks (retro 2026-11-07
// follow-up) lowers it. Confinement of IFS, untrusted cd and curl's write options (#787) takes core run to 517,577 B.
// Judge scratch confinement (#790: stdin-fed scripts, eval, the judge verb table, wget/tar/
// unzip/mkfifo and git output writers, workit wrappers and entries) takes core run to ~526 KB, so the ceiling is 528 KB.
// Wave 7 (#792 items 23/26/27/28, approvals core per docs/workit-next/host-approval.md): each slice
// trims first; together they need ~8 KB more, so the ceiling is 540 KB. The read-only TaskStore
// split (#807, 2026-11-11): hooks read through TaskReader (core/task-read.ts) and never load the
// write side (core/task-store.ts: appends, binding, compaction, 2.x migration). Core run went
// from 537,270 B to 511,615 B (Claude Code 505,078 B, Cursor 499,833 B, Codex 499,445 B), so the
// ceiling is that baseline plus 12 KB for the rest of wave 7.5. 2026-11-12: the registry
// guard (#818), the account home (#826) and the raw-ytrack ask (#780, hooks/ytrack-guard.ts,
// +3,911 B on core run) added code after that split: core run 527,047 B, Claude Code 520,510 B,
// Cursor 516,096 B, Codex 515,708 B, so the ceiling was core run plus 2,000 B. Its fix round
// (verdict mwdbd0km: --help, aliases, nesting, faithful mapping, respellings) adds 2,996 B:
// core run 530,043 B, Claude Code 523,506 B, Cursor 519,092 B, Codex 518,704 B; the ceiling is
// core run plus 2,000 B. The one-approval `workit youtrack update` routing (chained writes on one
// issue joined into one call) adds 3,974 B: core run 536,017 B; the ceiling is core run plus 2,000 B.
// Wave 8 round 2 (2026-11-13), measured on Bun 1.4.4 at #834: core run 536,017 B, Claude Code
// 529,486 B, Cursor 525,072 B, Codex 524,684 B. One ceiling for the round, core run plus 6,000 B:
// hook-reach, grant-seal-core and grant-seal-cli may spend it, each printing its delta in its PR.
// Wave 9 (2026-11-13), measured on Bun 1.4.4 at #855: round 2's grant seal (#841, #851), hook reach (#845) and the
// write-gate gaps (#855) took core run to 541,650 B (Claude Code 535,119 B, Cursor 530,705 B, Codex 530,317 B).
// One ceiling for the rest of wave 9, core run plus 8,000 B: procs-route (dev-server routing, the RSS notice) and
// session-teardown (the session-end stop) may spend it, each printing its delta in its PR.
// #864 judge-scratch (2026-11-13): confining a judge's git (verifiers and reviewers) to an allowlist
// of verbs with per-verb option tables, wrappers and environment, plus git-dir and config checks
// for scratch repositories, took core run to 557,693 B. The ceiling is that plus ~2,000 B, since
// ap-core's one-click approvals land next on the same bundle.
// #864 ap-core (2026-11-13), rebased on judge-scratch: the inline ask on the action (youtrack
// request rendering, ticket binding, replay and write-content checks on every host) took core run
// to 564,108 B. The ceiling is that plus ~2,400 B. procs-route and session-teardown, which the
// wave 9 ceiling above left room for, print their own delta and raise it in their PRs.
// Wave 11 confine-reads (retro 2026-11-17 C1+C2): read-only inline scripts, a plain fetch, the
// session scratchpad and the read-only judge verbs, with review round 1's fail-closed rules (verdict
// mwla51qs), add +1,904 B. Rebased on #871 (release-notes one-click ask, 2026-11-17) the core run
// is 567,733 B, so the ceiling is that plus ~1,500 B; the precision follow-up must be byte-neutral.
// Wave 12 (2026-11-18), measured on Bun 1.4.4 at bc1d174b: core run 568,259 B (Claude Code 561,652 B,
// Cursor 551,053 B, Codex 550,665 B). One ceiling for the round, core run plus 10,000 B, so no hook
// slice edits it: procs-route and session-teardown 8,000 B together (wave 9's allowance, still
// unspent), ft-spawn-models + ft-spawn-gate + ft-confine 2,000 B together. Each prints its delta in its PR.
// Wave 12's spenders (2026-11-18, Bun 1.4.4, rebased on #899): ft-spawn-models (+694 B) and
// session-teardown (+4,460 B: the session-end stop and session-start reap, hooks/teardown.ts)
// took core run to 578,817 B. The ceiling is that plus 2,000 B.
// trunk-ci-wait (#912, the exit-pipe deny) took core run to 582,564 B (after its fix round); the ceiling is that plus 2 KiB.
// dep-bump-lane (#891: the workflow YAML reader and the manifest pin reader the lane loads)
// took core run to 595,869 B, its first fix round to 597,461 B, and the allow-list append
// grammar (on top of #915) to 600,499 B; the ceiling is that plus 2 KiB.
// YouTrack autoHosts (2026-11-21, Bun 1.4.4, measured at 5a97f1bf after #925 and #927): core run
// 602,293 B. One ceiling for the scoped youtrack auto writes change, core run plus 6 KiB: the
// raw-ytrack guard's --host allow-list and the seal's autoHosts key may spend it, printing the delta in their PR.
// state-outside-repo (#892, 2026-11-25, Bun 1.4.5): a non-git folder's store in the state dir and
// the one-time move of an older <folder>/.workit (store/folder-store.ts) took core run to 609,547 B,
// the ceiling is that plus 2 KiB; its test-run guard (testRunFolderRefusal) then took it to 610,282 B.
// Rebased on #950 (raw-git push URLs, 20 B under the old ceiling) with the move's hardening (an atomic
// copy fallback and the O_EXCL move lock), core run is 613,067 B: #892 adds 4,650 B over #950's 608,417 B.
// Nothing trims without dropping the move's safety (resolveStore runs in every hook, so the move ships
// in the hook bundle); one ceiling for both changes, that plus 2 KiB.
// hook-slim (2026-11-25, Bun 1.4.5, at 33b0d00b): the hook-loaded schemas (workspaces, task contract,
// store lock) moved from classic zod to zod/mini (core/zod-mini.ts), so classic's schema classes and the
// JSON Schema emitter they import leave every hook bundle, and the operation request schemas, built at
// load, moved from task-contract.ts to core/operations.ts, which no hook loads. Core run 613,480 B ->
// 553,461 B (Claude Code 606,835 -> 546,812, Codex 595,155 -> 535,135, Cursor 594,549 -> 534,529);
// the ceiling is core run plus 2 KiB. A hook bundle must not load classic zod again (FORBIDDEN below).
// set-verdict (#955, 2026-11-25, Bun 1.4.5, rebased on 55c42828): the ledger guard (the verdict store,
// repository and folder ledgers, the Windows unquoted check), the Stop hook's pr.gate read, the
// sealed additiveRiskPaths schema key and the effectful-append deny-list take core run from 553,461 B
// to 554,496 B (+1,035 B; Claude Code 547,847 B, Codex 536,170 B, Cursor 535,564 B). The ceiling is
// core run plus 2 KiB; whichever of #955 and #956 merges second reconciles it.
// guard residuals (#891 review, 2026-11-26, Bun 1.4.5, on a3dafa5a): the link and mount source check,
// ledgers under a git common dir not named .git, and the Stop hook's pr.gate retirement (gateStands)
// and the Windows link forms (`mklink`, `New-Item -ItemType SymbolicLink`, unquoted `C:\` sources),
// `install -l` and `rsync --link-dest` take core run from 554,496 B to 557,329 B (+2,833 B; Claude
// Code 550,682 B, Codex 539,005 B, Cursor 538,399 B). The ceiling is core run plus 2 KiB; whichever
// of this and #956 merges second reconciles it.
// compound cmd /c (#891, 2026-11-26, Bun 1.4.5): `cmd /c` and `pwsh -c` scripts read statement by
// statement, and `xargs`/`parallel` fed a guarded path on stdin, take core run from 557,329 B to
// 558,062 B (+733 B; Claude Code 551,414 B, Codex 539,737 B, Cursor 539,131 B). The ceiling is core
// run plus 2 KiB; whichever of this and #956 merges second reconciles it.
// #880 confine-reads (2026-11-25, Bun 1.4.5, rebased on hook-slim at 55c42828): reading inline code
// left to right (comments, strings, f-strings, template and regex literals as tokens) and the escapes
// it closes (`--eval=`, `-mpip`, NODE_OPTIONS, `NAME+=value`, a shell's heredoc, env's words and
// options, a call on a returned value, Reflect…) take core run from 553,461 B to 555,145 B (+1,684 B).
// #955 also spends on hook-slim's 2 KiB, so the ceiling is core run plus 2 KiB.
// #956 round 3 (2026-11-26, Bun 1.4.5): inline code imports only the modules Workit reads (tables of
// whole and members-only modules, bindings used as name.member, ambient globals and private members,
// Node's module globals), transparent and opaque wrappers, awk/sed/deno/tsx and the judge's refusal
// reason. Rebased on #961 (core run 558,062 B), #880 and #956 together take core run to 566,224 B
// (+8,162 B; SPAWNS lost the names the tables now cover). The ceiling is core run plus 2 KiB.
// #880 opaque scripts (2026-11-26, Bun 1.4.5, on 880adbda): a `pwsh -File` script, an encoded
// command, `iex`, a cmd `%VAR%` target and an xargs command named by stdin count as writers; core
// run 566,224 B -> 566,995 B (+771 B; Claude Code 560,345 B, Codex 548,658 B, Cursor 548,052 B).
// The ceiling is core run plus 2 KiB. Link paths (`mklink`, `New-Item -Path:x`, `ln -st`, a
// one-operand `ln`) as write targets then take core run to 567,412 B (+417 B; Claude Code 560,762 B,
// Codex 549,075 B, Cursor 548,469 B); the ceiling is that plus 2 KiB.
// #880 Windows read allowlists (2026-11-26, Bun 1.4.5, on 5f8e4826): a PowerShell or cmd statement
// passes only as a known read (windows-reads.ts: the alias table, the read verbs and cmdlets, the
// text checks), and glued encoded commands, stdin scripts, `xargs -J` and `find -exec {}` count as
// writers; with raw-git reading BSD `xargs -J`/`-R`, the pwsh parameter table, static members on
// any receiver, loader environments and cmd-variable command words, core run 567,412 B ->
// 576,814 B (+9,402 B; Claude Code 570,170 B, Codex 558,493 B, Cursor 557,887 B). The ceiling is
// core run plus 2 KiB; whichever of this and #966 merges second reconciles it.
// #967 residuals (2026-11-26, Bun 1.4.5): more loader names (askpass, cargo and rustc wrappers, the
// JVM's and .NET's startup options, Bun, npm config, search paths, PROMPT_COMMAND), `pwsh -wd` as a
// location change, a judge's git behind a non-loader assignment and names in any case take core run from 576,814 B to
// 577,529 B (+715 B; Claude Code 570,885 B, Codex 559,208 B, Cursor 558,602 B). The ceiling is core
// run plus 2 KiB; whichever of this and #966 merges second reconciles it.
// schema-desc (#962, 2026-11-26, Bun 1.4.5, rebased on ab39f69f): the workspaces.json editor
// descriptions moved from workspaces.ts to core/workspace-descriptions.ts, which only
// config-schemas.ts (CLI) loads, so they and zod's registry leave every hook bundle. Core run
// 577,529 B -> 568,160 B (-9,369 B; Claude Code 570,885 -> 561,516, Codex 559,208 -> 549,839,
// Cursor 558,602 -> 549,233); the ceiling is core run plus 2 KiB.
// agent-id-stamp (#883, 2026-11-26, Bun 1.4.5, rebased on #964 at 5f8e4826): the pre-tool agent
// agent-id-stamp (#883, 2026-11-26, Bun 1.4.5, rebased on #969 at 6f5781ff): the pre-tool agent
// stamp for each `workit` call (src/agent-stamp.ts, the CLI claims it), its post-tool cleanup, the
// stamp registry guard and the identity-variable deny (hooks/identity-env.ts) take core run from
// 576,814 B to 580,025 B (+3,211 B; Claude Code 573,379 B, Codex 561,702 B, Cursor 561,096 B). The ceiling is core run
// plus 2 KiB.
const BUDGET = 582_073;
const PINNED_BUN = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { packageManager?: string }
).packageManager?.replace(/^bun@/, "");
const sizeCheckApplies = Bun.version === PINNED_BUN;
// The task store's write side: hooks only read (core/task-read.ts, #807). Classic zod and its
// JSON Schema emitter: hook-loaded schemas import zod from core/zod-mini.ts.
const FORBIDDEN =
  /\/(doctor|setup|setup-state|uninstall|host-install|init)\.ts$|\/src\/core\.ts$|\/core\/task-store\.ts$|\/zod\/v4\/(classic\/|core\/(to-json-schema|json-schema-processors|json-schema-generator)\.js$)/;

test("a hook bundle loads no doctor/setup modules, the core barrel, the task store's write side or classic zod, within its size budget", () => {
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
    // A Workit ceiling, not a Codex limit: 2026-11-12 (#818) the entry sends the
    // registry guard writes that name the approvals or state dir, a glob, an env var,
    // a hard link or a symlink, a quoted marker, and script runs (after a wrapper
    // too); 5,186 B measured, plus 256 B. 2026-11-12 (#780): it also sends a ytrack command
    // word, past wrappers and runners, and keeps a mere mention quiet; 5,508 B, plus 256 B.
    // 2026-11-19 (#777): `feedback` joins the user-only words; 5,770 B, plus 256 B.
    expect(statSync(entry).size).toBeLessThanOrEqual(6_026);
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
