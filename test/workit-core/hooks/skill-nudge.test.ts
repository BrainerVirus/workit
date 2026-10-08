// Skill routing at the moment it matters: a prompt naming a skill's trigger
// and a delivery command each get one line naming the skill to load, until the
// session loads it; every Workit skill load is a `skill.loaded` ledger row.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import {
  isDeliveryCommand,
  promptTrigger,
  workitSkillOf,
} from "@/packages/workit-core/src/hooks/skill-nudge";
import { readLedger, summarizeRow } from "@/packages/workit-core/src/ledger";
import { injectSkillNudge, observeSkillLoad } from "@/packages/workit-opencode/src/v2/skills";
import { enforceToolPolicy, skillPromptNudge } from "@/packages/workit-pi/src/tools";
import { tempRoot, withProtectedMain } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A Workit workspace checkout on feature/x. */
const repo = () => {
  const root = tempRoot("workit-skill-nudge-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

type Out = { hookSpecificOutput?: { additionalContext?: string } };
const context = (payload: Record<string, unknown>) =>
  (dispatchHook(claudeCodeAdapter, { session_id: "s-lead", ...payload }).json as Out)
    .hookSpecificOutput?.additionalContext ?? "";
const prompt = (cwd: string, text: string, extra: Record<string, unknown> = {}) =>
  context({ hook_event_name: "UserPromptSubmit", cwd, prompt: text, ...extra });
const bash = (cwd: string, command: string, extra: Record<string, unknown> = {}) =>
  context({
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  });
const loadSkill = (cwd: string, skill: string) =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "s-lead",
    cwd,
    tool_name: "Skill",
    tool_input: { skill },
  });
const skillRows = (root: string) => {
  const ledger = readLedger(root);
  return ledger.ok ? ledger.value.rows.filter((row) => row.type === "skill.loaded") : [];
};

test("a prompt triggers the first skill whose word it names, as a word, outside code blocks", () => {
  const cases: Array<[string, string | null]> = [
    ["let's brainstorm the ui-kit tokens", "workit-shape"],
    ["the login test is flaky again", "workit-debug"],
    ["can you review PR 12", "workit-review"],
    ["wait for CI and land it", "workit-ship"],
    ["write the acceptance criteria first", "workit-bdd"],
    ["time for a retro", "workit-retro"],
    // Not words: inside another word, another case for an acronym, in a code block.
    ["ask the reviewer", null],
    ["we decide on the social icons", null],
    ["here is the log:\n```\nbuild failed: bug\n```", null],
    ["thanks!", null],
  ];
  for (const [text, skill] of cases)
    expect((promptTrigger(text)?.skill as string | null | undefined) ?? null, text).toBe(skill);
});

test("skill names resolve from the Skill tool, slash aliases and canonical names, and nothing else", () => {
  expect(workitSkillOf("workit:shape")).toBe("workit-shape");
  expect(workitSkillOf("/wk-debug")).toBe("workit-debug");
  expect(workitSkillOf("workit-verify-app")).toBe("workit-verify-app");
  expect(workitSkillOf("workit-steer")).toBeNull();
  expect(workitSkillOf("frontend-design")).toBeNull();
});

test("G a main session, W a prompt names a trigger, T one line names the skill until the session loads it", async () => {
  await withProtectedMain(() => {
    const root = repo();
    expect(prompt(root, "let's brainstorm the ui-kit tokens")).toContain(
      'Workit: this request ("brainstorm") matches workit-shape; call the Skill tool with `workit:shape` before acting.',
    );
    expect(prompt(root, "thanks!")).not.toContain("Workit: this request");
    loadSkill(root, "workit:shape");
    expect(skillRows(root).map((row) => [row.skill, row.via, row.actor.session])).toEqual([
      ["workit-shape", "tool", "s-lead"],
    ]);
    expect(prompt(root, "brainstorm the spacing scale too")).not.toContain("workit-shape");
    // Loading it again records nothing new; another skill is still nudged.
    loadSkill(root, "workit:shape");
    expect(skillRows(root)).toHaveLength(1);
    expect(prompt(root, "the dialog test is flaky")).toContain("`workit:debug`");
    // A user-invoked skill is offered, never loaded.
    expect(prompt(root, "time for a retro")).toContain(
      "which the user starts; offer it (/wk-retro)",
    );
  });
});

test("G a slash command, T its skill is recorded and nothing is nudged; G a subagent, T no nudge", async () => {
  await withProtectedMain(() => {
    const root = repo();
    expect(prompt(root, "/wk-debug the build is broken")).not.toContain("Workit: this request");
    expect(prompt(root, "/workit:review blast radius of #12")).not.toContain("Workit:");
    expect(skillRows(root).map((row) => [row.skill, row.via])).toEqual([
      ["workit-debug", "slash"],
      ["workit-review", "slash"],
    ]);
    expect(
      bash(root, "git push -u origin feature/x", { agent_id: "a1", agent_type: "Explore" }),
    ).not.toContain("workit-ship");
    // Another plugin's skill is not Workit's to record.
    loadSkill(root, "frontend-design");
    expect(skillRows(root)).toHaveLength(2);
  });
});

test("G a delivery command, T the ship line rides with the raw-git nudge until workit-ship is loaded", async () => {
  await withProtectedMain(() => {
    const root = repo();
    const ship =
      "Workit: this delivery step matches workit-ship; call the Skill tool with `workit:ship`";
    const push = bash(root, "git push -u origin feature/x");
    expect(push).toContain("workit git push");
    expect(push).toContain(ship);
    expect(bash(root, "workit pr create --fill")).toBe(`${ship} before acting.`);
    expect(bash(root, "npx -y @brainervirus/workit-cli ci wait --pr 3")).toContain(ship);
    expect(bash(root, "git status")).toBe("");
    loadSkill(root, "workit:ship");
    expect(bash(root, "workit pr create --fill")).toBe("");
    expect(bash(root, "git push -u origin feature/x")).not.toContain("workit-ship");
  });
});

test("G a Workit workspace, delivery commands are pushes, PR/MR create or merge, and CI waits, through any wrapper; T never help, a dry run or an unmanaged repo", async () => {
  await withProtectedMain(() => {
    const root = repo();
    for (const command of [
      "git push",
      "git -C . push origin HEAD",
      "gh pr create --fill",
      "glab mr merge 4",
      "workit git push",
      "/usr/local/bin/workit ci wait --pr 3",
      "bash -c 'workit pr merge --method squash'",
    ])
      expect(isDeliveryCommand(root, command), command).toBe(true);
    for (const command of [
      "git status",
      "gh pr view 3",
      "gh pr merge --help",
      "git push --dry-run",
      "workit pr create --help",
      "workit pr status",
      "echo workit ci wait",
    ])
      expect(isDeliveryCommand(root, command), command).toBe(false);
    const unmanaged = tempRoot("workit-skill-nudge-plain-");
    roots.push(unmanaged);
    spawnSync("git", ["init", "-q"], { cwd: unmanaged });
    expect(isDeliveryCommand(unmanaged, "workit pr create")).toBe(false);
    expect(isDeliveryCommand(unmanaged, "git push")).toBe(false);
  });
});

test("OpenCode's skill tool records the load, and the ledger summarizes the row", async () => {
  await withProtectedMain(() => {
    const root = repo();
    observeSkillLoad(root, { sessionID: "ses_1", input: { name: "workit-implement" } });
    observeSkillLoad(root, { sessionID: "ses_1", input: {} });
    const rows = skillRows(root);
    expect(rows.map((row) => [row.skill, row.actor.host, row.actor.session])).toEqual([
      ["workit-implement", "opencode", "ses_1"],
    ]);
    expect(summarizeRow(rows[0]).summary).toBe("workit-implement (tool)");
  });
});

test("OpenCode: a new user message gets the nudge as a system line; a tool step or a child session does not", async () => {
  await withProtectedMain(() => {
    const root = repo();
    const system: Array<{ type: string; text: string }> = [];
    const user = { role: "user", content: [{ type: "text", text: "let's brainstorm the cache" }] };
    injectSkillNudge(root, { id: "ses_1" }, [user], system);
    expect(system.map((part) => part.text)).toEqual([
      'Workit: this request ("brainstorm") matches workit-shape; call the skill tool with `workit-shape` before acting.',
    ]);
    injectSkillNudge(root, { id: "ses_1" }, [user, { role: "tool", content: [] }], system);
    injectSkillNudge(root, { id: "ses_2", parentID: "ses_1" }, [user], system);
    expect(system).toHaveLength(1);
    observeSkillLoad(root, { sessionID: "ses_1", input: { name: "workit-shape" } });
    injectSkillNudge(root, { id: "ses_1" }, [user], system);
    expect(system).toHaveLength(1);
  });
});

test("hosts that load skills as files: a SKILL.md read is the load (Codex shell, Pi read tool, Pi's expanded /skill:)", async () => {
  await withProtectedMain(() => {
    const root = repo();
    dispatchHook(codexAdapter, {
      hook_event_name: "PreToolUse",
      session_id: "codex-1",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "sed -n 1,80p ~/.codex/skills/workit-debug/SKILL.md" },
    });
    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => "pi-1" },
      isProjectTrusted: () => true,
    } as never;
    enforceToolPolicy(
      { toolName: "read", input: { path: "/x/skills/workit-review/SKILL.md" } } as never,
      ctx,
    );
    expect(
      skillPromptNudge('<skill name="workit-bdd" location="/x">\nGiven/When/Then…</skill>', ctx),
    ).toBeNull();
    expect(skillPromptNudge("review the parser change", ctx)).toBeNull();
    expect(skillPromptNudge("the parser is flaky", ctx)).toContain(
      "read the `workit-debug` skill's SKILL.md and follow it",
    );
    expect(skillRows(root).map((row) => [row.skill, row.via, row.actor.host])).toEqual([
      ["workit-debug", "read", "codex_cli"],
      ["workit-review", "read", "pi"],
      ["workit-bdd", "slash", "pi"],
    ]);
  });
});
