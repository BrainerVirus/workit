import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mintDelegateToken,
  prepareFlowState,
  readFlowState,
  recordMenuChoice,
  revokeDelegateToken,
  transitionPlan,
  transitionSpec,
  validateDelegateToken,
} from "../../packages/workit-core/src/core/flow-state";
import { cursorEvidence } from "../workit-core/flow-fixtures";
import { cursorMutationContext } from "../../packages/workit-cursor/mcp/flow-evidence";

const SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n\n### Task 2: Do the next thing\n\n- [ ] **Step 1:** do it\n`;

const flowJson = (root: string, slug: string) => path.join(root, "docs", slug, "sdd", "flow.json");

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-delegation-"));
  const slug = "dlg-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), PLAN(slug));
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  if (!transitionSpec(root, slug, spec, cursorEvidence()).ok) throw new Error("spec transition");
  if (!transitionPlan(root, slug, plan, cursorEvidence()).ok) throw new Error("plan transition");
  const menu = recordMenuChoice(root, slug, plan, "subagent-driven", cursorEvidence());
  if (!menu.ok || !("coordinator_lease" in menu) || !menu.coordinator_lease) {
    throw new Error("coordinator lease not returned");
  }
  const lease: string = menu.coordinator_lease;
  return {
    root,
    slug,
    plan,
    lease,
    mint: (taskId: number) => mintDelegateToken(root, slug, plan, taskId, lease),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test(
  "cursorMutationContext without a token returns the deterministic coordinator context",
  () => {
    const f = fixture();
    try {
      const identity = cursorMutationContext(f.root);
      expect(identity.ok).toBe(true);
      if (identity.ok) {
        expect(identity.context).toEqual({
          hostWorkspace: f.root,
          role: "coordinator",
          sessionId: `cursor:${f.root}`,
          taskIdentity: undefined,
        });
      }
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);

test(
  "a valid token yields delegated context with taskIdentity String(task_id)",
  () => {
    const f = fixture();
    try {
      const minted = f.mint(1);
      expect(minted.ok).toBe(true);
      if (!minted.ok) throw new Error(minted.error);
      const identity = cursorMutationContext(f.root, minted.token);
      expect(identity.ok).toBe(true);
      if (identity.ok) {
        expect(identity.context.role).toBe("delegated");
        expect(identity.context.taskIdentity).toBe("1");
        expect(identity.context.hostWorkspace).toBe(f.root);
      }
      // The token is reusable within its task: a second validation succeeds.
      expect(cursorMutationContext(f.root, minted.token).ok).toBe(true);
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);

test(
  "invalid, empty, and wrong-workspace tokens fail closed and never return coordinator context",
  () => {
    const f = fixture();
    try {
      for (const token of ["not-a-real-token", ""]) {
        const identity = cursorMutationContext(f.root, token);
        expect(identity.ok).toBe(false);
        if (!identity.ok) {
          expect(identity.code).toBe("delegation_token_invalid");
          expect("context" in identity).toBe(false);
        }
      }
      const otherRoot = mkdtempSync(path.join(os.tmpdir(), "wf-cursor-other-ws-"));
      try {
        const minted = f.mint(1);
        if (!minted.ok) throw new Error(minted.error);
        const wrongWorkspace = cursorMutationContext(otherRoot, minted.token);
        expect(wrongWorkspace.ok).toBe(false);
        if (!wrongWorkspace.ok) {
          expect(wrongWorkspace.code).toBe("delegation_token_invalid");
          expect("context" in wrongWorkspace).toBe(false);
        }
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);

test(
  "a revoked token returns delegation_token_revoked and never a context",
  () => {
    const f = fixture();
    try {
      const minted = f.mint(1);
      if (!minted.ok) throw new Error(minted.error);
      expect(revokeDelegateToken(f.root, f.slug, 1).ok).toBe(true);
      const identity = cursorMutationContext(f.root, minted.token);
      expect(identity.ok).toBe(false);
      if (!identity.ok) {
        expect(identity.code).toBe("delegation_token_revoked");
        expect("context" in identity).toBe(false);
      }
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);

test(
  "raw delegation tokens are never persisted in flow state",
  () => {
    const f = fixture();
    try {
      const minted = f.mint(1);
      if (!minted.ok) throw new Error(minted.error);
      const persisted = readFileSync(flowJson(f.root, f.slug), "utf8");
      expect(persisted).not.toContain(minted.token);
      expect(persisted).toContain(createHash("sha256").update(minted.token).digest("hex"));
      expect(persisted).not.toContain(f.lease);
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);

test(
  "concurrent token mint/revoke writes keep at most one active token",
  async () => {
    const f = fixture();
    try {
      // Six competing mints race through the shared locked writer: each
      // replaces the previous one-active token, so exactly one of the
      // returned raw tokens survives.
      const batch = await Promise.all([
        f.mint(1),
        f.mint(1),
        f.mint(1),
        f.mint(1),
        f.mint(1),
        f.mint(1),
      ]);
      expect(batch.every((r) => r.ok)).toBe(true);
      const tokens = batch.map((r) => (r.ok ? r.token : ""));
      const valid = tokens.filter((t) => t && validateDelegateToken(f.root, t).ok);
      expect(valid.length).toBe(1);

      // Interleaved revokes and mints keep the flow state coherent.
      const mixed = await Promise.all([
        revokeDelegateToken(f.root, f.slug, 1),
        f.mint(1),
        revokeDelegateToken(f.root, f.slug, 1),
        f.mint(1),
        revokeDelegateToken(f.root, f.slug, 1),
      ]);
      for (const r of mixed) expect(typeof r.ok).toBe("boolean");

      const state = readFlowState(f.root, f.slug);
      expect(state.execution.status).toBe("active");
      expect(state.execution.mode).toBe("subagent-driven");
      const stillValid = tokens.filter((t) => t && validateDelegateToken(f.root, t).ok);
      expect(stillValid.length).toBeLessThanOrEqual(1);
    } finally {
      f.cleanup();
    }
  },
  { timeout: 60_000 },
);
