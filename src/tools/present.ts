import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { asciiWireframe, flowDiagram } from "../legacy/present.js";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createPresentTools() {
  return {
    workflow_present_ascii: tool({
      description: "Render deterministic ASCII UI wireframe from JSON spec",
      args: {
        title: tool.schema.string().optional(),
        width: tool.schema.number().optional(),
        rows: tool.schema.array(tool.schema.record(tool.schema.string(), tool.schema.any())),
      },
      execute: async (spec) => {
        const result = asciiWireframe(spec);
        if ("error" in result) return output(fail(result.error));
        return output(ok(result.data));
      },
    }),
    workflow_present_flow: tool({
      description: "Render mermaid flowchart from JSON nodes/edges",
      args: {
        title: tool.schema.string().optional(),
        direction: tool.schema.enum(["TD", "LR", "BT", "RL"]).optional(),
        nodes: tool.schema.array(tool.schema.object({
          id: tool.schema.string(),
          label: tool.schema.string(),
          shape: tool.schema.string().optional(),
        })),
        edges: tool.schema.array(tool.schema.object({
          from: tool.schema.string(),
          to: tool.schema.string(),
          label: tool.schema.string().optional(),
        })),
      },
      execute: async (spec) => {
        const result = flowDiagram(spec);
        if ("error" in result) return output(fail(result.error));
        return output(ok(result.data));
      },
    }),
  };
}
