// Audit M5: each host's own shell session id stands in for WORKIT_SESSION_ID,
// so commits and verdicts made from Codex, OpenCode and Pi shells carry the
// session their hooks see.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  childSessionId,
  hostSessionFromEnv,
  realHostSession,
  recordIssuedSession,
  sessionClaimRefusal,
} from "@/packages/workit-core/src/host-session";
import { actorFromEnv } from "@/packages/workit-core/src/ledger";

test("the acting session: WORKIT_SESSION_ID when set (even empty), else the host's shell variable", () => {
  const table: Array<[NodeJS.ProcessEnv, { host: string | null; session: string | null }]> = [
    [
      { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "c-1" },
      { host: "claude_code", session: "c-1" },
    ],
    [
      { WORKIT_SESSION_ID: "lead-v1", CODEX_THREAD_ID: "t-1" },
      { host: null, session: "lead-v1" },
    ],
    [
      { WORKIT_SESSION_ID: "", OPENCODE_SESSION_ID: "ses_1" },
      { host: null, session: null },
    ],
    [{ OPENCODE_SESSION_ID: "ses_1" }, { host: "opencode", session: "ses_1" }],
    [{ PI_SESSION_ID: "pi-1" }, { host: "pi", session: "pi-1" }],
    [{ CODEX_THREAD_ID: "t-1" }, { host: "codex_cli", session: "t-1" }],
    [
      { CODEX_THREAD_ID: "t-2", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
      { host: "codex_desktop", session: "t-2" },
    ],
    [{ CURSOR_TRACE_ID: "x" }, { host: null, session: null }],
    // Codex started from Claude Code's Bash inherits Claude's pair: Codex's own id wins.
    [
      { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "claude-1", CODEX_THREAD_ID: "t-3" },
      { host: "codex_cli", session: "t-3" },
    ],
    // A pair naming the same host is deliberate (a Pi worker, a lead-assigned verifier id).
    [
      { WORKIT_HOST: "pi", WORKIT_SESSION_ID: "pi-w-1", PI_SESSION_ID: "pi-child" },
      { host: "pi", session: "pi-w-1" },
    ],
    [
      { WORKIT_HOST: "codex_cli", WORKIT_SESSION_ID: "t-3-v1", CODEX_THREAD_ID: "t-3" },
      { host: "codex_cli", session: "t-3-v1" },
    ],
  ];
  for (const [env, expected] of table)
    expect(hostSessionFromEnv(env), JSON.stringify(env)).toEqual(expected);
});

test("ledger rows written from a Codex shell are attributed to the Codex thread", () => {
  expect(actorFromEnv({ CODEX_THREAD_ID: "t-9" })).toEqual({
    host: "codex_cli",
    session: "t-9",
    agentId: null,
  });
  expect(actorFromEnv({})).toEqual({ host: "cli", session: null, agentId: null });
});

test("the real host session: the host's own shell variable beats an exported WORKIT_SESSION_ID", () => {
  expect(realHostSession({ WORKIT_SESSION_ID: "ses_1-v9", OPENCODE_SESSION_ID: "ses_1" })).toEqual({
    host: "opencode",
    session: "ses_1",
    kind: "derived",
  });
  // Claude Code puts no id in the shell: its hook's export is declared, not derived.
  expect(realHostSession({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "c-1" })).toEqual({
    host: "claude_code",
    session: "c-1",
    kind: "declared",
  });
  // No host at all (CI, a plain terminal, Cursor's prefixed commands).
  expect(realHostSession({ WORKIT_SESSION_ID: "ci-1" }).kind).toBe("none");
  expect(realHostSession({}).kind).toBe("none");
});

test("a child session id keeps the child's own id whole and fits the ledger's grammar", () => {
  expect(childSessionId("ses_lead", "ses_child")).toBe("ses_lead:ses_child");
  const long = childSessionId("l".repeat(200), "c".repeat(40));
  expect(long).toHaveLength(128);
  expect(long.endsWith(`:${"c".repeat(40)}`)).toBe(true);
  expect(childSessionId("a b", "c")).toBe("a-b:c");
});

test("a verdict session claim: the real session, a child naming its own host session, or a hook-issued id; anything invented is forged", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  try {
    recordIssuedSession(cwd, "lead", "lead:agent-7");
    recordIssuedSession(cwd, "t-1", "t-1:agent-2");
    const accepted: Array<[NodeJS.ProcessEnv, string]> = [
      [{ OPENCODE_SESSION_ID: "ses_c" }, "ses_c"],
      [{ OPENCODE_SESSION_ID: "ses_c" }, "ses_l:ses_c"],
      [{ PI_SESSION_ID: "w1" }, "lead:w1"],
      // Hook-issued subagent ids on hosts whose subagents share the lead's shell.
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "lead:agent-7"],
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead:agent-7" }, "lead:agent-7"],
      [{ CODEX_THREAD_ID: "t-1" }, "t-1:agent-2"],
      // No host session (CI, a plain terminal): --session and the env are one declaration.
      [{ WORKIT_SESSION_ID: "ci-1" }, "anyone"],
      [{}, "anyone"],
    ];
    for (const [env, claimed] of accepted)
      expect(
        sessionClaimRefusal(env, claimed, cwd),
        `${claimed} ${JSON.stringify(env)}`,
      ).toBeNull();
    const refused: Array<[NodeJS.ProcessEnv, string]> = [
      [{ OPENCODE_SESSION_ID: "ses_l" }, "ses_l-v61"],
      // OpenCode and Pi children have their own shell: a lead never mints one.
      [{ OPENCODE_SESSION_ID: "ses_l" }, "ses_l:ses_c"],
      [{ PI_SESSION_ID: "lead" }, "lead:w1"],
      // A lead inventing a child id: never issued by its SubagentStart hook.
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "lead:v1"],
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead:v1" }, "lead:v1"],
      [{ CODEX_THREAD_ID: "t-1" }, "t-1:v1"],
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "lead-v1"],
      [{ CODEX_THREAD_ID: "t-1", WORKIT_SESSION_ID: "t-1-v1" }, "t-1-v1"],
      // A declared host never derives: `<x>:<real>` is an invented label there.
      [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "x:lead"],
    ];
    for (const [env, claimed] of refused) {
      const refusal = sessionClaimRefusal(env, claimed, cwd);
      expect(refusal?.error, claimed).toContain("forged_session");
      // The unblock never invites naming an id by hand.
      expect(refusal?.unblock, claimed).not.toContain("<agent id>");
    }
    // Without the workspace's record nothing counts as issued.
    expect(
      sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1:agent-2", undefined),
    ).not.toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the issued-session record stays bounded per lead and keeps the newest ids", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  try {
    for (let i = 0; i < 70; i++) recordIssuedSession(cwd, "lead", `lead:a${i}`);
    const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };
    expect(sessionClaimRefusal(env, "lead:a69", cwd)).toBeNull();
    const kept = Array.from({ length: 70 }, (_, i) => sessionClaimRefusal(env, `lead:a${i}`, cwd));
    expect(kept.filter((refusal) => refusal === null)).toHaveLength(64);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
