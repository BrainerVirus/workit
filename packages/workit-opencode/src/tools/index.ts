import { createWorkitTools } from "./workit";

export { createWorkitTools, NativeReceiptStore, observeQuestion } from "./workit";
export type { WorkitToolOptions } from "./workit";

/** OpenCode's native surface includes core operations and read-only context. */
export const createTools = (options: import("./workit").WorkitToolOptions = {}) =>
  createWorkitTools(options);
