/** Legacy named entry retained for package consumers; hook dispatch is shared.
 * Its bundle also carries subagentStart's handler, which workit-hook.ts loads
 * only for that event (no top-level await: it is required synchronously). */
import { runCursorHook } from "./workit-hook";

export { runCursorHook as main } from "./workit-hook";
export { handleSubagentStartHook } from "./subagent-start";

if (import.meta.main && !(globalThis as { workitSubagentLoad?: boolean }).workitSubagentLoad)
  void runCursorHook();
