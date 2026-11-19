// #777: `workit feedback` is the user's yes on every spelling. Host rules ask
// on the plain one; Claude Code's PreToolUse asks on all, and Codex's denies a
// spelling its prefix rule cannot see (an env prefix or a global option).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { askedWorkitCall } from "@/packages/workit-core/src/hooks/delivery-verbs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { fixture } from "../hooks/hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-feedback-ask-")));
const repo = path.join(base, "repo");
const saved = { state: process.env.WORKIT_STATE_DIR, config: process.env.WORKIT_CONFIG };
beforeAll(() => {
  mkdirSync(path.join(base, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
});
afterAll(() => {
  for (const [key, value] of [
    ["WORKIT_STATE_DIR", saved.state],
    ["WORKIT_CONFIG", saved.config],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(base, { recursive: true, force: true });
});

type Out = { permissionDecision?: string; permissionDecisionReason?: string };

const claude = (command: string): Out =>
  (
    dispatchHook(claudeCodeAdapter, {
      session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
      transcript_path: path.join(base, "t.jsonl"),
      cwd: repo,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Report Workit friction" },
      tool_use_id: "toolu_01",
    }).json as { hookSpecificOutput?: Out }
  ).hookSpecificOutput ?? {};

const codex = (command: string): Out =>
  (
    dispatchHook(
      codexAdapter,
      fixture("codex", "pre-tool-use-bash", repo, { tool_input: { command } }),
    ).json as { hookSpecificOutput?: Out }
  ).hookSpecificOutput ?? {};

const SPELLINGS = [
  'workit --cwd /tmp/x feedback "t" --body-file d.md --post --account me',
  'workit --json feedback "t" --body-file d.md --post',
  'env GH_HOST=x workit feedback "t" --body-file d.md --post',
  'X=1 workit feedback "t" --body-file d.md --post',
  'echo ok && workit --cwd=/tmp/x feedback "t" --body-file d.md --post',
  // #916: the session option, the package spelling and a shell's `-c` script.
  'workit --session=s1 feedback "t" --body-file d.md --post',
  'workit --session s1 feedback "t" --body-file d.md --post',
  'npx @workit-dev/cli feedback "t" --body-file d.md --post',
  'bunx @workit-dev/cli@latest feedback "t" --body-file d.md --post',
  'bash -c "workit feedback t --body-file d.md --post"',
  "sh -lc 'cd /tmp && workit feedback t --body-file d.md --post'",
  'echo "$(workit feedback t --body-file d.md --post)"',
  'env bash -c "workit feedback t --body-file d.md --post"',
  'sudo -u dev bash -c "workit feedback t --body-file d.md --post"',
  'timeout 9 bash -c "workit feedback t --body-file d.md --post"',
  'bash -c -- "workit feedback t --body-file d.md --post"',
  "eval 'workit feedback t --body-file d.md --post'",
];

test.each(SPELLINGS)("Given `%s`, Then Claude Code asks and Codex denies it", (command) => {
  expect(askedWorkitCall(command)).toEqual({ verb: "feedback", plain: false });
  expect(claude(command).permissionDecision).toBe("ask");
  const out = codex(command);
  expect(out.permissionDecision).toBe("deny");
  // Codex's npx gate denies `npx <workit>` first, naming the plain call all the same.
  expect(out.permissionDecisionReason).toMatch(
    /nothing before the verb|^Run `workit feedback .+`: workit is on PATH\.$/u,
  );
});

test("Given the plain spelling, Then Claude Code still asks and Codex leaves it to its prompt rule", () => {
  const command = 'workit feedback "t" --body-file d.md --post --account me';
  expect(askedWorkitCall(command)).toEqual({ verb: "feedback", plain: true });
  expect(claude(command).permissionDecision).toBe("ask");
  expect(codex(command).permissionDecision).not.toBe("deny");
});

test("Given a call that only mentions feedback, or only asks for its help, Then nothing is asked", () => {
  for (const command of [
    'workit pr create --title "feedback loop" --body-file b.md',
    "workit feedback --help",
    "workit help feedback",
  ])
    expect(askedWorkitCall(command), command).toBeNull();
});

test.each([
  "npx @workit-dev/cli pr status",
  'bash -c "workit pr status"',
  'echo "workit feedback is a verb"',
  'npx @other/cli feedback "t"',
])("Given `%s`, Then it is no asked call", (command) => {
  expect(askedWorkitCall(command)).toBeNull();
});
