import { rmSync } from "node:fs";

/** The codes Windows answers while a just-exited child or a scanner still holds a handle. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Remove a test's temp dir, retrying while Windows still holds a handle in it.
 * Bun's rmSync accepts `maxRetries` and `retryDelay` but does not retry, so a
 * dir a child had open a moment ago failed EBUSY at once.
 */
export function removeDir(dir: string, tries = 10, delayMs = 100): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= tries || !RETRYABLE.has(code)) throw error;
      Bun.sleepSync(delayMs * attempt);
    }
  }
}
