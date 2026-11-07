// A standing order is scoped to one fanout: a lead running two fanouts at once
// must not hand fanout F1's orders to a worker of F2 (retro 2026-11-07: an
// order for scope-w2b reached a scope-w2 worker as a mid-run notice).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { CLAUDE_CODE_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/claude-code";
import { handleHook } from "@/packages/workit-core/src/hooks/handle";
import type { HookDecision, HookInput } from "@/packages/workit-core/src/hooks/protocol";
import { appendHookObserved, recordStanding } from "@/packages/workit-core/src/ledger";

const LEAD = "22222222-aaaa-bbbb-cccc-000000000002";
const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
};

/** A repo whose LEAD runs fanouts f1 and f2, one slice worktree each. */
const twoFanouts = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-standing-scope-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  );
  const fanouts = path.join(root, ".git", "workit", "fanouts");
  mkdirSync(fanouts, { recursive: true });
  const worktrees: Record<string, string> = {};
  for (const name of ["f1", "f2"]) {
    const branch = `feature/${name}-a`;
    writeFileSync(
      path.join(fanouts, `${name}.json`),
      JSON.stringify({
        v: 1,
        name,
        trunk: "main",
        slices: [{ id: "a", branch, base: "main", scope: ["src/**"] }],
        leadSession: LEAD,
        formerLeads: [],
      }),
    );
    worktrees[name] = path.join(root, "wt", name);
    git(root, "worktree", "add", "-q", "-b", branch, worktrees[name], "main");
  }
  return { root, f1: worktrees.f1, f2: worktrees.f2 };
};

const order = (root: string, fanout: string, what: string) => {
  const row = recordStanding(
    { cwd: root, actor: { host: "claude_code", session: LEAD, agentId: null } },
    { fanout, lead: LEAD, what },
  );
  if (!row.ok) throw new Error(row.error);
};

const call = (cwd: string, agentId: string): HookInput => ({
  host: "claude_code",
  cwd,
  session: {
    id: LEAD,
    agentId,
    agentType: "workit:implementer",
    parentId: LEAD,
  },
  permissionMode: "default",
  transcriptPath: null,
  event: { kind: "shell.pre", command: "ls", toolUseId: "t1" },
});

const start = (cwd: string, agentId: string): HookInput => ({
  ...call(cwd, agentId),
  event: {
    kind: "subagent.start",
    agentId,
    agentType: "workit:implementer",
    task: null,
  },
});

const text = (decision: HookDecision): string => (decision.kind === "context" ? decision.text : "");

test("Given an order scoped to fanout f1, When a worker on f2's slice branch calls a tool, Then it gets f2's order and not f1's", () => {
  const { root, f1, f2 } = twoFanouts();
  handleHook(start(f1, "w1"), deps);
  handleHook(start(f2, "w2"), deps);
  order(root, "f1", "only for f1 workers");
  order(root, "f2", "only for f2 workers");

  const toF2 = text(handleHook(call(f2, "w2"), deps));
  expect(toF2).toContain("new: only for f2 workers");
  expect(toF2).not.toContain("only for f1 workers");
  const toF1 = text(handleHook(call(f1, "w1"), deps));
  expect(toF1).toContain("new: only for f1 workers");
  expect(toF1).not.toContain("only for f2 workers");
});

test("Given a worker whose hooks run in the lead's checkout but which is bound to f2's worktree, When f1 gets an order, Then the worker is not told", () => {
  const { root, f2 } = twoFanouts();
  appendHookObserved(root, {
    type: "worktree.bound",
    actor: { host: "claude_code", session: LEAD, agentId: "w2" },
    agentType: "workit:implementer",
    worktree: f2,
  });
  handleHook(start(root, "w2"), deps);
  order(root, "f1", "only for f1 workers");
  expect(text(handleHook(call(root, "w2"), deps))).toBe("");
  order(root, "f2", "only for f2 workers");
  const toF2 = text(handleHook(call(root, "w2"), deps));
  expect(toF2).toContain("new: only for f2 workers");
  expect(toF2).not.toContain("f1");
});

test("Given a worker of the lead that no branch or worktree ties to one fanout, When either fanout gets an order, Then it still reaches that worker", () => {
  const { root } = twoFanouts();
  handleHook(start(root, "w0"), deps);
  order(root, "f1", "order one");
  order(root, "f2", "order two");
  const told = text(handleHook(call(root, "w0"), deps));
  expect(told).toContain("new: order one");
  expect(told).toContain("new: order two");
});

test("Given a worker seeded before it was tied to f2, When it is bound to f2 and the revision moves, Then f1's orders are not reported as lifted", () => {
  const { root, f2 } = twoFanouts();
  order(root, "f1", "order one");
  handleHook(start(root, "w2"), deps);
  appendHookObserved(root, {
    type: "worktree.bound",
    actor: { host: "claude_code", session: LEAD, agentId: "w2" },
    agentType: "workit:implementer",
    worktree: f2,
  });
  order(root, "f2", "order two");
  const told = text(handleHook(call(root, "w2"), deps));
  expect(told).toContain("new: order two");
  expect(told).not.toContain("no longer in force");
});
