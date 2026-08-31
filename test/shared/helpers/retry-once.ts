// Retry-once wrapper for timing-sensitive e2e drives: Ink throttles frame
// writes on wall-clock timers, so a loaded CI can observe stale frames. Run
// once more on failure; if the retry also fails, rethrow the FIRST error so
// the original diagnosis is never masked by a secondary one.
export async function retryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (first) {
    try {
      return await run();
    } catch {
      throw first;
    }
  }
}
