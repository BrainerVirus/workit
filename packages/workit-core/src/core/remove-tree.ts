import fs from "node:fs";

/** The codes a held handle or a racing writer answers; another attempt can clear them. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

export interface RemoveTreeOptions {
  /** Total tries, the first included. */
  attempts?: number;
  /** The wait before the second try; each later wait grows by this much. */
  delayMs?: number;
  /** The removal itself; tests inject a failing one. */
  rm?: (dir: string) => void;
}

const rmRecursive = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `rm -rf dir`, retrying a retryable failure with linear backoff. Bun's rmSync
 * accepts `maxRetries` and `retryDelay` but ignores them, so Workit run from
 * source never retried; this loop behaves the same under Node and Bun. Any
 * other error, or the last retryable one, is rethrown.
 */
export function removeTree(dir: string, options: RemoveTreeOptions = {}): void {
  const { attempts = 3, delayMs = 100, rm = rmRecursive } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= attempts || !RETRYABLE.has(code)) throw error;
      sleepSync(delayMs * attempt);
    }
  }
}
