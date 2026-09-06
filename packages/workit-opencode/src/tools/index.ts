import { createWorkitTools } from "./workit";

export { createWorkitTools, NativeReceiptStore, observeQuestion } from "./workit";
export type { WorkitToolOptions } from "./workit";

/** OpenCode's native surface is intentionally the same eight core families. */
export const createTools = (options: import("./workit").WorkitToolOptions = {}) =>
  createWorkitTools(options);
