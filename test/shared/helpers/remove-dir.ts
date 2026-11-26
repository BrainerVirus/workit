import { removeTree } from "@/packages/workit-core/src/core/remove-tree";

/**
 * Remove a test's temp dir, retrying while Windows still holds a handle in it
 * (a child that just exited, or a scanner). More patient than product code:
 * 10 tries by default.
 */
export function removeDir(dir: string, tries = 10, delayMs = 100): void {
  removeTree(dir, { attempts: tries, delayMs });
}
