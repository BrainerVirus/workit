// Audit M5: each host's own shell session id stands in for WORKIT_SESSION_ID,
// so commits and verdicts made from Codex, OpenCode and Pi shells carry the
// session their hooks see.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

/** A fresh per-user state dir (where issued ids live) for one test; returns its path. */
function freshState(cwd: string): string {
  const state = path.join(cwd, "state");
  process.env.WORKFLOW_TOOLKIT_STATE = state;
  return state;
}

const runState = process.env.WORKFLOW_TOOLKIT_STATE;
const restoreState = () => {
  if (runState === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = runState;
};

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
  freshState(cwd);
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
    // The record is per lead, not per repository: it holds without a workspace too (#294).
    expect(sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1:agent-2", undefined)).toBeNull();
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the issued-session record stays bounded per lead and keeps the newest ids", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  freshState(cwd);
  try {
    for (let i = 0; i < 70; i++) recordIssuedSession(cwd, "lead", `lead:a${i}`);
    const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };
    expect(sessionClaimRefusal(env, "lead:a69", cwd)).toBeNull();
    const kept = Array.from({ length: 70 }, (_, i) => sessionClaimRefusal(env, `lead:a${i}`, cwd));
    expect(kept.filter((refusal) => refusal === null)).toHaveLength(64);
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the prune never drops the id just issued, even when it is the oldest by mtime", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  const state = freshState(cwd);
  try {
    for (let i = 0; i < 64; i++) recordIssuedSession(cwd, "lead", `lead:a${i}`);
    // Clock skew: every recorded file looks newer than the next write.
    const future = new Date(Date.now() + 3_600_000);
    for (const dir of readdirSync(path.join(state, "issued"))) {
      const leadDir = path.join(state, "issued", dir);
      for (const file of readdirSync(leadDir)) utimesSync(path.join(leadDir, file), future, future);
    }
    recordIssuedSession(cwd, "lead", "lead:newest");
    const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };
    expect(sessionClaimRefusal(env, "lead:newest", cwd)).toBeNull();
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a host that always sets its own variable, named by WORKIT_HOST without it, cannot vouch for any id; WORKIT_HOST=cli is no host", () => {
  // `env -u OPENCODE_SESSION_ID` / `env -u CODEX_THREAD_ID` in that host's shell.
  for (const env of [
    { WORKIT_HOST: "opencode", WORKIT_SESSION_ID: "ses_lead-v1" },
    { WORKIT_HOST: "opencode" },
    { WORKIT_HOST: "codex_cli", WORKIT_SESSION_ID: "t-1-v1" },
    { WORKIT_HOST: "codex_desktop" },
    { WORKIT_HOST: "pi", WORKIT_SESSION_ID: "pi-lead-v1" },
  ])
    expect(sessionClaimRefusal(env, "anyone")?.error, JSON.stringify(env)).toContain(
      "forged_session",
    );
  expect(realHostSession({ WORKIT_HOST: "cli", WORKIT_SESSION_ID: "c" }).kind).toBe("none");
  expect(sessionClaimRefusal({ WORKIT_HOST: "cli", WORKIT_SESSION_ID: "c" }, "anyone")).toBeNull();
});

test("Given a well-formed subagent id and no issued-id record on the machine, Then the refusal names the stale plugin hook and its update", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  freshState(cwd);
  try {
    const claude = sessionClaimRefusal(
      { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" },
      "lead:agent-1",
      cwd,
    );
    expect(claude?.error).toContain(
      "no SubagentStart hook has recorded an issued id for this lead",
    );
    expect(claude?.unblock).toContain("older than this CLI");
    expect(claude?.unblock).toContain("claude plugin update workit@workit");
    expect(claude?.unblock).toContain("relaunch the verifier");
    const codex = sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1:agent-1", cwd);
    expect(codex?.unblock).toContain("codex plugin add workit@workit");
    // Another lead's record says nothing about this one's hook.
    recordIssuedSession(cwd, "other-lead", "other-lead:a");
    expect(sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1:agent-1", cwd)?.unblock).toContain(
      "older than this CLI",
    );
    // Once this lead's hook recorded an id, a missing one is just not issued.
    recordIssuedSession(cwd, "t-1", "t-1:agent-9");
    const after = sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1:agent-1", cwd);
    expect(after?.unblock).not.toContain("older than this CLI");
    // A malformed claim never blames the plugin.
    const invented = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
    try {
      expect(
        sessionClaimRefusal({ CODEX_THREAD_ID: "t-1" }, "t-1-v1", invented)?.unblock,
      ).not.toContain("older than this CLI");
    } finally {
      rmSync(invented, { recursive: true, force: true });
    }
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Given a lead started in repo A, When its verifier records a verdict from repo B or a plain directory, Then the hook-issued id is accepted there too (#294)", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  freshState(cwd);
  try {
    const repoA = path.join(cwd, "ui-kit");
    const repoB = path.join(cwd, "frontend");
    mkdirSync(repoA);
    mkdirSync(repoB);
    recordIssuedSession(repoA, "lead", "lead:verifier-1");
    // Nothing is written into the lead's repository any more.
    expect(existsSync(path.join(repoA, ".workit", "hooks", "issued"))).toBe(false);
    const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };
    // Other repositories first: none of them may depend on a read in repoA.
    for (const where of [repoB, cwd, repoA])
      expect(sessionClaimRefusal(env, "lead:verifier-1", where), where).toBeNull();
    // Still bound to the lead that was issued the id, and never to an invented one.
    expect(
      sessionClaimRefusal(
        { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "other" },
        "other:verifier-1",
        repoB,
      )?.error,
    ).toContain("forged_session");
    expect(sessionClaimRefusal(env, "lead:verifier-2", repoB)?.error).toContain("forged_session");
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an id an 8.10-8.12 hook recorded in the repository's store is moved to the per-user registry and the old directory removed", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  freshState(cwd);
  try {
    // The old layout: <store>/hooks/issued/<sha256(lead)[:32]>/<sha256(id)[:32]>.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
    const dir = path.join(cwd, ".workit", "hooks", "issued", hash("lead"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, hash("lead:old-1")), "workit-issued-sessions/1");
    const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead" };
    expect(sessionClaimRefusal(env, "lead:old-1", cwd)).toBeNull();
    expect(existsSync(path.join(cwd, ".workit", "hooks", "issued"))).toBe(false);
    // Once moved, it counts from any directory, and invented ids still do not.
    expect(sessionClaimRefusal(env, "lead:old-1", os.tmpdir())).toBeNull();
    expect(sessionClaimRefusal(env, "lead:old-2", cwd)?.error).toContain("forged_session");
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a migration moves every readable lead, skips stray entries, and keeps ids an old hook writes after it", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issued-"));
  freshState(cwd);
  try {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
    const old = path.join(cwd, ".workit", "hooks", "issued");
    for (const lead of ["a", "b"]) {
      mkdirSync(path.join(old, hash(lead)), { recursive: true });
      writeFileSync(path.join(old, hash(lead), hash(`${lead}:x`)), "workit-issued-sessions/1");
    }
    writeFileSync(path.join(old, "stray"), "");
    const env = (lead: string) => ({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: lead });
    expect(sessionClaimRefusal(env("a"), "a:x", cwd)).toBeNull();
    expect(sessionClaimRefusal(env("b"), "b:x", os.tmpdir())).toBeNull();
    // The stray entry keeps the old root; the next old-hook write is migrated later.
    mkdirSync(path.join(old, hash("c")), { recursive: true });
    writeFileSync(path.join(old, hash("c"), hash("c:x")), "workit-issued-sessions/1");
    expect(sessionClaimRefusal(env("c"), "c:x", cwd)).toBeNull();
  } finally {
    restoreState();
    rmSync(cwd, { recursive: true, force: true });
  }
});
