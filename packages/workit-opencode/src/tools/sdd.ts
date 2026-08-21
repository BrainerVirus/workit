import { readFileSync } from "node:fs";
import path from "node:path";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok, resolveGitRevision, resolveInside } from "@brainervirus/workit-core/src/core";
import { resolveBranch, docsBranch } from "@brainervirus/workit-core/src/core/branch";
import { docsValidate } from "@brainervirus/workit-core/src/core/docs-validate";
import {
  parsePlanTasks,
  resolveHandoffBranch,
} from "@brainervirus/workit-core/src/core/plan-tasks";
import {
  sddAppendAdvisory,
  sddAppendProgress,
  sddContext,
  sddReviewPackage,
  sddTaskBrief,
} from "@brainervirus/workit-core/src/core/sdd";
import {
  assertSddControlGates,
  slugFromSddPath,
} from "@brainervirus/workit-core/src/core/flow-state";
import { opencodeMutationContext, type SessionLookup } from "./flow";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";

const output = (value: unknown) => JSON.stringify(value, null, 2);
const requireConfirmed = (confirmed: boolean) =>
  confirmed === true ? null : output(fail("confirmed: true required"));

// CA-10: SDD control writes (brief, review package, progress, advisories)
// are coordinator-owned under active subagent-driven execution. Delegated
// workers are denied; root writes pass through the shared control gate that
// reuses workspace/approval/menu/docs checks but flips the boundary role.
const gateSddControl = async (
  root: string,
  sddPath: string,
  context: ToolContext,
  client?: SessionLookup,
) => {
  const slug = slugFromSddPath(sddPath);
  if (!slug) return output(fail("could not derive slug — expected docs/<slug>/sdd/..."));
  const gate = assertSddControlGates(
    root,
    slug,
    { requireMenu: true, requireDocs: true },
    await opencodeMutationContext(context, client),
  );
  if (!gate.ok) return output(fail(gate.error, { code: gate.code }));
  return null;
};

const relativePath = (root: string, candidate: string) => {
  if (path.isAbsolute(candidate)) throw new Error("path must be repository-relative");
  resolveInside(root, candidate);
  return candidate;
};

const normalize = (value: Record<string, unknown>) => {
  if (value.error) return fail(String(value.error));
  if (value.ok === false) return fail("legacy operation reported failure");
  const { ok: _legacyOk, ...data } = value;
  return ok(data);
};

const invoke = (operation: () => Record<string, unknown>) => {
  try {
    return output(normalize(operation()));
  } catch (error) {
    return output(fail(error instanceof Error ? error.message : "workflow operation failed"));
  }
};

const planPaths = (root: string, planPath: string, suppliedSpecPath?: string) => {
  const resolved = resolveInside(root, planPath);
  const match = readFileSync(resolved, "utf8").match(/^\*\*Spec:\*\*\s*(?:`([^`]+)`|(\S+))/m);
  const spec_path = suppliedSpecPath ?? match?.[1] ?? match?.[2] ?? "";
  if (spec_path) relativePath(root, spec_path);
  return {
    spec_path,
    plan_path: planPath,
    sdd_dir: path.posix.join("docs", path.basename(path.dirname(planPath)), "sdd"),
  };
};

export function createSddTools(state: WorkflowStateStore, client?: SessionLookup) {
  const record = (context: ToolContext, data: Record<string, unknown>) =>
    state.set(context.sessionID, {
      spec: String(data.spec_path ?? ""),
      plan: String(data.plan_path ?? ""),
      sdd: String(data.sdd_dir ?? ""),
    });

  return {
    workflow_docs_branch: tool({
      description:
        "Resolve branch for spec/plan authors: keep current feature|bugfix or create from the configured base",
      args: {
        plan_path: tool.schema.string().optional(),
        kind: tool.schema.enum(["feature", "bugfix"]).optional(),
      },
      execute: async ({ plan_path, kind }, context) =>
        invoke(() => {
          if (plan_path) relativePath(context.directory, plan_path);
          return docsBranch({
            plan_path,
            kind,
            workspace_root: context.directory,
          }) as Record<string, unknown>;
        }),
    }),
    workflow_docs_validate: tool({
      description:
        "Hard-fail validate spec/plan headers, link, branch, task order; returns quality findings (hard/warning)",
      args: {
        spec_path: tool.schema.string(),
        plan_path: tool.schema.string(),
      },
      execute: async ({ spec_path, plan_path }, context) =>
        invoke(() => {
          relativePath(context.directory, spec_path);
          relativePath(context.directory, plan_path);
          const result = docsValidate({
            spec_path,
            plan_path,
            workspace_root: context.directory,
          }) as Record<string, unknown>;
          if (result.error) return result;
          if (result.ok === false) return result;
          return result;
        }),
    }),
    workflow_plan_tasks: tool({
      description: "Parse top-level tasks from a workflow plan",
      args: { plan_path: tool.schema.string(), spec_path: tool.schema.string().optional() },
      execute: async ({ plan_path, spec_path }, context) =>
        invoke(() => {
          relativePath(context.directory, plan_path);
          const paths = planPaths(context.directory, plan_path, spec_path);
          const parsed = parsePlanTasks(plan_path, context.directory) as Record<string, unknown>;
          if (parsed.error) return parsed;
          const branch = paths.spec_path
            ? (resolveHandoffBranch(paths.spec_path, plan_path, context.directory) as Record<
                string,
                unknown
              >)
            : {};
          if (branch.error) return branch;
          const data = { ...parsed, ...paths, ...branch };
          record(context, data);
          return data;
        }),
    }),
    workflow_resolve_branch: tool({
      description: "Resolve a branch from repository spec and plan metadata",
      args: { spec_path: tool.schema.string(), plan_path: tool.schema.string() },
      execute: async ({ spec_path, plan_path }, context) =>
        invoke(() => {
          relativePath(context.directory, spec_path);
          relativePath(context.directory, plan_path);
          return resolveBranch({ spec_path, plan_path, workspace_root: context.directory });
        }),
    }),
    workflow_sdd_context: tool({
      description: "Resolve the SDD workspace and progress ledger",
      args: {
        plan_path: tool.schema.string().optional(),
        slug: tool.schema.string().optional(),
      },
      execute: async ({ plan_path, slug }, context) =>
        invoke(() => {
          if (plan_path) relativePath(context.directory, plan_path);
          const parsed = sddContext({
            slug,
            plan_path,
            workspace_root: context.directory,
          }) as Record<string, unknown>;
          if (parsed.error) return parsed;
          const todos = Array.isArray(parsed.todos)
            ? parsed.todos.map((todo: Record<string, unknown>) =>
                todo.status === "in_progress" ? { ...todo, status: "pending" } : todo,
              )
            : [];
          const data = {
            ...parsed,
            todos,
            ...(plan_path ? planPaths(context.directory, plan_path) : {}),
            sdd_dir: parsed.sdd_dir,
          };
          record(context, data);
          return data;
        }),
    }),
    workflow_sdd_task_brief: tool({
      description:
        "Write a confirmed task brief. Delegated status is host-derived from session parentage (child session = worker; root = coordinator, blocked for subagent-driven product edits).",
      args: {
        confirmed: tool.schema.boolean(),
        sdd_dir: tool.schema.string(),
        task_id: tool.schema.number(),
        section_text: tool.schema.string(),
      },
      execute: async ({ confirmed, sdd_dir, task_id, section_text }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const gated = await gateSddControl(context.directory, sdd_dir, context, client);
        if (gated) return gated;
        return invoke(() => {
          relativePath(context.directory, sdd_dir);
          return sddTaskBrief({
            sdd_dir,
            task_id,
            section_text,
            workspace_root: context.directory,
          });
        });
      },
    }),
    workflow_sdd_review_package: tool({
      description:
        "Write a confirmed task review diff. Delegated status is host-derived from session parentage (child session = worker; root = coordinator, blocked for subagent-driven product edits).",
      args: {
        confirmed: tool.schema.boolean(),
        sdd_dir: tool.schema.string(),
        base_sha: tool.schema.string(),
        head_sha: tool.schema.string(),
      },
      execute: async ({ confirmed, sdd_dir, base_sha, head_sha }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        try {
          relativePath(context.directory, sdd_dir);
          resolveGitRevision(context.directory, base_sha);
          resolveGitRevision(context.directory, head_sha);
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "workflow operation failed"));
        }
        const gated = await gateSddControl(context.directory, sdd_dir, context, client);
        if (gated) return gated;
        return invoke(() =>
          sddReviewPackage({
            sdd_dir,
            base_sha,
            head_sha,
            workspace_root: context.directory,
          }),
        );
      },
    }),
    workflow_sdd_append_progress: tool({
      description:
        "Append one confirmed validated SDD progress line. Delegated status is host-derived from session parentage (child session = worker; root = coordinator, blocked for subagent-driven product edits).",
      args: {
        confirmed: tool.schema.boolean(),
        progress_path: tool.schema.string(),
        line: tool.schema.string(),
      },
      execute: async ({ confirmed, progress_path, line }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const gated = await gateSddControl(context.directory, progress_path, context, client);
        if (gated) return gated;
        return invoke(() => {
          relativePath(context.directory, progress_path);
          return sddAppendProgress({ progress_path, line, workspace_root: context.directory });
        });
      },
    }),
    workflow_sdd_append_advisory: tool({
      description: "Append a validated advisory line to docs/<slug>/sdd/advisories.md (coordinator-owned).",
      args: {
        confirmed: tool.schema.boolean(),
        advisories_path: tool.schema.string(),
        task_id: tool.schema.number(),
        text: tool.schema.string(),
      },
      execute: async ({ confirmed, advisories_path, task_id, text }, context) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const gated = await gateSddControl(context.directory, advisories_path, context, client);
        if (gated) return gated;
        return invoke(() => {
          relativePath(context.directory, advisories_path);
          return sddAppendAdvisory({
            advisories_path,
            task_id,
            text,
            workspace_root: context.directory,
          });
        });
      },
    }),
  };
}
