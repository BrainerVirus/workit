import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { listTemplates, writeTemplate, type TemplateName } from "../core/templates";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createTemplateTools() {
  return {
    workflow_template_list: tool({
      description: "List editable templates (issue-update, greeting, headers) with their source",
      args: {},
      execute: async () => output(ok({ templates: listTemplates() })),
    }),
    workflow_template_edit: tool({
      description: "Write an edited template to the toolkit config dir (agent-assisted)",
      args: {
        name: tool.schema.enum(["issue-update", "greeting", "headers"]),
        content: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ name, content, confirmed }) => {
        const result = writeTemplate(name as TemplateName, content, confirmed);
        return output(result.ok ? ok(result) : fail(result.error));
      },
    }),
  };
}
