// S17 verification rules over the D18 ledger (user decision): at normal risk
// the author's own `--self` verdict satisfies `verdict:self` and is labelled
// self-reviewed, never verified; type-check-only never proves a behavior
// change; high risk needs an accepted independent `verified` live verdict.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { checkVerdicts, readLedger, recordVerdict } from "@/packages/workit-core/src/ledger";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const setup = (judgment: Record<string, unknown>) => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-verdicts-"));
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/v");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "lead" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const assessed = core.policy({ action: "assess", ...judgment });
  if (!assessed.ok || !assessed.data) throw new Error("assess failed");
  const verdict = (session: string, result: string, extra: Record<string, unknown> = {}) =>
    expect(
      recordVerdict(
        { cwd: root, actor: { host: "workit_cli", session, agentId: null } },
        { result, how: "ran it", ...extra },
      ).ok,
    ).toBe(true);
  const status = (ruleId: string) => {
    const view = core.task({ action: "inspect" });
    if (!view.ok) throw new Error(view.error);
    const id = assessed.data!.requirements.find((item) => item.ruleId === ruleId)!.id;
    return (
      view.data as { requirements: { requirementId: string; status: string }[] }
    ).requirements.find((item) => item.requirementId === id)!.status;
  };
  const review = () => {
    const ledger = readLedger(root);
    if (!ledger.ok) throw new Error("ledger unreadable");
    return checkVerdicts(root, "feature/v", ledger.value.rows).review;
  };
  return { verdict, status, review };
};

test("G normal-risk behavior change, W the author records type-check-only then a --self tests-verified verdict, T only the strong self verdict satisfies, labelled self-reviewed", () => {
  const { verdict, status, review } = setup({ behaviorChange: true, riskTier: "normal" });
  expect(status("verdict:self")).toBe("unsatisfied");
  verdict("lead", "type-check-only", { self: true });
  expect(status("verdict:self")).toBe("unsatisfied");
  expect(review()).toBe("unreviewed");
  verdict("lead", "tests-verified", { self: true });
  expect(status("verdict:self")).toBe("satisfied");
  expect(review()).toBe("self-reviewed");
});

test("G high risk, W an independent verified verdict of kind review, T not enough; a live one satisfies and reads verified", () => {
  const { verdict, status, review } = setup({ riskTier: "high", behaviorChange: true });
  verdict("lead", "verified", { self: true, kind: "live" });
  expect(status("verdict:verified")).toBe("unsatisfied");
  verdict("verifier-1", "verified", { kind: "review" });
  expect(status("verdict:verified")).toBe("unsatisfied");
  verdict("verifier-1", "verified", { kind: "live" });
  expect(status("verdict:verified")).toBe("satisfied");
  expect(review()).toBe("verified");
});
