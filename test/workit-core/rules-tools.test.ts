import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuleTools } from "../../packages/workit-core/src/tools/rules";
import { listRules } from "../../packages/workit-core/src/core/rules";

test("rule_edit writes config; rule_list reports it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-rule-tools-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    const tools = createRuleTools();
    const edit = JSON.parse(
      (await tools.workflow_rule_edit.execute(
        {
          name: "my-rule",
          description: "My rule",
          platforms: ["cursor", "opencode"],
          body: "# My rule\n\nDo it.\n",
          confirmed: true,
        },
        {} as never,
      )) as string,
    );
    expect(edit.ok).toBe(true);
    expect(edit.data.path).toContain(dir);

    const list = JSON.parse((await tools.workflow_rule_list.execute({}, {} as never)) as string);
    expect(list.ok).toBe(true);
    expect(list.data.rules.some((r: any) => r.name === "my-rule")).toBe(true);
    expect(listRules().length).toBe(1);

    const no = JSON.parse(
      (await tools.workflow_rule_edit.execute(
        {
          name: "x",
          description: "x",
          platforms: ["cursor"],
          body: "# X\n",
          confirmed: false,
        },
        {} as never,
      )) as string,
    );
    expect(no.ok).toBe(false);
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
