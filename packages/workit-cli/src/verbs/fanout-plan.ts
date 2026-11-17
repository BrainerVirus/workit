// `workit fanout plan` problem lines a weak model can fix in one call: an
// enum field (reason, tier, fanIn) that holds no valid value names the value
// it got, the nearest valid one and every valid one, `a|b|c`.
import { REASONS, TIERS } from "@workit-dev/core/src/fanout";
import { closest } from "../help";

const SLICE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  reason: REASONS,
  tier: TIERS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The slice a core problem line names (`slice <id>` or `slice #<n>`). */
function sliceFor(raw: unknown, where: string): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.slices)) return undefined;
  const slices: unknown[] = raw.slices;
  const numbered = /^slice #(\d+)$/u.exec(where);
  if (numbered) {
    const item = slices[Number(numbered[1]) - 1];
    return isRecord(item) ? item : undefined;
  }
  const id = where.replace(/^slice /u, "");
  return slices.filter(isRecord).find((item) => item.id === id);
}

function explain(field: string, value: unknown, valid: readonly string[]): string {
  const got = typeof value === "string" ? value.trim() : value;
  const near = typeof got === "string" && got ? closest(got, valid) : null;
  const shown = got === undefined ? "nothing" : JSON.stringify(got);
  return `${field} must be one of ${valid.join("|")} (got ${shown}${near ? `; nearest: ${near}` : ""})`;
}

/**
 * Core's `<slice>: reason|tier must be one of a, b, c` lines, rewritten to name
 * the value the plan holds, the nearest valid one and every valid one. Other
 * lines pass through unchanged.
 */
export function explainPlanProblems(raw: unknown, problems: readonly unknown[]): unknown[] {
  return problems.map((problem) => {
    if (typeof problem !== "string") return problem;
    const match = /^(slice [^:]+): (reason|tier) must be one of /u.exec(problem);
    if (!match) return problem;
    const [, where, field] = match;
    return `${where}: ${explain(field, sliceFor(raw, where)?.[field], SLICE_ENUMS[field])}`;
  });
}
