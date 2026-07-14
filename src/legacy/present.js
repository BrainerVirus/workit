import { spawnSync } from "node:child_process";
import path from "node:path";
import { PLUGIN_ROOT } from "./plugin-root.js";

function runPresent(script, input) {
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

export function asciiWireframe(spec) {
  const out = runPresent("ascii-wireframe.sh", spec);
  if (out.error) return out;
  return { data: { ascii: out.data, format: "ascii-wireframe" } };
}

export function flowDiagram(spec) {
  const out = runPresent("flow-diagram.sh", spec);
  if (out.error) return out;
  return { data: { mermaid: out.data, format: "mermaid" } };
}
