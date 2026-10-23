// S17 verification rules over the D18 ledger (user decision): at normal risk
// the author's own `--self` verdict satisfies `verdict:self` and is labelled
// self-reviewed, never verified; type-check-only never proves a behavior
// change; high risk needs an accepted independent `verified` live verdict.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { checkVerdicts, readLedger, recordVerdict } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";

const roots: string[] = [];
let home: ConfigHome;
beforeAll(() => {
  home = useConfigHome("workit-verdicts-home-");
});
afterAll(() => {
  home.restore();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A task on feature/v, branched from main, whose commit adds `files`, under
 * a workspace with `verification` (unset: the proportional default).
 */
const setup = (
  judgment: Record<string, unknown>,
  verification?: "self" | "independent",
  files: Record<string, string> = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-verdicts-"));
  roots.push(root);
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "v",
          glob: `${root.replaceAll("\\", "/")}/**`,
          ...(verification ? { verification } : {}),
        },
      ],
    }),
  );
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("switch", "-q", "-c", "feature/v");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "change");
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
  const { verdict, status, review } = setup({ behaviorChange: true, riskTier: "normal" }, "self");
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

// #333: under the proportional default the lane of the branch decides `verdict:lane`.

test("G proportional and a small change (lane self), W the author records a --self verdict, T verdict:lane is satisfied", () => {
  const { verdict, status } = setup({ behaviorChange: true, riskTier: "normal" }, undefined, {
    "src/a.ts": "export const a = 1;\n",
  });
  expect(status("verdict:lane")).toBe("unsatisfied");
  verdict("lead", "tests-verified", { self: true });
  expect(status("verdict:lane")).toBe("satisfied");
});

test("G proportional and a docs-only change (lane none), T verdict:lane is satisfied with no verdict", () => {
  const { status } = setup({ behaviorChange: true, riskTier: "normal" }, undefined, {
    "docs/guide.md": "# Guide\n",
  });
  expect(status("verdict:lane")).toBe("satisfied");
});

test("G proportional and a risk-path change (lane full), W only a --self verdict, T unsatisfied until a non-author verdict", () => {
  const { verdict, status } = setup({ behaviorChange: true, riskTier: "normal" }, undefined, {
    "src/auth/login.ts": "export const login = 1;\n",
  });
  verdict("lead", "tests-verified", { self: true });
  expect(status("verdict:lane")).toBe("unsatisfied");
  verdict("verifier-1", "verified");
  expect(status("verdict:lane")).toBe("satisfied");
});
