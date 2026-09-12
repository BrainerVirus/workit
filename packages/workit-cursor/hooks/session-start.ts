/** Legacy named entry retained for package consumers; hook dispatch is shared. */
export { runCursorHook as main } from "./workit-hook";

if (import.meta.main) {
  const { runCursorHook } = await import("./workit-hook");
  await runCursorHook();
}
