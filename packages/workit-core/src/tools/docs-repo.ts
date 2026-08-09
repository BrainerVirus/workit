import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { linkDocsRepo, listSpecs, promoteSpec } from "../core/docs-repo";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createDocsRepoTools() {
  return {
    workflow_docs_repo_link: tool({
      description: "Link the component docs repo in the toolkit config (validates git repo + features/)",
      args: {
        path: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ path: docsPath, confirmed }, _context) => {
        const result = linkDocsRepo(docsPath, confirmed);
        return output(result.ok ? ok({ path: result.path }) : fail(result.error));
      },
    }),
    workflow_docs_list: tool({
      description: "List local specs (docs/<slug>/spec.md) with docs-repo promotion status",
      args: {},
      execute: async (_input, context) => {
        const result = listSpecs(context.directory);
        return output(ok(result));
      },
    }),
    workflow_docs_promote: tool({
      description: "Promote a spec (+plan) to the linked docs repo features/YYYY-MM-<slug>/ with quality gate",
      args: {
        slug: tool.schema.string(),
        confirmed: tool.schema.boolean(),
        force: tool.schema.boolean().optional(),
      },
      execute: async ({ slug, confirmed, force }, context) => {
        const result = promoteSpec(context.directory, slug, { confirmed, force });
        if (result.ok) return output(ok({ target_dir: result.target_dir, files: result.files, index_updated: result.index_updated }));
        return output(fail(result.error, { findings: result.findings ?? [] } as never));
      },
    }),
  };
}
