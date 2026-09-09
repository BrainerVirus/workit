import { createWorkitTools } from "./workit";

export { createWorkitTools, NativeReceiptStore, observeQuestion } from "./workit";
export type { WorkitToolOptions } from "./workit";

/** OpenCode's native surface includes the eight core families and host-owned optional actions. */
export const createTools = (options: import("./workit").WorkitToolOptions = {}) =>
  createWorkitTools(options);
