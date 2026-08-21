import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTemplateTools } from "../../packages/workit-opencode/src/tools/templates";

test("template_list reports repo sources by default; template_edit writes config", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-tpl-tools-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    const tools = createTemplateTools();
    const list = JSON.parse((await tools.workit_template_list.execute({}, {} as never)) as string);
    expect(list.ok).toBe(true);
    expect(
      list.data.templates.some((t: any) => t.name === "issue-update" && t.source === "repo"),
    ).toBe(true);

    const edit = JSON.parse(
      (await tools.workit_template_edit.execute(
        {
          name: "issue-update",
          content: "# Custom\n",
          confirmed: true,
        },
        {} as never,
      )) as string,
    );
    expect(edit.ok).toBe(true);
    expect(edit.data.path).toContain(dir);

    const no = JSON.parse(
      (await tools.workit_template_edit.execute(
        {
          name: "issue-update",
          content: "# X\n",
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
