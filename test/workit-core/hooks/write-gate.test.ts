// S17: the before-write gate. With no writer lease, a branch task's unmet
// before-write requirements deny writes where the host has a pre-write hook,
// with the exact unblock, and allow them once the requirement is met. Hosts
// without a write hook say the gate is advisory.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
  shellWrites,
} from "@/packages/workit-core/src/hooks/index";
import { recordDecision } from "@/packages/workit-core/src/ledger";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A git checkout on feature/x whose branch task carries `judgment`. */
const judged = (judgment: Record<string, unknown>) => {
  const root = tempRoot("workit-write-gate-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, "src"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const assessed = core.policy({ action: "assess", ...judgment });
  if (!assessed.ok) throw new Error(assessed.error);
  return { root, core };
};

const claude = (root: string, toolName: string, toolInput: Record<string, unknown>) =>
  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "pre-tool-use-write", root, {
      tool_name: toolName,
      tool_input: toolInput,
    }),
  ).json as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };

const opencode = (root: string, action: string, resources: string[]) => {
  const event = { action, resources, effect: "allow", message: undefined as string | undefined };
  evaluateShellPermission(root, event);
  return event;
};

const decide = (root: string) =>
  expect(
    recordDecision(
      { cwd: root, actor: { host: "workit_cli", session: "lead", agentId: null } },
      { what: "option A", why: "the user picked A" },
    ).ok,
  ).toBe(true);

test("G an open product choice, W Claude Code edits code, T denied with the decision unblock until the decision is recorded", () => {
  const { root } = judged({ productChoiceOpen: "yes" });
  const denied = claude(root, "Write", { file_path: "src/a.ts", content: "x" });
  expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
  expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain(
    'workit ledger decision "<choice>" --why "<reason>"',
  );
  for (const tool of ["Edit", "MultiEdit"])
    expect(
      claude(root, tool, { file_path: "src/a.ts" }).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
  // Shell writes are gated too; reads and Workit's own commands are not.
  expect(
    claude(root, "Bash", { command: "echo x > src/a.ts" }).hookSpecificOutput?.permissionDecision,
  ).toBe("deny");
  expect(claude(root, "Bash", { command: "ls -la src" }).hookSpecificOutput).toBeUndefined();
  expect(
    claude(root, "Bash", { command: 'workit ledger decision "a > b" --why "c"' })
      .hookSpecificOutput,
  ).toBeUndefined();
  // Plans, docs and Markdown stay writable.
  expect(
    claude(root, "Write", { file_path: "docs/plans/x.ts" }).hookSpecificOutput,
  ).toBeUndefined();
  expect(claude(root, "Write", { file_path: "NOTES.md" }).hookSpecificOutput).toBeUndefined();
  decide(root);
  expect(claude(root, "Write", { file_path: "src/a.ts" }).hookSpecificOutput).toBeUndefined();
});

test("G a needed plan, W OpenCode edits code, T denied with the plan unblock until the plan is recorded", () => {
  const { root, core } = judged({ needsPlan: true });
  const denied = opencode(root, "edit", ["src/a.ts"]);
  expect(denied.effect).toBe("deny");
  expect(denied.message).toContain("workit policy assess --ref <path>");
  expect(opencode(root, "shell", ["sed -i s/a/b/ src/a.ts"]).effect).toBe("deny");
  expect(opencode(root, "shell", ["git status"]).effect).toBe("allow");
  expect(opencode(root, "edit", ["docs/plan.md"]).effect).toBe("allow");
  writeFileSync(path.join(root, "docs-plan.md"), "# plan\n");
  // A ref to a missing file does not count; an existing one does.
  expect(core.policy({ action: "assess", refs: ["docs/missing.md"] }).ok).toBe(true);
  expect(opencode(root, "edit", ["src/a.ts"]).effect).toBe("deny");
  expect(core.policy({ action: "assess", refs: "docs-plan.md" }).ok).toBe(true);
  expect(opencode(root, "edit", ["src/a.ts"]).effect).toBe("allow");
});

test("G a high-risk judgment, T Cursor and Pi deny code writes before a plan; trivial work is never gated", () => {
  const { root } = judged({ riskTier: "high" });
  const cursor = dispatchHook(cursorAdapter, fixture("cursor", "pre-tool-use", root));
  expect(cursor.exitCode).toBe(2);
  expect(cursor.json).toMatchObject({ permission: "deny" });
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  expect(
    enforceToolPolicy({ toolName: "edit", input: { path: "src/a.ts" } } as never, ctx),
  ).toMatchObject({ block: true, reason: expect.stringContaining("plan") });
  expect(
    enforceToolPolicy({ toolName: "write", input: { path: "docs/plan.md" } } as never, ctx),
  ).toBeUndefined();
  const trivial = judged({ riskTier: "trivial", behaviorChange: true });
  expect(
    claude(trivial.root, "Write", { file_path: "src/a.ts" }).hookSpecificOutput,
  ).toBeUndefined();
});

test("G Codex (no pre-write hook), T the session says the gate is advisory and edits are not denied", () => {
  const { root } = judged({ productChoiceOpen: true });
  const start = dispatchHook(codexAdapter, fixture("codex", "session-start", root), {}).json as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  expect(start.hookSpecificOutput?.additionalContext).toContain("advisory");
  const patch = dispatchHook(codexAdapter, fixture("codex", "pre-tool-use-apply-patch", root), {})
    .json as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(patch.hookSpecificOutput?.permissionDecision).toBeUndefined();
  const claudeStart = dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "session-start-compact", root),
  ).json as { hookSpecificOutput?: { additionalContext?: string } };
  expect(claudeStart.hookSpecificOutput?.additionalContext).not.toContain("advisory here");
});

test("shell write recognition is narrow: redirects, editors-in-place and mutating git, never quotes", () => {
  for (const command of [
    "echo x > a.ts",
    "cat <<EOF >> b.ts",
    "sed -i 's/a/b/' a.ts",
    "rm -rf build",
    "git commit -m x",
    "printf x | tee a.ts",
  ])
    expect(shellWrites(command).writes, command).toBe(true);
  for (const command of [
    "ls -la",
    "git status",
    "bun test 2>&1",
    "echo 'a > b'",
    "grep -r x src > /dev/null",
    "workit check test",
  ])
    expect(shellWrites(command).writes, command).toBe(false);
  expect(shellWrites("echo x > docs/plan.md")).toEqual({ writes: true, targets: ["docs/plan.md"] });
});
