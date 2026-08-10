import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "@brainervirus/workit-core/src/core";
import { listRules, writeRule, type CanonicalRule } from "@brainervirus/workit-core/src/core/rules";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createRuleTools() {
  return {
    workflow_rule_list: tool({
      description: "List canonical rules (config) with platforms and source",
      args: {},
      execute: async () => output(ok({ rules: listRules() })),
    }),
    workflow_rule_edit: tool({
      description: "Write a canonical rule to the toolkit config dir (agent-assisted)",
      args: {
        name: tool.schema.string(),
        description: tool.schema.string(),
        platforms: tool.schema.array(tool.schema.enum(["cursor", "opencode"])),
        body: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ name, description, platforms, body, confirmed }) => {
        const rule: CanonicalRule = { name, description, platforms, body };
        const result = writeRule(rule, confirmed);
        return output(result.ok ? ok(result) : fail(result.error));
      },
    }),
  };
}
