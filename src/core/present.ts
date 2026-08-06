import { spawnSync } from "node:child_process";
import path from "node:path";
import { PLUGIN_ROOT } from "./scripts";

function runPresent(script: string, input: unknown): { error: string } | { data: string } {
  const scriptPath = path.join(PLUGIN_ROOT, "scripts", "present", script);
  const result = spawnSync("bash", [scriptPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      error: (result.stderr || result.stdout || "present script failed").trim(),
    };
  }
  return { data: (result.stdout ?? "").trimEnd() };
}

export function asciiWireframe(spec: unknown): Record<string, any> {
  const out = runPresent("ascii-wireframe.sh", spec);
  if ("error" in out) return out;
  return { data: { ascii: out.data, format: "ascii-wireframe" } };
}

export function flowDiagram(spec: unknown): Record<string, any> {
  const out = runPresent("flow-diagram.sh", spec);
  if ("error" in out) return out;
  return { data: { mermaid: out.data, format: "mermaid" } };
}
