import { describe, expect, test } from "bun:test";
import { logTail, redactText, shortBody } from "@/packages/workit-core/src/forge/redact";
import {
  babysitAction,
  nextAction,
  pollDelay,
  waitVerdict,
  type PrStatusDoc,
} from "@/packages/workit-core/src/forge/report";
import { useForgeHarness } from "./shared";

useForgeHarness();

describe("S10 redaction and verdicts", () => {
  // Every reviewer example; secrets are assembled at runtime so no literal
  // token-shaped string sits in the repository.
  const a = (n: number, c = "a") => c.repeat(n);
  // Prefixes are joined at runtime so secret scanners see no token literal.
  const GL_PAT = ["gl", "pat-"].join("");
  const REDACTION_CASES: Array<[string, string, string]> = [
    ["ghp", `token ghp_${a(36)}`, `ghp_${a(36)}`],
    [
      "ghs in url",
      `https://x-access-token:ghs_${a(36, "B")}@github.com/o/r.git`,
      `ghs_${a(36, "B")}`,
    ],
    ["github_pat", `github_pat_11ABCDEFG0${a(70, "x")}`, a(70, "x")],
    ["glpat", `${GL_PAT}abcdEFGH1234ijkl5678`, "abcdEFGH1234ijkl5678"],
    ["glrt", `glrt-t1_${a(20, "Z")}`, a(20, "Z")],
    ["gldt", `gldt-${a(20, "q")}`, a(20, "q")],
    [
      "CI_JOB_TOKEN glcbt",
      `CI_JOB_TOKEN=${["gl", "cbt-"].join("")}64_abcdefghijklmnopqrstu`,
      "abcdefghijklmnopqrstu",
    ],
    ["aws id", `AKIA${"IOSFODNN7EXAMPLE"}`, "IOSFODNN7EXAMPLE"],
    [
      "aws secret env",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI",
    ],
    [
      "aws secret yaml",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI",
    ],
    ["GH_TOKEN env", `GH_TOKEN=${a(5, "deadbeef")}`, "deadbeefdeadbeef"],
    ["NPM_TOKEN env", "NPM_TOKEN=abcdef0123456789abcdef", "abcdef0123456789abcdef"],
    ["DB_PASSWORD env", "DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
    ["MY_API_KEY env", "MY_API_KEY=abcdef0123456789", "abcdef0123456789"],
    ["DJANGO_SECRET_KEY env", "DJANGO_SECRET_KEY=abcdef0123456789xyz", "abcdef0123456789xyz"],
    ["json access_token", '{"access_token": "abcdefghijklmnop1234"}', "abcdefghijklmnop1234"],
    ["json password", '"password":"s3cr3tpassw0rd"', "s3cr3tpassw0rd"],
    [
      "jwt",
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
      "dozjgNryP4J3",
    ],
    ["url user-only token", `https://ghp_${a(36, "c")}@github.com/o/r`, a(36, "c")],
    [
      "url oauth2",
      `https://oauth2:${GL_PAT}abcdefghijklmnopqrst@gitlab.com/g/p.git`,
      "abcdefghijklmnopqrst",
    ],
    ["url password with %40", "https://user:p%40ss@host/x", "p%40ss"],
    ["url password with colon", "postgres://admin:pa:ss@db:5432/x", "pa:ss"],
    ["basic auth header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["x-api-key header", "X-Api-Key: 0123456789abcdef0123", "0123456789abcdef0123"],
    ["PRIVATE-TOKEN header", "PRIVATE-TOKEN: abcdefghijklmnop", "abcdefghijklmnop"],
    ["curl -u", "curl -u admin:SuperSecret123 https://x", "SuperSecret123"],
    [
      "base64 blob",
      "echo dXNlcjpnaHBfYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh | base64 -d",
      "dXNlcjpnaHBf",
    ],
    ["slack webhook", `https://hooks.slack.com/services/T000/B000/${a(24, "X")}`, a(24, "X")],
    ["google api key", `AIza${"SyA-1234567890abcdefghijklmnopqrstu"}`, "SyA-1234567890"],
    ["stripe live", `sk_live_${a(24)}`, a(24)],
    [
      "azure AccountKey",
      "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc123def456ghi789==;",
      "abc123def456ghi789",
    ],
    [
      "private key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXk",
    ],
    [
      "truncated private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz",
      "MIIEowIBAAKCAQEAxyz",
    ],
    ["ansi-split token", `ghp_\u001b[0m${a(36)}`, a(36)],
    ["bearer", `Authorization: Bearer ${a(4, "abcdef")}`, a(4, "abcdef")],
    ["quoted value with spaces", 'password: "correct horse battery"', "correct horse"],
    ["netrc", "machine api.github.com login bot password s3cr3tv4lue", "s3cr3tv4lue"],
    ["netrc multiline", "login bot\npassword multiline_secret", "multiline_secret"],
    [
      "azure sas sig",
      "https://a.blob.core.windows.net/c/f?sv=2022-11-02&sig=AbCdEf%2Bgh%3D&se=2026",
      "AbCdEf",
    ],
    ["sshpass -p", "sshpass -p hunter22 ssh host", "hunter22"],
    ["mysql -p", "mysql -u root -pSuperSecret db", "SuperSecret"],
  ];
  // Every documented GitLab token prefix (prefixes joined at runtime).
  // Every prefix in GitLab's token table (docs.gitlab.com/security/tokens/#token-prefixes).
  for (const prefix of [
    "glptt",
    "glft",
    "gloas",
    "glsoat",
    "glrtr",
    "glimt",
    "glagent",
    "glwt",
    "glffct",
  ])
    REDACTION_CASES.push([prefix, `${[prefix, "-"].join("")}${a(24, "k")}`, a(24, "k")]);
  REDACTION_CASES.push([
    "gitlab session cookie",
    `curl -b ${["_gitlab", "_session="].join("")}${a(32, "f")} https://gitlab.example.com`,
    a(32, "f"),
  ]);
  for (const [label, input, secret] of REDACTION_CASES)
    test(`redacts ${label}`, () => {
      const out = redactText(input);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED");
    });

  test("Given CI log words that start with gl and a dash, When redacted, Then they survive while real GitLab tokens do not", () => {
    const log = [
      "running global-setup-teardown-hook for suite",
      "loaded glob-pattern-matcher-for-workspaces",
      "glyph-rendering-benchmark-results ok",
    ].join("\n");
    expect(redactText(log)).toBe(log);
    expect(logTail(log, 10).join("\n")).toContain("global-setup-teardown-hook");
    const token = `${GL_PAT}${a(20, "Q")}`;
    expect(redactText(`global-setup-teardown-hook ${token}`)).toBe(
      "global-setup-teardown-hook [REDACTED]",
    );
    // Shorter than any GitLab token body (20+): a word, not a secret.
    const word = `${["glrt", "-"].join("")}runner-registration`;
    expect(redactText(`step ${word} done`)).toBe(`step ${word} done`);
  });

  test("ordinary log text, shas and prose survive redaction", () => {
    for (const keep of [
      "token validation failed for user",
      "Author: reviewer",
      "HEAD is now at 209cdeb890ea6b264f50fa34ef6f160549b7dd8b fix(core): x",
      "error: expect(received).toEqual(expected)",
      "(fail) Given three processes each making 40 writes",
      "password reset email sent",
      "mysql -u root -p db",
    ])
      expect(redactText(keep)).toBe(keep);
  });

  test("a private key split across log lines is gone from the tail; secrets in comments too", () => {
    const keylog = [
      "start",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxyz",
      "MIIEowIBAAKCAQEAabc",
      "-----END RSA PRIVATE KEY-----",
      "done",
    ].join("\n");
    expect(logTail(keylog, 4).join("\n")).not.toMatch(/MIIEow/u);
    expect(shortBody(`use token ghp_${a(36, "z")} please`)).toBe("use token [REDACTED] please");
  });

  test("a bare carriage return keeps what the terminal finally showed", () => {
    expect(logTail("10%\r50%\r100% done\nerror: x\r\n", 5)).toEqual(["100% done", "error: x"]);
  });

  test("the log view leads with the region around the first real error, then the end", () => {
    const log = [
      ...Array.from({ length: 30 }, (_, i) => `(pass) case ${i} handles a failed reservation`),
      "setup line",
      "src/a.test.ts:",
      "error: expect(received).toBe(expected)",
      "Expected: 0",
      "Received: 1",
      ...Array.from({ length: 50 }, (_, i) => `noise ${i}`),
      " 1 fail",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
    ].join("\n");
    const view = logTail(log, 12);
    expect(view.length).toBeLessThanOrEqual(12);
    expect(view.slice(0, 3)).toEqual([
      "(pass) case 29 handles a failed reservation",
      "setup line",
      "src/a.test.ts:",
    ]);
    expect(view).toContain("error: expect(received).toBe(expected)");
    expect(view).toContain("…");
    expect(view.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(view).not.toContain("Post job cleanup.");
  });

  test("comment bodies are capped at 300 chars and flattened", () => {
    expect(shortBody("x".repeat(400))).toHaveLength(300);
    expect(shortBody("line one\n\n  line two")).toBe("line one line two");
  });

  test("next follows the pstack priority: conflicts > rebase > threads > CI", () => {
    const base = {
      forge: "github" as const,
      state: "open" as const,
      draft: false,
      conflicts: false,
      rebaseRequired: false,
      mergeable: "yes" as const,
      mergeState: "clean",
      inMergeQueue: false,
      reviewDecision: null,
      threads: 0,
    };
    expect(
      nextAction({
        ...base,
        conflicts: true,
        rebaseRequired: true,
        threads: 2,
        checks: "failing",
      }),
    ).toBe("RESOLVE_CONFLICTS");
    expect(
      nextAction({
        ...base,
        rebaseRequired: true,
        threads: 2,
        checks: "failing",
      }),
    ).toBe("REBASE");
    expect(nextAction({ ...base, threads: 1, checks: "failing" })).toBe("RESOLVE_THREADS");
    expect(nextAction({ ...base, checks: "failing" })).toBe("FIX_CI");
    expect(nextAction({ ...base, checks: "pending" })).toBe("WAITING_CI");
    expect(nextAction({ ...base, checks: "none" })).toBe("READY");
    expect(
      nextAction({
        ...base,
        state: "merged",
        conflicts: true,
        checks: "failing",
      }),
    ).toBe("MERGED");
    expect(nextAction({ ...base, state: "closed", checks: "passing" })).toBe("CLOSED");
    const green = { ...base, checks: "passing" as const };
    expect(
      nextAction({
        ...green,
        reviewDecision: "changes_requested",
        draft: true,
      }),
    ).toBe("ADDRESS_REVIEW");
    expect(nextAction({ ...green, reviewDecision: "review_required" })).toBe("REVIEW");
    expect(nextAction({ ...green, draft: true })).toBe("MARK_READY");
    expect(nextAction({ ...green, inMergeQueue: true })).toBe("IN_MERGE_QUEUE");
    expect(nextAction({ ...green, mergeState: "blocked" })).toBe("NOT_MERGEABLE");
    expect(nextAction({ ...green, mergeable: "unknown" })).toBe("NOT_MERGEABLE");
    expect(nextAction({ ...green, mergeState: "unstable" })).toBe("READY");
    const gl = { ...green, forge: "gitlab" as const };
    expect(nextAction({ ...gl, mergeState: "mergeable" })).toBe("READY");
    expect(nextAction({ ...gl, mergeState: "not_approved" })).toBe("REVIEW");
    expect(nextAction({ ...gl, mergeState: "discussions_not_resolved" })).toBe("RESOLVE_THREADS");
    expect(nextAction({ ...gl, checks: "none", mergeState: "ci_must_pass" })).toBe("WAITING_CI");
    expect(nextAction({ ...gl, mergeState: "draft_status" })).toBe("MARK_READY");
    expect(nextAction({ ...gl, mergeState: "jira_association_missing" })).toBe("NOT_MERGEABLE");
  });

  test("babysit maps next to one step; only a forge-required update rewrites the branch", () => {
    expect(babysitAction("MERGED", "merged", false)).toBe("merged");
    expect(babysitAction("CLOSED", "closed", false)).toBeNull();
    expect(babysitAction("RESOLVE_CONFLICTS", "conflicts", false)).toBe("update-branch");
    expect(babysitAction("REBASE", "behind_base_required", false)).toBe("update-branch");
    expect(babysitAction("RESOLVE_THREADS", "unresolved_threads", true)).toBe("address-threads");
    expect(babysitAction("ADDRESS_REVIEW", "changes_requested", false)).toBe("address-threads");
    expect(babysitAction("FIX_CI", "checks_failing", true)).toBe("fix-ci");
    expect(babysitAction("WAITING_CI", "checks_pending", false)).toBe("wait");
    // CI is done but the forge is still deciding: not a `ci wait` (it would return at once).
    expect(babysitAction("IN_MERGE_QUEUE", "in_merge_queue", false)).toBe("wait-forge");
    expect(babysitAction("NOT_MERGEABLE", "mergeability_unknown", false)).toBe("wait-forge");
    // A draft is marked ready even when a pending review sorts ahead of MARK_READY.
    expect(babysitAction("MARK_READY", "draft", true)).toBe("mark-ready");
    expect(babysitAction("REVIEW", "review_required", true)).toBe("mark-ready");
    // Nothing left for the agent: a human approval or a forge rule decides.
    expect(babysitAction("REVIEW", "review_required", false)).toBe("ready");
    expect(babysitAction("NOT_MERGEABLE", "merge_state_blocked", false)).toBe("ready");
    expect(babysitAction("READY", null, false)).toBe("ready");
  });

  test("ci wait verdicts and the deterministic backoff", () => {
    const doc = (checks: PrStatusDoc["checks"]["state"], extra: Partial<PrStatusDoc> = {}) =>
      ({
        state: "open",
        conflicts: false,
        base: "main",
        head: { branch: "b", sha: "abc123", localSha: null, pushed: null },
        mergeState: "clean",
        checks: {
          state: checks,
          failing: [],
          pending: [],
          passing: 0,
          missingRequired: [],
        },
        ...extra,
      }) as PrStatusDoc;
    expect(waitVerdict(doc("passing"), { elapsedMs: 0 })).toEqual({
      state: "ready",
      reason: "checks_passing",
    });
    expect(waitVerdict(doc("failing"), { elapsedMs: 0 }).state).toBe("failed");
    // Fail-fast is pinned: a failing gating check ends the wait with others still running.
    expect(
      waitVerdict(
        doc("failing", {
          checks: { ...doc("failing").checks, pending: ["slow"] },
        }),
        {
          elapsedMs: 0,
        },
      ).state,
    ).toBe("failed");
    // Gating checks pass while another check runs (#440): keep waiting.
    expect(
      waitVerdict(
        doc("passing", {
          checks: { ...doc("passing").checks, pending: ["slow"] },
        }),
        {
          elapsedMs: 0,
        },
      ),
    ).toEqual({ state: "waiting", reason: "checks_pending" });
    // No checks registered yet inside the grace: keep waiting.
    expect(waitVerdict(doc("none"), { elapsedMs: 5_000 }).state).toBe("waiting");
    expect(waitVerdict(doc("pending"), { elapsedMs: 0 }).state).toBe("waiting");
    expect(waitVerdict(doc("passing"), { head: "def", elapsedMs: 0 })).toEqual({
      state: "waiting",
      reason: "head_mismatch",
    });
    expect(waitVerdict(doc("none"), { elapsedMs: 0 }).reason).toBe("no_checks_yet");
    expect(waitVerdict(doc("none"), { elapsedMs: 100_000 })).toEqual({
      state: "ready",
      reason: "no_checks",
    });
    expect(waitVerdict(doc("none", { conflicts: true }), { elapsedMs: 0 }).state).toBe("blocked");
    expect(waitVerdict(doc("passing", { state: "closed" }), { elapsedMs: 0 })).toMatchObject({
      state: "blocked",
      reason: "pr_closed",
    });
    expect(waitVerdict(doc("passing", { state: "merged" }), { elapsedMs: 0 }).state).toBe(
      "blocked",
    );
    expect([0, 1, 2, 3, 4, 5].map((poll) => pollDelay(30_000, poll))).toEqual([
      30_000, 45_000, 67_500, 101_250, 120_000, 120_000,
    ]);
  });
});
