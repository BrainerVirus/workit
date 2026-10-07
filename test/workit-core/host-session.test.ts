// Audit M5: each host's own shell session id stands in for WORKIT_SESSION_ID,
// so commits and verdicts made from Codex, OpenCode and Pi shells carry the
// session their hooks see.
import { expect, test } from "bun:test";
import { hostSessionFromEnv } from "@/packages/workit-core/src/host-session";
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
