import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok } from "@brainervirus/workit-core/src/core";
import {
  assertHostEvidence,
  createFlowEvidence,
  prepareFlowState,
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
  type EvidenceResult,
  type MutationContext,
  type NativeChoiceEvidence,
} from "@brainervirus/workit-core/src/core/flow-state";
import { resolveCanonicalLayout } from "@brainervirus/workit-core/src/core/docs-layout";
import path from "node:path";

const output = (value: unknown) => JSON.stringify(value, null, 2);

const flowPathFor = (slug: string) => path.posix.join("docs", slug, "sdd", "flow.json");

// One shared contained path contract (DC-01, DC-02): slug comes from the
// resolver, which rejects absolute/traversal/cross-slug/wrong-basename paths.
const resolveSlug = (
  root: string,
  input: { spec_path?: string; plan_path?: string },
): { slug: string } | { error: string } => {
  const resolved = resolveCanonicalLayout({
    workspace_root: root,
    spec_path: input.spec_path,
    plan_path: input.plan_path,
  });
  if (!resolved.ok) return { error: resolved.error };
  return { slug: resolved.layout.slug };
};

const evidenceSchema = tool.schema.object({
  host: tool.schema.enum(["opencode", "cursor"]),
  questionId: tool.schema.string(),
  selectedLabel: tool.schema.string(),
  recordedAt: tool.schema.number(),
});

// Fail-closed mutation identity (CA-20): role + taskIdentity are explicit tool
// args — the boundary never infers delegation from the session agent name, so
// a coordinator under a custom agent name cannot bypass it. A missing role
// defaults to coordinator (blocked for subagent-driven product mutations).
export const roleSchema = tool.schema.enum(["coordinator", "delegated"]).optional();
export const taskIdentitySchema = tool.schema.string().optional();

/**
 * The OpenCode native-question adapter (FG-04): turns an answered native
 * `question` result into host-bound evidence. Models must pass evidence
 * produced here (or re-recorded from the native result) — a bare boolean is
 * never accepted by the transitions.
 */
export const opencodeQuestionEvidence = (
  questionId: string,
  selectedLabel: string,
  recordedAt?: number,
): EvidenceResult => createFlowEvidence("opencode", questionId, selectedLabel, recordedAt);

const HOST = "opencode" as const;

// OpenCode's default primary agent is "build" (docs: config → Default agent);
// a session spawned by the `task` tool runs a different agent. The coordinator
// boundary is fail-closed: role + taskIdentity are explicit tool args, never
// inferred from the agent name, so a coordinator under a custom primary agent
// cannot be auto-classified delegated. Missing role → coordinator (blocked).
export const opencodeMutationContext = (
  context: ToolContext,
  args?: { role?: string; taskIdentity?: string },
): MutationContext => {
  const delegated = args?.role === "delegated";
  return {
    hostWorkspace: context.directory,
    role: delegated ? "delegated" : "coordinator",
    sessionId: context.sessionID,
    taskIdentity: delegated ? args?.taskIdentity : undefined,
  };
};

export function createFlowTools() {
  return {
    workflow_flow_status: tool({
      description:
        "Read the spec/plan approval flow state for a workflow; on first read it records flow activation and canonical document paths (FG-01)",
      args: {
        plan_path: tool.schema.string().optional(),
        spec_path: tool.schema.string().optional(),
        role: roleSchema,
        taskIdentity: taskIdentitySchema,
      },
      execute: async ({ plan_path, spec_path, role, taskIdentity }, context) => {
        try {
          if (!plan_path && !spec_path) return output(fail("plan_path or spec_path required"));
          const slugged = resolveSlug(context.directory, { plan_path, spec_path });
          if ("error" in slugged) return output(fail(slugged.error));
          const slug = slugged.slug;
          let state = readFlowState(context.directory, slug);
          if (!state.activated) {
            const prepared = prepareFlowState(
              context.directory,
              slug,
              { spec_path, plan_path },
              opencodeMutationContext(context, { role, taskIdentity }),
            );
            if (!prepared.ok) return output(fail(prepared.error, { code: prepared.code }));
            state = readFlowState(context.directory, slug);
          }
          return output(
            ok({
              slug,
              spec: state.spec,
              plan: state.plan,
              menu: state.menu,
              flow_path: flowPathFor(slug),
            }),
          );
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "flow status failed"));
        }
      },
    }),
    workflow_spec_approve: tool({
      description:
        "Advance spec status with native-question evidence: first call self_reviewed, second call approved. Evidence is required; bare booleans are rejected (FG-04, CA-19).",
      args: {
        spec_path: tool.schema.string(),
        evidence: evidenceSchema,
        role: roleSchema,
        taskIdentity: taskIdentitySchema,
      },
      execute: async ({ spec_path, evidence, role, taskIdentity }, context) => {
        const slugged = resolveSlug(context.directory, { spec_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const hostOk = assertHostEvidence(HOST, evidence as NativeChoiceEvidence);
        if (!hostOk.ok) return output(fail(hostOk.error, { code: hostOk.code }));
        const result = transitionSpec(
          context.directory,
          slug,
          spec_path,
          evidence,
          opencodeMutationContext(context, { role, taskIdentity }),
        );
        return output(
          result.ok
            ? ok({ spec: spec_path, status: readFlowState(context.directory, slug).spec.status })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
    workflow_plan_approve: tool({
      description:
        "Advance plan status with native-question evidence: first call self_reviewed, second call approved. Requires approved spec. Evidence is required; bare booleans are rejected.",
      args: {
        plan_path: tool.schema.string(),
        evidence: evidenceSchema,
        role: roleSchema,
        taskIdentity: taskIdentitySchema,
      },
      execute: async ({ plan_path, evidence, role, taskIdentity }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const hostOk = assertHostEvidence(HOST, evidence as NativeChoiceEvidence);
        if (!hostOk.ok) return output(fail(hostOk.error, { code: hostOk.code }));
        const result = transitionPlan(
          context.directory,
          slug,
          plan_path,
          evidence,
          opencodeMutationContext(context, { role, taskIdentity }),
        );
        return output(
          result.ok
            ? ok({ plan: plan_path, status: readFlowState(context.directory, slug).plan.status })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
    workflow_plan_menu: tool({
      description:
        "Record the answered post-plan choice menu with native-question evidence (called after the native question). Evidence label must match the choice exactly.",
      args: {
        plan_path: tool.schema.string(),
        choice: tool.schema.enum([
          "subagent-driven",
          "inline",
          "handoff",
          "review-spec",
          "review-plan",
        ]),
        evidence: evidenceSchema,
        role: roleSchema,
        taskIdentity: taskIdentitySchema,
      },
      execute: async ({ plan_path, choice, evidence, role, taskIdentity }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const hostOk = assertHostEvidence(HOST, evidence as NativeChoiceEvidence);
        if (!hostOk.ok) return output(fail(hostOk.error, { code: hostOk.code }));
        const result = recordMenuChoice(
          context.directory,
          slug,
          plan_path,
          choice,
          evidence,
          opencodeMutationContext(context, { role, taskIdentity }),
        );
        return output(
          result.ok
            ? ok({ menu: { presented: true, chosen: choice } })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
  };
}
