import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { runGrant, type GrantDeps } from "@/packages/workit-cli/src/verbs/grant";

// `workit grant` (S16; D4, D15): agents may lower their own ceiling, but a
// raise needs the user at an interactive terminal typing the workspace name.

let configDir = "";
let checkout = "";
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-grant-config-");
  configDir = configHome.configDir;
});
afterAll(() => {
  configHome.restore();
});

const file = () => path.join(configDir, "workspaces.json");
const backup = () => `${file()}.bak`;

const writeWorkspace = (extra: Record<string, unknown> = {}) =>
  writeFileSync(
    file(),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${checkout.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          ...extra,
        },
      ],
    }),
  );
const entry = () => JSON.parse(readFileSync(file(), "utf8")).workspaces[0];

beforeEach(() => {
  checkout = mkdtempSync(path.join(os.tmpdir(), "wk-grant-checkout-"));
  mkdirSync(path.join(checkout, "repo"), { recursive: true });
  writeWorkspace();
});
afterEach(() => {
  for (const name of [file(), backup()]) rmSync(name, { force: true });
  rmSync(checkout, { recursive: true, force: true });
});

const headless: GrantDeps = {
  interactive: () => false,
  ask: async () => {
    throw new Error("a headless call must never prompt");
  },
};
const interactive = (answer: string, asked: string[] = []): GrantDeps => ({
  interactive: () => true,
  ask: async (question) => {
    asked.push(question);
    return answer;
  },
});

const run = async (argv: string[], deps: GrantDeps, env: NodeJS.ProcessEnv = {}, json = true) => {
  let stdout = "";
  const io: Io = {
    json,
    cwd: path.join(checkout, "repo"),
    // Never inherit the runner's env: it may carry an agent marker such as CLAUDECODE.
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await runGrant(argv, io, deps);
  return { code, json: () => JSON.parse(stdout), text: () => stdout };
};

test("grant show: a workspace without grants reports the D4 defaults", async () => {
  const result = await run(["show"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    workspace: "w",
    grants: { push: true, pr: true, merge: false, release: false, rerun: true },
    configured: [],
    source: "default",
    defaultEndpoint: "commit",
  });
  const named = await run(["show", "w"], headless);
  expect(named.json().data.workspaces).toEqual([
    expect.objectContaining({ name: "w", configured: [], grants: expect.any(Object) }),
  ]);
});

test("grant set: raising merge=verified headless is refused and nothing is written", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["set", "w", "merge=verified"], headless);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("grant_raise_refused");
  expect(result.json().unblock).toContain("workit grant set w merge=verified");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("grant set: an agent shell (CLAUDECODE=1) is refused even when interactive", async () => {
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await run(["set", "w", "merge=verified"], interactive("w", asked), {
    CLAUDECODE: "1",
  });
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("CLAUDECODE");
  expect(result.json().unblock).toContain("workit grant set w merge=verified");
  expect(asked).toEqual([]);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("grant set: interactive and confirmed by the workspace name writes the raise with a backup", async () => {
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await run(["set", "w", "merge=verified"], interactive("w\n", asked));
  expect(result.code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('workspace "w"');
  expect(result.json().data).toMatchObject({
    workspace: "w",
    grants: { merge: "verified" },
    configured: ["merge"],
    backup: backup(),
  });
  expect(entry().autonomy).toEqual({ merge: "verified" });
  expect(readFileSync(backup(), "utf8")).toBe(before);
});

test("grant set: interactive with the wrong confirmation writes nothing", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["set", "w", "merge=verified"], interactive("yes"));
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("not confirmed");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("grant set: Ctrl+C at the confirmation cancels cleanly (exit 130, nothing written)", async () => {
  const before = readFileSync(file(), "utf8");
  // The exact rejection readline/promises produces when ^C closes a pending
  // question (pinned against the real module in cli-prompt.test.ts).
  const ctrlC: GrantDeps = {
    interactive: () => true,
    ask: async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
  };
  let stdout = "";
  let stderr = "";
  const code = await runGrant(
    ["set", "w", "merge=verified"],
    {
      json: false,
      cwd: path.join(checkout, "repo"),
      env: {},
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    },
    ctrlC,
  );
  expect(code).toBe(130);
  expect(stderr.trim()).toBe("Cancelled.");
  expect(stderr).not.toContain("uncaught_failure");
  expect(stdout).toBe("");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("grant set: Ctrl+C under --json emits one cancelled envelope and exits 130", async () => {
  const before = readFileSync(file(), "utf8");
  const ctrlC: GrantDeps = {
    interactive: () => true,
    ask: async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
  };
  const result = await run(["set", "w", "merge=verified"], ctrlC);
  expect(result.code).toBe(130);
  expect(result.json()).toMatchObject({
    ok: false,
    code: "failed",
    error: "cancelled",
    data: { reason: "cancelled" },
  });
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("grant set: a prompt failure that is not a cancellation still propagates", async () => {
  const broken: GrantDeps = {
    interactive: () => true,
    ask: async () => {
      throw new Error("stdin exploded");
    },
  };
  await expect(run(["set", "w", "merge=verified"], broken)).rejects.toThrow("stdin exploded");
});

test("grant set: lowering (push=false) succeeds headless", async () => {
  const result = await run(["set", "w", "push=false"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data.grants).toMatchObject({ push: false });
  expect(entry().autonomy).toEqual({ push: false });
});

test("grant unset: removing a grant returns the kind to its default", async () => {
  writeWorkspace({ autonomy: { push: false, merge: "verified" } });
  const result = await run(["unset", "w", "merge"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ grants: { merge: false }, configured: ["push"] });
  expect(entry().autonomy).toEqual({ push: false });
  // Unsetting the last grant drops the autonomy block; unsetting push=false raises it back
  // to the default, which is refused headless.
  const raise = await run(["unset", "w", "push"], headless);
  expect(raise.code).toBe(3);
  expect(entry().autonomy).toEqual({ push: false });
});

test("grant set: defaultEndpoint=pr is a raise; commit and unset are allowed headless", async () => {
  const before = readFileSync(file(), "utf8");
  const raise = await run(["set", "w", "defaultEndpoint=pr"], headless);
  expect(raise.code).toBe(3);
  expect(raise.json().error).toContain("defaultEndpoint");
  expect(readFileSync(file(), "utf8")).toBe(before);

  writeWorkspace({ defaultEndpoint: "pr" });
  const lower = await run(["set", "w", "defaultEndpoint=commit"], headless);
  expect(lower.code).toBe(0);
  expect(lower.json().data.defaultEndpoint).toBe("commit");
  expect(entry().defaultEndpoint).toBeUndefined();

  writeWorkspace({ defaultEndpoint: "pr" });
  const unset = await run(["unset", "w", "defaultEndpoint"], headless);
  expect(unset.code).toBe(0);
  expect(entry().defaultEndpoint).toBeUndefined();
});

test("grant set: a legacy autoApprove is folded into autonomy on write", async () => {
  writeWorkspace({ autoApprove: ["push", "merge"] });
  const shown = await run(["show"], headless);
  expect(shown.json().data).toMatchObject({
    source: "autoApprove",
    // A standing merge approval keeps the verdict gate (review L1).
    grants: { push: true, merge: "verified" },
  });
  const result = await run(["set", "w", "pr=false"], headless);
  expect(result.code).toBe(0);
  expect(entry().autoApprove).toBeUndefined();
  expect(entry().autonomy).toEqual({ push: true, pr: false, merge: "verified" });
});

test("grant set: autonomy keys this version does not know are preserved", async () => {
  writeWorkspace({ autonomy: { push: true, deploy: "staging" } });
  const result = await run(["set", "w", "pr=false"], headless);
  expect(result.code).toBe(0);
  expect(entry().autonomy).toEqual({ deploy: "staging", push: true, pr: false });
});

test("grant show --json carries defaultEndpoint", async () => {
  writeWorkspace({ defaultEndpoint: "pr" });
  const shown = await run(["show"], headless);
  expect(shown.json().data.defaultEndpoint).toBe("pr");
});

test("verification=independent (user config, S17) tightens headless, makes normal-risk behavior need a non-author verdict, and loosening needs the user", async () => {
  const { TaskStore, WorkitCore } = await import("@/packages/workit-core/src/core");
  const repo = path.join(checkout, "repo");
  const core = new WorkitCore(new TaskStore(repo), {
    root: repo,
    caller: { host: "workit_cli", actor: "cli" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.task({ action: "start", objective: "verification mode" }).ok).toBe(true);
  const rules = () => {
    const preview = core.policy({ action: "preview", behaviorChange: true, riskTier: "normal" });
    if (!preview.ok || !preview.data) throw new Error("preview failed");
    return preview.data.requirements.map((item) => item.ruleId);
  };
  expect(rules()).toEqual(["check:test", "verdict:self"]);
  const tightened = await run(["set", "w", "verification=independent"], headless);
  expect(tightened.code).toBe(0);
  expect(entry().verification).toBe("independent");
  expect((await run(["show"], headless)).json().data.verification).toBe("independent");
  expect(rules()).toEqual(["check:test", "verdict:non-author"]);
  const loosened = await run(["set", "w", "verification=self"], headless);
  expect(loosened.code).not.toBe(0);
  expect(loosened.json()).toMatchObject({ ok: false });
  expect(entry().verification).toBe("independent");
  expect((await run(["unset", "w", "verification"], interactive("w"))).code).toBe(0);
  expect(entry().verification).toBeUndefined();
  expect(rules()).toEqual(["check:test", "verdict:self"]);
});

// Babysit endpoints: commit < pr < green < merged. `green` babysits the PR to
// merge-ready, `merged` also lands it but needs the merge grant to take effect.

test("grant set: each step up the endpoint ladder is a raise refused headless", async () => {
  for (const [from, to] of [
    ["commit", "pr"],
    ["pr", "green"],
    ["green", "merged"],
    ["commit", "merged"],
  ]) {
    writeWorkspace(from === "commit" ? {} : { defaultEndpoint: from });
    const before = readFileSync(file(), "utf8");
    const result = await run(["set", "w", `defaultEndpoint=${to}`], headless);
    expect(result.code, `${from} -> ${to}`).toBe(3);
    expect(result.json().error).toContain("grant_raise_refused: raising defaultEndpoint");
    expect(result.json().unblock).toContain(`workit grant set w defaultEndpoint=${to}`);
    expect(readFileSync(file(), "utf8")).toBe(before);
  }
});

test("grant set: a raise to green or merged writes once the user types the workspace name", async () => {
  const asked: string[] = [];
  const green = await run(["set", "w", "defaultEndpoint=green"], interactive("w", asked));
  expect(green.code).toBe(0);
  expect(asked[0]).toContain("defaultEndpoint=green");
  expect(entry().defaultEndpoint).toBe("green");

  const refused = await run(["set", "w", "defaultEndpoint=merged"], interactive("nope"));
  expect(refused.code).toBe(3);
  expect(entry().defaultEndpoint).toBe("green");

  const merged = await run(["set", "w", "defaultEndpoint=merged"], interactive("w"));
  expect(merged.code).toBe(0);
  expect(entry().defaultEndpoint).toBe("merged");
});

test("grant set: stepping the endpoint down is free headless", async () => {
  writeWorkspace({ defaultEndpoint: "merged" });
  const green = await run(["set", "w", "defaultEndpoint=green"], headless);
  expect(green.code).toBe(0);
  expect(entry().defaultEndpoint).toBe("green");
  const pr = await run(["set", "w", "defaultEndpoint=pr"], headless);
  expect(pr.code).toBe(0);
  expect(entry().defaultEndpoint).toBe("pr");
  writeWorkspace({ defaultEndpoint: "merged" });
  expect((await run(["unset", "w", "defaultEndpoint"], headless)).code).toBe(0);
  expect(entry().defaultEndpoint).toBeUndefined();
});

test("grant set: an endpoint outside commit|pr|green|merged is rejected and nothing is written", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["set", "w", "defaultEndpoint=deployed"], interactive("w"));
  expect(result.code).not.toBe(0);
  expect(result.json()).toMatchObject({ ok: false, code: "invalid_input" });
  expect(result.json().error).toContain("commit, pr, green, merged");
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("grant show: an unknown configured endpoint is reported, reads as commit, and keeps the other grants", async () => {
  writeWorkspace({ defaultEndpoint: "deployed", autonomy: { merge: "verified" } });
  const shown = await run(["show"], headless);
  expect(shown.code).toBe(0);
  expect(shown.json().data).toMatchObject({
    grants: { merge: "verified" },
    defaultEndpoint: "commit",
    effectiveEndpoint: "commit",
  });
  expect(shown.json().data.endpointIssue).toContain('"deployed"');
  const text = (await run(["show"], headless, {}, false)).text();
  expect(text).toContain('note: defaultEndpoint "deployed" is not one of');
  // The fallback is commit, so any endpoint above it is still a raise.
  const raise = await run(["set", "w", "defaultEndpoint=pr"], headless);
  expect(raise.code).toBe(3);
  // A lowering write keeps the value it does not understand untouched.
  expect((await run(["set", "w", "push=false"], headless)).code).toBe(0);
  expect(entry().defaultEndpoint).toBe("deployed");
});

test("grant show: merged without the merge grant is effectively green, in text and JSON", async () => {
  writeWorkspace({ defaultEndpoint: "merged" });
  const shown = await run(["show"], headless);
  expect(shown.json().data).toMatchObject({
    defaultEndpoint: "merged",
    effectiveEndpoint: "green",
    endpointReason: "merge grant missing",
  });
  const text = (await run(["show"], headless, {}, false)).text();
  expect(text).toContain("default endpoint: merged (effective: green, merge grant missing)");
  const all = await run(["show", "--all"], headless);
  expect(all.json().data.workspaces[0]).toMatchObject({
    defaultEndpoint: "merged",
    effectiveEndpoint: "green",
  });
});

test("grant show: merged with the merge grant is effective; green is never raised by the grant", async () => {
  writeWorkspace({ defaultEndpoint: "merged", autonomy: { merge: "verified" } });
  const merged = await run(["show"], headless);
  expect(merged.json().data).toMatchObject({
    defaultEndpoint: "merged",
    effectiveEndpoint: "merged",
  });
  expect(merged.json().data.endpointReason).toBeUndefined();
  expect((await run(["show"], headless, {}, false)).text()).toContain(
    "default endpoint: merged (an unnamed request stops at a merged PR",
  );

  writeWorkspace({ defaultEndpoint: "green", autonomy: { merge: true } });
  expect((await run(["show"], headless)).json().data).toMatchObject({
    defaultEndpoint: "green",
    effectiveEndpoint: "green",
  });
});

test("grant show: merged with a merge grant but no vcs.account stays green, like pr merge would", async () => {
  writeFileSync(
    file(),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${checkout.replaceAll("\\", "/")}/**`,
          defaultEndpoint: "merged",
          autonomy: { merge: "verified" },
        },
      ],
    }),
  );
  expect((await run(["show"], headless)).json().data).toMatchObject({
    effectiveEndpoint: "green",
    endpointReason: "vcs.account missing",
  });
});

test("grant set: lowering merge under a merged endpoint shows it falling back to green", async () => {
  writeWorkspace({ defaultEndpoint: "merged", autonomy: { merge: "verified" } });
  const lowered = await run(["set", "w", "merge=false"], headless);
  expect(lowered.code).toBe(0);
  expect(lowered.json().data).toMatchObject({
    defaultEndpoint: "merged",
    effectiveEndpoint: "green",
    endpointReason: "merge grant missing",
  });
});
