// The agent's policy judgment as sent: four flat calls with aliases, or a
// ≤6.x assessment (facts/signals/…), mapped leniently for one major (D17).
import { refOf } from "../operation-input";
import {
  failure,
  judgmentSchema,
  success,
  type Judgment,
  type Result,
  type RiskTier,
} from "../task-contract";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys compared without case, `_` or `-`: `needs_plan`, `Needs-Plan` → `needsplan`. */
const squash = (key: string) => key.toLowerCase().replace(/[_-]/g, "");
const ALIASES: Record<keyof Omit<Judgment, "refs" | "note"> | "note" | "refs", string[]> = {
  riskTier: ["risktier", "risk", "risklevel", "tier"],
  behaviorChange: ["behaviorchange", "behavior", "behaviour", "behaviourchange"],
  productChoiceOpen: ["productchoiceopen", "openproductchoice", "productchoice", "openchoice"],
  needsPlan: ["needsplan", "plan", "needsspec", "spec"],
  note: ["note", "notes", "reason", "why"],
  refs: ["refs", "ref", "references"],
};
const LEGACY_KEYS = new Set(["assessment", "facts", "signals", "consequences", "verification"]);

const RISK: Record<string, RiskTier> = {
  trivial: "trivial",
  low: "trivial",
  minor: "trivial",
  mechanical: "trivial",
  none: "trivial",
  normal: "normal",
  medium: "normal",
  med: "normal",
  moderate: "normal",
  high: "high",
  critical: "high",
  major: "high",
};
const YES = new Set(["true", "yes", "y", "1", "on"]);
const NO = new Set(["false", "no", "n", "0", "off", "none"]);

type Field = { ok: true; value: boolean } | { ok: false };
const flag = (value: unknown, unknownAs: boolean): Field => {
  if (typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number" && (value === 0 || value === 1))
    return { ok: true, value: value === 1 };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim().toLowerCase();
  if (YES.has(text)) return { ok: true, value: true };
  if (NO.has(text)) return { ok: true, value: false };
  if (text === "unknown" || text === "maybe") return { ok: true, value: unknownAs };
  return { ok: false };
};

/** A ≤6.x assessment's signals mapped onto the four judgments. */
const fromLegacy = (raw: Json): Partial<Judgment> => {
  const source = isObject(raw.assessment) ? raw.assessment : raw;
  const signals = isObject(source.signals) ? source.signals : {};
  const value = (name: string): unknown =>
    isObject(signals[name]) ? signals[name].value : undefined;
  const behaviorChange = value("behaviorChange") === true || value("behaviorChange") === "unknown";
  const consequences = Array.isArray(source.consequences) ? source.consequences : [];
  const severe = consequences.some(
    (item) =>
      isObject(item) &&
      ["security", "data", "public_contract", "operations"].includes(String(item.area)),
  );
  return {
    riskTier: severe
      ? "high"
      : value("mechanicalLowRisk") === true && !behaviorChange
        ? "trivial"
        : "normal",
    behaviorChange,
    productChoiceOpen: value("productChoiceOpen") === true,
    needsPlan: value("durableAgreementNeeded") === true || value("coordinationPlanNeeded") === true,
  };
};

const DEFAULT: Judgment = {
  riskTier: "normal",
  behaviorChange: false,
  productChoiceOpen: false,
  needsPlan: false,
  note: null,
  refs: [],
};

export type NormalizedJudgment = { judgment: Judgment; ignored: string[]; legacy: boolean };

/**
 * Map a judgment as sent onto the stored shape. Omitted judgments keep the
 * `previous` values and refs accumulate (a re-assessment can add only a plan ref), else the
 * defaults (normal risk, no behavior change, no open choice, no plan). A
 * ≤6.x assessment maps what it can and ignores the rest. Only an
 * unrecognizable value for a known judgment is invalid input.
 */
export function normalizeJudgment(
  raw: unknown,
  previous: Judgment | null,
): Result<NormalizedJudgment> {
  const input = isObject(raw) ? raw : {};
  const legacy = Object.keys(input).some((key) => LEGACY_KEYS.has(key));
  // Refs accumulate across re-assessments; a new note replaces the old one.
  const base: Judgment = { ...DEFAULT, ...previous, refs: [...(previous?.refs ?? [])] };
  const judgment: Judgment = legacy ? { ...base, ...fromLegacy(input) } : { ...base };
  const ignored: string[] = [];
  const fields: { path: string; reason: string }[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (LEGACY_KEYS.has(key)) continue;
    const name = (Object.keys(ALIASES) as (keyof typeof ALIASES)[]).find((field) =>
      ALIASES[field].includes(squash(key)),
    );
    if (!name) {
      ignored.push(key);
      continue;
    }
    if (name === "riskTier") {
      const tier = typeof value === "string" ? RISK[value.trim().toLowerCase()] : undefined;
      if (tier) judgment.riskTier = tier;
      else fields.push({ path: key, reason: "expected trivial|normal|high (or low|medium)" });
    } else if (name === "note") {
      judgment.note = typeof value === "string" && value.trim() ? value.trim() : null;
    } else if (name === "refs") {
      const items = Array.isArray(value) ? value : [value];
      judgment.refs.push(
        ...(items.filter((item) => item !== null && item !== "").map(refOf) as Judgment["refs"]),
      );
    } else {
      // `plan: docs/plans/x.md` both flags the plan and names it.
      if (
        name === "needsPlan" &&
        typeof value === "string" &&
        !flag(value, false).ok &&
        value.trim()
      ) {
        judgment.needsPlan = true;
        judgment.refs.push(refOf(value.trim()) as Judgment["refs"][number]);
        continue;
      }
      const parsed = flag(value, name === "behaviorChange");
      if (parsed.ok) judgment[name] = parsed.value;
      else fields.push({ path: key, reason: "expected true|false (yes|no accepted)" });
    }
  }
  if (fields.length) return failure("invalid_input", "judgment values are invalid", { fields });
  const seen = new Set<string>();
  judgment.refs = judgment.refs.filter((ref) => {
    const key = JSON.stringify(ref);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const parsed = judgmentSchema.safeParse(judgment);
  if (!parsed.success)
    return failure("invalid_input", "judgment is invalid", {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        reason: issue.message,
      })),
    });
  return success(null, null, { judgment: parsed.data, ignored, legacy });
}

/** Parse `key=value` tokens (`workit policy assess --judge behavior=yes risk=normal`). */
export const judgeTokens = (tokens: string[]): Json => {
  const out: Json = {};
  for (const token of tokens) {
    const at = token.indexOf("=");
    const key = at < 0 ? token : token.slice(0, at);
    const value = at < 0 ? "true" : token.slice(at + 1);
    if (!key) continue;
    if (ALIASES.refs.includes(squash(key)))
      out.refs = [...(Array.isArray(out.refs) ? out.refs : []), value];
    else out[key] = value;
  }
  return out;
};
