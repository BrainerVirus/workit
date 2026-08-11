import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "@brainervirus/workit-core/src/core";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
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

export function createFlowTools() {
  return {
    workflow_flow_status: tool({
      description: "Read the spec/plan approval flow state for a workflow",
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
          const state = readFlowState(context.directory, slug);
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
        "Advance spec status: first call self_reviewed, second call approved (after user approval)",
      args: {
        confirmed: tool.schema.boolean(),
        spec_path: tool.schema.string(),
      },
      execute: async ({ confirmed, spec_path }, context) => {
        const slugged = resolveSlug(context.directory, { spec_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const result = transitionSpec(context.directory, slug, spec_path, confirmed);
        return output(
          result.ok
            ? ok({ spec: spec_path, status: readFlowState(context.directory, slug).spec.status })
            : fail(result.error),
        );
      },
    }),
    workflow_plan_approve: tool({
      description:
        "Advance plan status: first call self_reviewed, second call approved. Requires approved spec.",
      args: {
        confirmed: tool.schema.boolean(),
        plan_path: tool.schema.string(),
      },
      execute: async ({ confirmed, plan_path }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const result = transitionPlan(context.directory, slug, plan_path, confirmed);
        return output(
          result.ok
            ? ok({ plan: plan_path, status: readFlowState(context.directory, slug).plan.status })
            : fail(result.error),
        );
      },
    }),
    workflow_plan_menu: tool({
      description: "Record the answered post-plan choice menu (called after native question)",
      args: {
        confirmed: tool.schema.boolean(),
        plan_path: tool.schema.string(),
        choice: tool.schema.enum([
          "subagent-driven",
          "inline",
          "handoff",
          "review-spec",
          "review-plan",
        ]),
      },
      execute: async ({ confirmed, plan_path, choice }, context) => {
        const slugged = resolveSlug(context.directory, { plan_path });
        if ("error" in slugged) return output(fail(slugged.error));
        const slug = slugged.slug;
        const result = recordMenuChoice(context.directory, slug, plan_path, choice, confirmed);
        return output(
          result.ok ? ok({ menu: { presented: true, chosen: choice } }) : fail(result.error),
        );
      },
    }),
  };
}
