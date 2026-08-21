import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok } from "@brainervirus/workit-core/src/core";
import {
  HostReceiptStore,
  createOpenCodeEvidence,
  prepareFlowState,
  readEffectiveFlowState,
  readFlowState,
  roleFromParentage,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
  transitionExecution,
  type MutationContext,
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

/**
 * The host session lookup used for delegation (AR-12, CA-20). OpenCode 1.17.x
 * SDK shape: `session.get({ path: { id } })` returns the session with an
 * optional `parentID`; a session with a parent is a child (delegated worker).
 * (Task 30: newer SDKs use `session.get({ sessionID })` — this adapter binds
 * to the shape verified against the installed @opencode-ai/sdk 1.17.7.)
 */
export type SessionLookup = {
  session: {
    get: (input: {
      path: { id: string };
    }) => Promise<{ data?: { parentID?: string; directory?: string } }>;
  };
};

/**
 * Fail-closed mutation identity (AR-12): delegated status is derived from the
 * host session's parentage via `client.session.get`, never from caller-supplied
 * role fields (removed from every schema). A session whose parentage cannot be
 * verified is treated as the root coordinator (blocked for subagent-driven
 * product mutations). The child session id is the authenticated task identity.
 */
export const opencodeMutationContext = async (
  context: ToolContext,
  client?: SessionLookup,
): Promise<MutationContext> => {
  let parentID: string | undefined;
  try {
    const session = await client?.session.get({ path: { id: context.sessionID } });
    parentID = session?.data?.parentID;
  } catch {
    // fail closed: an unverifiable session is the root coordinator
  }
  // No flow-state access here (identity is built before the slug resolves):
  // the coordinator id is unknown at derivation time, so lineage binding
  // happens later against the persisted execution.coordinator_session_id.
  const role = roleFromParentage(parentID, undefined);
  return {
    hostWorkspace: context.directory,
    role,
    sessionId: context.sessionID,
    // Host-attested parentage (CA-13): gates bind lineage later against the
    // persisted execution.coordinator_session_id.
    parentSessionId: parentID,
    taskIdentity: role === "delegated" ? context.sessionID : undefined,
  };
};

export function createFlowTools(receipts: HostReceiptStore, client?: SessionLookup) {
  // Execution lifecycle tools (CA-11, CA-14, CA-23): each transitions the plan's
  // execution between pending/active/paused/completed through core
  // `transitionExecution`, gated by a ONE-USE host-observed native-question
  // receipt with the exact lifecycle label (AR-12, FINDING 5). The schema exposes
  // only `plan_path` — no `confirmed`, evidence, role, or task identity fields.
  // Identity is derived from host session parentage via `opencodeMutationContext`
  // (fail-closed: an unverifiable session is the root coordinator). The result
  // reports the post-transition effective execution state and any approval drift,
  // and failed transitions surface structured `details` (e.g. incomplete ledger
  // or verification failure facts) for the next action.
  const purposeForLifecycle: Record<string, "plan-pause" | "plan-resume" | "plan-complete"> = {
    "Pause plan": "plan-pause",
    "Resume plan": "plan-resume",
    "Complete plan": "plan-complete",
  };
  const lifecycleTool = (
    action: "pause" | "resume" | "complete",
    label: "Pause plan" | "Resume plan" | "Complete plan",
    description: string,
  ) =>
    tool({
      description,
      args: {
        plan_path: tool.schema.string(),
      },
      execute: async ({ plan_path }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const consumed = receipts.consume(context.sessionID, {
          purpose: purposeForLifecycle[label],
          label,
        });
        if (!consumed.ok) return output(fail(consumed.error, { code: consumed.code }));
        const result = transitionExecution(
          context.directory,
          slug,
          plan_path,
          action,
          createOpenCodeEvidence(consumed.receipt),
          await opencodeMutationContext(context, client),
        );
        if (!result.ok) {
          return output(
            fail(result.error, {
              code: result.code,
              ...(result.details ? { details: result.details } : {}),
            }),
          );
        }
        const effective = readEffectiveFlowState(context.directory, slug);
        if (!effective.ok) return output(fail(effective.error, { code: effective.code }));
        return output(
          ok({
            plan: plan_path,
            execution: effective.state.execution,
            drift: effective.drift,
            question: consumed.receipt.question,
          }),
        );
      },
    });

  return {
    workflow_flow_status: tool({
      description:
        "Read the spec/plan approval flow state for a workflow; on first read it records flow activation and canonical document paths (FG-01)",
      args: {
        plan_path: tool.schema.string().optional(),
        spec_path: tool.schema.string().optional(),
      },
      execute: async ({ plan_path, spec_path }, context) => {
        try {
          if (!plan_path && !spec_path) return output(fail("plan_path or spec_path required"));
          const slugged = resolveSlug(context.directory, { plan_path, spec_path });
          if ("error" in slugged) return output(fail(slugged.error));
          const slug = slugged.slug;
          // Effective read (CA-02/CA-04): digest reconciliation and legacy
          // compatibility run under the per-flow lock before status trusts
          // persisted approvals; drift is reported structurally.
          let effective = readEffectiveFlowState(context.directory, slug);
          if (!effective.ok && effective.code === "flow_not_activated") {
            const prepared = prepareFlowState(
              context.directory,
              slug,
              { spec_path, plan_path },
              await opencodeMutationContext(context, client),
            );
            if (!prepared.ok) return output(fail(prepared.error, { code: prepared.code }));
            effective = readEffectiveFlowState(context.directory, slug);
          }
          if (!effective.ok) return output(fail(effective.error, { code: effective.code }));
          const { state, drift } = effective;
          return output(
            ok({
              slug,
              spec: state.spec,
              plan: state.plan,
              menu: state.menu,
              execution: state.execution,
              drift,
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
        "Advance spec status from a host-observed native-question receipt: draft -> approved in a single call. The self-review validation runs automatically inside the transition; only the final approval asks for your confirmation. The receipt is recorded automatically when the user answers the `question` tool; there is no evidence argument (AR-12).",
      args: {
        spec_path: tool.schema.string(),
      },
      execute: async ({ spec_path }, context) => {
        const slugged = resolveSlug(context.directory, { spec_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        // FINDING 5 (round 3): consume FIRST — the atomic one-use take IS the
        // gate. peek-then-consume raced: two concurrent approve calls in one
        // message could both peek the same receipt and drive draft -> approved
        // on a single answer. Semantics: spent-on-any-attempt — a failed gate
        // (draft spec, invalid docs, already-approved) spends the user's
        // answer; the model must ask the native question again. Stricter and
        // race-free; correlation: session + one-use + freshness + non-negative
        // label + purpose (FINDING 2/3).
        const consumed = receipts.consume(context.sessionID, { purpose: "spec-approval" });
        if (!consumed.ok) return output(fail(consumed.error, { code: consumed.code }));
        const result = transitionSpec(
          context.directory,
          slug,
          spec_path,
          createOpenCodeEvidence(consumed.receipt),
          await opencodeMutationContext(context, client),
        );
        // Echo through the EFFECTIVE read (CA-02): the post-transition status is
        // reconciled so a drift reset that ran during the transition is
        // reflected, consistent with workflow_flow_status. Fall back to the
        // lenient read only if the reconciled read itself fails — never fail a
        // successful transition over an echo.
        const effective = readEffectiveFlowState(context.directory, slug);
        const status = effective.ok
          ? effective.state.spec.status
          : readFlowState(context.directory, slug).spec.status;
        return output(
          result.ok
            ? ok({ spec: spec_path, status, question: consumed.receipt.question })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
    workflow_plan_approve: tool({
      description:
        "Advance plan status from a host-observed native-question receipt: draft -> approved in a single call. The self-review validation runs automatically inside the transition; only the final approval asks for your confirmation. Requires approved spec. There is no evidence argument (AR-12).",
      args: {
        plan_path: tool.schema.string(),
      },
      execute: async ({ plan_path }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        // FINDING 5 (round 3): consume-before-transition, same as
        // workflow_spec_approve — the atomic one-use take gates the transition
        // and is spent on any attempt. Purpose-bound.
        const consumed = receipts.consume(context.sessionID, { purpose: "plan-approval" });
        if (!consumed.ok) return output(fail(consumed.error, { code: consumed.code }));
        const result = transitionPlan(
          context.directory,
          slug,
          plan_path,
          createOpenCodeEvidence(consumed.receipt),
          await opencodeMutationContext(context, client),
        );
        // Effective echo, same as workflow_spec_approve: reconciled status,
        // lenient fallback only if the reconciled read fails.
        const effective = readEffectiveFlowState(context.directory, slug);
        const status = effective.ok
          ? effective.state.plan.status
          : readFlowState(context.directory, slug).plan.status;
        return output(
          result.ok
            ? ok({ plan: plan_path, status, question: consumed.receipt.question })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
    workflow_plan_menu: tool({
      description:
        "Record the answered post-plan choice menu (called after the native question). The receipt label must match the choice exactly; there is no evidence argument (AR-12).",
      args: {
        plan_path: tool.schema.string(),
        choice: tool.schema.enum([
          "subagent-driven",
          "inline",
          "handoff",
          "review-spec",
          "review-plan",
        ]),
      },
      execute: async ({ plan_path, choice }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        // FINDING 5 (round 3): consume-before-transition with the exact-choice
        // label pin. A label MISMATCH does not spend the receipt (it stays
        // queued for the choice it actually matched); a failed menu gate
        // (plan not approved, unsupported mode) spends it like the approvals.
        // Purpose-bound: execution-menu only.
        const consumed = receipts.consume(context.sessionID, {
          purpose: "execution-menu",
          label: choice,
        });
        if (!consumed.ok) return output(fail(consumed.error, { code: consumed.code }));
        const result = recordMenuChoice(
          context.directory,
          slug,
          plan_path,
          choice,
          createOpenCodeEvidence(consumed.receipt),
          await opencodeMutationContext(context, client),
        );
        return output(
          result.ok
            ? ok({
                menu: { presented: true, chosen: choice },
                question: consumed.receipt.question,
              })
            : fail(result.error, { code: result.code }),
        );
      },
    }),
    workflow_plan_pause: lifecycleTool(
      "pause",
      "Pause plan",
      "Pause a running plan from a host-observed native-question receipt: active -> paused. The receipt label must be exactly `Pause plan`; there is no evidence argument (AR-12). A failed gate (already-paused) spends the receipt — re-answer the native question to retry.",
    ),
    workflow_plan_resume: lifecycleTool(
      "resume",
      "Resume plan",
      "Resume a paused plan from a host-observed native-question receipt: paused -> active. The receipt label must be exactly `Resume plan`; there is no evidence argument (AR-12). A failed gate (flow_not_paused) spends the receipt — re-answer the native question to retry.",
    ),
    workflow_plan_complete: lifecycleTool(
      "complete",
      "Complete plan",
      "Complete a running plan from a host-observed native-question receipt: active/paused -> completed, after the SDD ledger is complete and repository verification passes. The receipt label must be exactly `Complete plan`; there is no evidence argument (AR-12). A failed gate (execution_incomplete or verification_failed) spends the receipt — re-answer the native question to retry.",
    ),
  };
}
