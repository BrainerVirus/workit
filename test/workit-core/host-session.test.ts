// Audit M5: each host's own shell session id stands in for WORKIT_SESSION_ID,
// so commits and verdicts made from Codex, OpenCode and Pi shells carry the
// session their hooks see.
import { expect, test } from "bun:test";
import {
  childSessionId,
  hostSessionFromEnv,
  realHostSession,
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
    derived: true,
  });
  // Claude Code and Cursor put no id in the shell: the hook's export is declared, not derived.
  expect(realHostSession({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "c-1" })).toEqual({
    host: "claude_code",
    session: "c-1",
    derived: false,
  });
});

test("a child session id keeps the child's own id whole and fits the ledger's grammar", () => {
  expect(childSessionId("ses_lead", "ses_child")).toBe("ses_lead:ses_child");
  const long = childSessionId("l".repeat(200), "c".repeat(40));
  expect(long).toHaveLength(128);
  expect(long.endsWith(`:${"c".repeat(40)}`)).toBe(true);
  expect(childSessionId("a b", "c")).toBe("a-b:c");
});

test("a verdict session claim: the real session or a host-derived child of it; a hand-minted id is forged", () => {
  const accepted: Array<[NodeJS.ProcessEnv, string]> = [
    [{ OPENCODE_SESSION_ID: "ses_c" }, "ses_c"],
    [{ OPENCODE_SESSION_ID: "ses_c" }, "ses_l:ses_c"],
    [{ PI_SESSION_ID: "w1" }, "lead:w1"],
    // Subagents sharing the lead's shell: the hook-derived <lead>:<agent id>.
    [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "lead:a1"],
    [{ CODEX_THREAD_ID: "t-1" }, "t-1:agent-2"],
    [{ WORKIT_HOST: "cursor", WORKIT_SESSION_ID: "cur" }, "cur:sub"],
  ];
  for (const [env, claimed] of accepted)
    expect(sessionClaimRefusal(env, claimed), `${claimed} ${JSON.stringify(env)}`).toBeNull();
  const refused: Array<[NodeJS.ProcessEnv, string, string]> = [
    [{ OPENCODE_SESSION_ID: "ses_l" }, "ses_l-v61", "forged_session"],
    // OpenCode and Pi children have their own shell: a lead never mints one.
    [{ OPENCODE_SESSION_ID: "ses_l" }, "ses_l:ses_c", "forged_session"],
    [{ PI_SESSION_ID: "lead" }, "lead:w1", "forged_session"],
    [{ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" }, "lead-v1", "forged_session"],
    [{ CODEX_THREAD_ID: "t-1", WORKIT_SESSION_ID: "t-1-v1" }, "t-1-v1", "forged_session"],
    [{}, "anyone", "no host session"],
  ];
  for (const [env, claimed, error] of refused)
    expect(sessionClaimRefusal(env, claimed)?.error, claimed).toContain(error);
});
