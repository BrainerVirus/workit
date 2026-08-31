import { tool } from "@opencode-ai/plugin";
import { ok } from "@brainervirus/workit-core/src/core";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";

// workit_doctor (DG-07): offline installation health on the OpenCode host.
// Returns the shared DoctorReport wrapped in the ok() envelope so the result
// shape is identical to every other OpenCode tool.
export const createDoctorTool = () => ({
  workit_doctor: tool({
    description: "Run the offline workit doctor and report installation health",
    args: {},
    execute: async (_input, context) =>
      JSON.stringify(ok(runDoctor({ host: "opencode", cwd: context.directory })), null, 2),
  }),
});
