import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";
import { FANOUT_TOKEN_FILE } from "@/packages/workit-core/src/hooks/worktree-confine";

// #432: a workit:implementer spawn carries a Workit brief; #654: no spawn
// type keeps host isolation.

let configHome: ConfigHome;
let cwd: string;
/** A linked worktree whose git admin dir holds the fanout token, as `fanout worktree create` leaves it. */
let made: string;
/** A linked worktree made by hand (no token). */
let plain: string;
const git = (dir: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
beforeAll(() => {
  configHome = useConfigHome("wk-spawn-gate-");
  cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-spawn-gate-cwd-")));
  const repo = path.join(cwd, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  made = path.join(cwd, "wt-made");
  plain = path.join(cwd, "wt-plain");
  git(repo, "worktree", "add", "-q", "--detach", made);
  git(repo, "worktree", "add", "-q", "--detach", plain);
  writeFileSync(path.resolve(made, git(made, "rev-parse", "--git-dir"), FANOUT_TOKEN_FILE), "t\n");
});
afterAll(() => {
  configHome.restore();
  rmSync(cwd, { recursive: true, force: true });
});

type Out = {
  hookSpecificOutput?: {
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
const BRIEF =
  "MODE: new\nGOAL: g\nWORKTREE: /w/slice  (made by `workit fanout worktree create slice`; yours alone)\n";
const spawn = (input: Record<string, unknown>, mode = "default"): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    permission_mode: mode,
    tool_name: "Agent",
    tool_input: { description: "d", ...input },
  }).json;

test("G an implementer spawn with a brief and isolation, W PreToolUse runs, T isolation is dropped and the rest kept", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    model: "opus",
    isolation: "worktree",
  });
  expect(out.hookSpecificOutput?.updatedInput).toEqual({
    description: "d",
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  expect(out.hookSpecificOutput?.additionalContext).toContain("removed isolation");
});

test("G an implementer spawn with isolation and no model, W PreToolUse runs, T isolation is dropped and no model is added (the agent file carries it)", () => {
  const updated = spawn({
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    isolation: "worktree",
  }).hookSpecificOutput?.updatedInput;
  expect(updated).toBeDefined();
  expect(updated?.isolation).toBeUndefined();
  expect(updated?.model).toBeUndefined();
});

test("G an implementer spawn that names no worktree, W PreToolUse runs, T the deny is two lines whose Retry as is the ad-hoc worktree command for the slice word it names", () => {
  for (const [input, slice] of [
    [{ description: "Fix login", prompt: "fix the tests" }, "fix-login"],
    [{ description: "d", prompt: "WORKER: api-v2\nGOAL: g\n" }, "api-v2"],
    [{ description: "d", prompt: "Run `workit fanout brief ui` first" }, "ui"],
  ] as const) {
    const out = spawn({ subagent_type: "workit:implementer", model: "opus", ...input });
    expect(out.hookSpecificOutput?.permissionDecision, slice).toBe("deny");
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
    const lines = reason.split("\n");
    expect(lines, reason).toHaveLength(2);
    expect(lines[0]).toStartWith("workit spawn gate: ");
    expect(lines[1]).toStartWith(`Retry as: workit fanout worktree create ${slice} `);
    expect(lines[1]).toContain("with the WORKTREE line it prints as the prompt's first line");
    expect(reason.length).toBeLessThanOrEqual(400);
  }
});

test("G a prompt that is only 'Your brief is the file <path>', W the file holds a made WORKTREE line, T the spawn runs; a file without one is denied", () => {
  const brief = path.join(cwd, "brief.txt");
  writeFileSync(
    brief,
    `MODE: new\nGOAL: g\nWORKTREE: ${made}  (made by \`workit fanout worktree create a\`; yours alone)\n`,
  );
  const runs = spawn({
    subagent_type: "workit:implementer",
    prompt: `Your brief is the file ${brief}.`,
  });
  expect(runs.hookSpecificOutput?.permissionDecision).toBeUndefined();
  const empty = path.join(cwd, "notes.txt");
  writeFileSync(empty, "GOAL: g\n");
  const denied = spawn({
    subagent_type: "workit:implementer",
    prompt: `Your brief is the file ${empty}`,
  });
  expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
});

test("G a prompt naming a worktree's path with no WORKTREE line, W PreToolUse runs, T it runs for a worktree Workit made and is denied for one made by hand", () => {
  const prompt = (dir: string) => `Work in ${dir}: fix the flaky test, then report.`;
  expect(
    spawn({ subagent_type: "workit:implementer", prompt: prompt(made) }).hookSpecificOutput
      ?.permissionDecision,
  ).toBeUndefined();
  expect(
    spawn({ subagent_type: "workit:implementer", prompt: prompt(plain) }).hookSpecificOutput
      ?.permissionDecision,
  ).toBe("deny");
  expect(
    spawn({ subagent_type: "workit:implementer", prompt: "Read /dev/zero and /etc then stop" })
      .hookSpecificOutput?.permissionDecision,
  ).toBe("deny");
});

test("G an implementer prompt that points at its brief (WORKER, TIER, TIMEBOX and WORKTREE lines, render the rest), W PreToolUse runs, T it is accepted as a brief", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt:
      "WORKER: slice\nTIER: standard\nTIMEBOX: 30 minutes, 120 tool calls\nWORKTREE: /w/slice\nRun `workit fanout brief slice` and follow its text exactly.\n",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
});

test("G a brief rendered before its worktree was made, W PreToolUse runs, T it is denied too", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt:
      "GOAL: g\nWORKTREE: /w/slice  (not made yet: the lead runs `workit fanout worktree create slice` before spawning)\n",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
});

test("G a WORKTREE line that is only the not-made-yet note, W PreToolUse runs, T it is denied (no regex backtracking)", () => {
  for (const line of [
    "WORKTREE: not made yet",
    "WORKTREE:  not made yet",
    "WORKTREE:not made yet",
  ]) {
    const out = spawn({
      subagent_type: "workit:implementer",
      prompt: `GOAL: g\n${line}\n`,
      model: "opus",
    });
    expect(out.hookSpecificOutput?.permissionDecision, line).toBe("deny");
  }
});

test("G any other spawn type with isolation, W PreToolUse runs, T isolation is dropped and the rest kept (retro class 9)", () => {
  for (const subagent_type of [
    "workit:verifier",
    "general-purpose",
    "Explore",
    "Plan",
    undefined,
  ]) {
    const out = spawn({
      subagent_type,
      prompt: "verify it",
      model: "sonnet",
      isolation: "worktree",
    });
    expect(out.hookSpecificOutput?.permissionDecision, String(subagent_type)).toBeUndefined();
    expect(out.hookSpecificOutput?.updatedInput, String(subagent_type)).toEqual({
      description: "d",
      prompt: "verify it",
      model: "sonnet",
      ...(subagent_type ? { subagent_type } : {}),
    });
    expect(out.hookSpecificOutput?.additionalContext).toContain("removed isolation");
  }
});

test("G a verifier spawn with no isolation and a model, W PreToolUse runs, T it is left as written", () => {
  const out = spawn({
    subagent_type: "workit:verifier",
    prompt: "verify it",
    model: "sonnet",
  });
  expect(out.hookSpecificOutput).toBeUndefined();
});

test("G every agent type and either isolation mode, W PreToolUse runs, T isolation never reaches Claude Code (W2.12)", () => {
  const types = [
    "workit:implementer",
    "workit:verifier",
    "workit:reviewer",
    "general-purpose",
    "Explore",
    "Plan",
    "fork",
    "claude",
    "claude-code-guide",
    "statusline-setup",
    "someone:else",
    undefined,
  ];
  for (const subagent_type of types)
    for (const isolation of ["worktree", "remote"]) {
      const label = `${String(subagent_type)} ${isolation}`;
      const out = spawn({
        subagent_type,
        prompt: BRIEF,
        model: "sonnet",
        isolation,
      });
      expect(out.hookSpecificOutput?.permissionDecision, label).toBeUndefined();
      const input = out.hookSpecificOutput?.updatedInput;
      expect(input, label).toBeDefined();
      expect(input, label).not.toHaveProperty("isolation");
      expect(input?.prompt, label).toBe(BRIEF);
    }
});

test("G auto mode and a spawn with isolation, W PreToolUse runs, T it is denied with the same args without isolation (never rewritten), and that retry runs as written (retro 2026-11-07 R1)", () => {
  const out = spawn(
    {
      subagent_type: "workit:implementer",
      prompt: BRIEF,
      model: "opus",
      isolation: "worktree",
      run_in_background: true,
    },
    "auto",
  ).hookSpecificOutput;
  expect(out?.updatedInput).toBeUndefined();
  expect(out?.permissionDecision).toBe("deny");
  expect(out?.permissionDecisionReason).toContain(
    'Retry as: Agent subagent_type: "workit:implementer", model: "opus", run_in_background: true (description and prompt as written and no isolation).',
  );
  expect(
    spawn(
      {
        subagent_type: "workit:implementer",
        prompt: BRIEF,
        model: "opus",
        run_in_background: true,
      },
      "auto",
    ).hookSpecificOutput,
  ).toBeUndefined();
});

test("G auto mode and a spawn with isolation and no model, W PreToolUse runs, T one deny drops isolation and adds no model (the agent file carries it)", () => {
  const reason = spawn(
    { subagent_type: "workit:implementer", prompt: BRIEF, isolation: "worktree" },
    "auto",
  ).hookSpecificOutput?.permissionDecisionReason;
  expect(reason).toContain(
    'Retry as: Agent subagent_type: "workit:implementer" (description and prompt as written and no isolation).',
  );
});
