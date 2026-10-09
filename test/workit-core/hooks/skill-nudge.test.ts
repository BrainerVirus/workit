// Skill routing at the moment it matters, inside a Workit workspace: a prompt
// asking for a skill's work and a delivery command each get one advisory line
// naming the skill, once per session and never after it loaded the skill;
// every Workit skill load is a `skill.loaded` ledger row.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import {
  isDeliveryCommand,
  promptTrigger,
  skillReadIn,
  workitSkillOf,
} from "@/packages/workit-core/src/hooks/skill-nudge";
import { readLedger, summarizeRow } from "@/packages/workit-core/src/ledger";
import { injectSkillNudge, observeSkillLoad } from "@/packages/workit-opencode/src/v2/skills";
import {
  enforceToolPolicy,
  observeToolResult,
  skillPromptNudge,
} from "@/packages/workit-pi/src/tools";
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

test("a prompt asks for a skill only in so many words: common words alone never route", () => {
  const cases: Array<[string, string | null]> = [
    ["let's brainstorm the ui-kit tokens", "workit-shape"],
    ["plan the cache invalidation", "workit-shape"],
    ["the login test is flaky again", "workit-debug"],
    // A broken thing is debug work first, even when it names a build.
    ["the build is broken", "workit-debug"],
    ["can you review PR 12", "workit-review"],
    ["babysit it until CI is green", "workit-ship"],
    ["write the acceptance criteria first", "workit-bdd"],
    ["time for a retro", "workit-retro"],
    ["implement the --since flag", "workit-implement"],
    // Questions and mentions (review #242 finding 1), code blocks, partial words.
    ["fix login.spec.ts", null],
    ["what's in the plan?", null],
    ["the release plan doc", null],
    ["npm run build fails", null],
    ["why is the build slow", null],
    ["is the build green?", null],
    ["resolve the merge conflict", null],
    ["describe the merge sort algorithm", null],
    ["explain how the CI config works", null],
    ["the bug label in github", null],
    ["resume.pdf parser", null],
    ["ask the reviewer", null],
    ["add a retro-styled button", null],
    ["fit a linear regression", null],
    ["the docker swarm config", null],
    ["open the PR description file", null],
    ["this is a regression since 8.4", "workit-debug"],
    ["open a PR for it", "workit-ship"],
    ["please open a PR against main", "workit-ship"],
    ["let's close out the retro. Thanks", "workit-retro"],
    ["let's do a retro", "workit-retro"],
    ["spin up a swarm of agents", "workit-fanout"],
    ["here is the log:\n```\nthe build is broken: flaky\n```", null],
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

test("G a main session, W a prompt asks for a skill, T one advisory line, once, and none after it loads", async () => {
  await withProtectedMain(() => {
    const root = repo();
    expect(prompt(root, "let's brainstorm the ui-kit tokens")).toContain(
      'Workit: this request ("brainstorm") looks like workit-shape work; if it is, call the Skill tool with `workit:shape` first.',
    );
    // Ignored once, it does not repeat.
    expect(prompt(root, "brainstorm the spacing scale too")).not.toContain("workit-shape");
    expect(prompt(root, "thanks!")).not.toContain("Workit: this request");
    expect(prompt(root, "the dialog test is flaky")).toContain("`workit:debug`");
    loadSkill(root, "workit:shape");
    loadSkill(root, "workit:shape");
    expect(skillRows(root).map((row) => [row.skill, row.via, row.actor.session])).toEqual([
      ["workit-shape", "tool", "s-lead"],
    ]);
    // Each session is nudged on its own.
    expect(prompt(root, "should we split the store?", { session_id: "s-other" })).toContain(
      "workit-shape",
    );
    // A user-invoked skill is offered, never loaded.
    expect(prompt(root, "time for a retro")).toContain(
      "which the user starts; offer it (/wk-retro)",
    );
  });
});

test("G a directory Workit does not manage (plain repo or no git), T no nudge and no ledger written", async () => {
  await withProtectedMain(() => {
    const plain = tempRoot("workit-skill-nudge-plain-");
    const bare = tempRoot("workit-skill-nudge-nogit-");
    roots.push(plain, bare);
    spawnSync("git", ["init", "-q"], { cwd: plain });
    for (const dir of [plain, bare]) {
      expect(prompt(dir, "let's brainstorm the API")).toBe("");
      expect(bash(dir, "workit pr create --fill")).toBe("");
      loadSkill(dir, "workit:shape");
      prompt(dir, "/wk-debug it");
    }
    expect(existsSync(path.join(plain, ".git", "workit"))).toBe(false);
    expect(existsSync(path.join(bare, ".workit"))).toBe(false);
  });
});

test("G a prompt that loads its skill (slash, OpenCode's /wk-* rewrite, Pi's /skill:), T recorded, never nudged; G a subagent, T no nudge", async () => {
  await withProtectedMain(() => {
    const root = repo();
    expect(prompt(root, "/wk-debug the build is broken")).not.toContain("Workit: this request");
    expect(prompt(root, "/workit:review blast radius of #12")).not.toContain("Workit:");
    expect(
      prompt(
        root,
        "Load the workit-ship skill with the skill tool and apply it to the current task. Arguments: the parser is flaky",
      ),
    ).not.toContain("Workit:");
    expect(skillRows(root).map((row) => [row.skill, row.via])).toEqual([
      ["workit-debug", "slash"],
      ["workit-review", "slash"],
      ["workit-ship", "slash"],
    ]);
    expect(
      prompt(root, "the dialog test is flaky", { agent_id: "a1", agent_type: "Explore" }),
    ).toBe("");
    // Another plugin's skill is not Workit's to record.
    loadSkill(root, "frontend-design");
    expect(skillRows(root)).toHaveLength(3);
  });
});

test("G a prompt that relays another agent's words (hand-back, teammate message, task notification), T no nudge and the nudge stays unspent", async () => {
  await withProtectedMain(() => {
    const root = repo();
    const relayed = [
      'Another Claude session sent a message while you were working:\n<agent-message from="a65">\nThe parser regressed after the refactor; fix the bug in lexer.ts.\n</agent-message>',
      '  <agent-message from="reviewer-1">the dialog test is flaky and regressed</agent-message>',
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<summary>verifier: the build is broken</summary>\n</task-notification>",
      "<task-notification><status>completed</status><result>this is a regression since 8.4</result></task-notification>",
    ];
    for (const text of relayed) expect(prompt(root, text), text).toBe("");
    // The user's own words still route, and the nudge was not spent above,
    // even when they mention a marker mid-prompt.
    expect(
      prompt(root, "the dialog test is flaky; ignore the <task-notification> noise"),
    ).toContain("`workit:debug`");
  });
});

test("G a delivery command, T the ship line rides with the raw-git nudge, once per session, and not after workit-ship loads", async () => {
  await withProtectedMain(() => {
    const root = repo();
    const ship =
      "Workit: this delivery step looks like workit-ship work; if it is, call the Skill tool with `workit:ship` first.";
    const push = bash(root, "git push -u origin feature/x");
    expect(push).toContain("workit git push");
    expect(push).toContain(ship);
    expect(bash(root, "workit pr create --fill")).toBe("");
    expect(bash(root, "git push -u origin feature/x")).not.toContain("workit-ship");
    expect(bash(root, "workit pr create --fill", { session_id: "s-2" })).toBe(ship);
    loadSkill(root, "workit:ship");
    expect(bash(root, "workit ci wait --pr 3", { session_id: "s-3" })).toBe(ship);
    expect(bash(root, "git status", { session_id: "s-4" })).toBe("");
    expect(
      bash(root, "git push -u origin feature/x", { agent_id: "a1", agent_type: "Explore" }),
    ).not.toContain("workit-ship");
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
      "npx -y @brainervirus/workit-cli pr create --fill",
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
      "workit ci rerun --failed",
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

test("a shell loads a skill only by reading its SKILL.md: never git, grep or an editor", () => {
  expect(skillReadIn("sed -n 1,80p ~/.codex/skills/workit-debug/SKILL.md")).toBe("workit-debug");
  expect(skillReadIn("cd x && cat skills/workit-ship/SKILL.md | head")).toBe("workit-ship");
  expect(skillReadIn("cat -image skills/workit-ship/SKILL.md")).toBe("workit-ship");
  expect(skillReadIn("Get-Content C:\\skills\\workit-bdd\\SKILL.md", "powershell")).toBe(
    "workit-bdd",
  );
  for (const command of [
    "git add packages/workit-core/skills/workit-ship/SKILL.md",
    "grep -n Check skills/workit-ship/SKILL.md",
    "git diff -- skills/workit-ship/SKILL.md",
    "vim skills/workit-ship/SKILL.md",
    "sed -i s/a/b/ skills/workit-ship/SKILL.md",
    "sed -i.bak s/a/b/ skills/workit-ship/SKILL.md",
    "cat skills/workit-ship/SKILL.md.orig",
  ])
    expect(skillReadIn(command), command).toBeNull();
});

test("OpenCode: a new user message gets the nudge as a system line; a tool step or a child session does not; the skill tool records the load", async () => {
  await withProtectedMain(() => {
    const root = repo();
    const system: Array<{ type: string; text: string }> = [];
    const user = { role: "user", content: [{ type: "text", text: "let's brainstorm the cache" }] };
    injectSkillNudge(root, { id: "ses_2", parentID: "ses_1" }, [user], system);
    injectSkillNudge(root, { id: "ses_1" }, [user, { role: "tool", content: [] }], system);
    expect(system).toEqual([]);
    injectSkillNudge(root, { id: "ses_1" }, [user], system);
    expect(system.map((part) => part.text)).toEqual([
      'Workit: this request ("brainstorm") looks like workit-shape work; if it is, call the skill tool with `workit-shape` first.',
    ]);
    observeSkillLoad(root, { sessionID: "ses_1", input: { name: "workit-implement" } });
    observeSkillLoad(root, { sessionID: "ses_1", input: {} });
    const rows = skillRows(root);
    expect(rows.map((row) => [row.skill, row.actor.host, row.actor.session])).toEqual([
      ["workit-implement", "opencode", "ses_1"],
    ]);
    expect(summarizeRow(rows[0]).summary).toBe("workit-implement (tool)");
  });
});

test("hosts that load skills as files: a SKILL.md read is the load (Codex shell, Pi read tool, Pi's expanded /skill:); a Pi worker gets no ship line", async () => {
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
    const result = (env: string | undefined) => {
      const previous = process.env.WORKIT_PI_WORKER_SESSION;
      if (env === undefined) delete process.env.WORKIT_PI_WORKER_SESSION;
      else process.env.WORKIT_PI_WORKER_SESSION = env;
      try {
        const out = observeToolResult(
          {
            toolName: "bash",
            isError: false,
            input: { command: "git push -u origin feature/x" },
            content: [],
            toolCallId: "c1",
          } as never,
          {
            ...(ctx as object),
            sessionManager: { getSessionId: () => (env ? "pi-worker" : "pi-2") },
          } as never,
        );
        return JSON.stringify(out ?? {});
      } finally {
        if (previous === undefined) delete process.env.WORKIT_PI_WORKER_SESSION;
        else process.env.WORKIT_PI_WORKER_SESSION = previous;
      }
    };
    expect(result("pi-worker")).toContain("workit git push");
    expect(result("pi-worker")).not.toContain("workit-ship");
    expect(result(undefined)).toContain("workit-ship");
  });
});
