// One duration parser for CLI flags (`--timeout 20m`, `--stuck-after 1h30m`)
// and plan fields (a slice TIMEBOX such as `45 minutes`).

const UNITS: ReadonlyArray<[RegExp, number]> = [
  [/^(?:ms|milliseconds?)$/u, 1],
  [/^(?:s|secs?|seconds?)$/u, 1000],
  [/^(?:m|mins?|minutes?)$/u, 60_000],
  [/^(?:h|hrs?|hours?)$/u, 3_600_000],
];

/**
 * `20m`, `30s`, `1500ms`, `1h`, `1h30m`, `45 minutes`, `2 hours`, or bare
 * seconds, in ms; null when it does not read as a duration.
 */
export function parseDuration(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Math.round(Number(text) * 1000);
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)\s*/gu)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) return null;
  let total = 0;
  for (const [, amount, unit] of parts) {
    const factor = UNITS.find(([pattern]) => pattern.test(unit))?.[1];
    if (factor === undefined) return null;
    total += Number(amount) * factor;
  }
  return Math.round(total);
}
