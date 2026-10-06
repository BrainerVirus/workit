import {
  canonicalJson,
  failure,
  POLICY_VERSION,
  policyChangeSchema,
  policySchema,
  sha256,
  success,
  type Constraint,
  type Intent,
  type Judgment,
  type Policy,
  type PolicyChange,
  type Result,
} from "./task-contract";
import { deriveRequirements } from "./policy/derive";

export type ResolverInput = { intent: Intent; judgment: Judgment; constraints: Constraint[] };

/** The task policy for a judgment: derived requirements plus an input digest. */
export function resolvePolicy(input: ResolverInput): Result<Policy> {
  const ids = input.constraints.map((constraint) => constraint.id);
  if (new Set(ids).size !== ids.length)
    return failure("invalid_input", "constraint IDs must be unique", {
      fields: [{ path: "constraints", reason: "duplicate constraint id" }],
    });
  const policy: Policy = {
    policyVersion: POLICY_VERSION,
    inputDigest: sha256(
      canonicalJson({
        judgment: input.judgment,
        scope: input.intent.scope,
        constraints: input.constraints,
        policyVersion: POLICY_VERSION,
      }),
    ),
    requirements: deriveRequirements(input.judgment, input.intent.scope, input.constraints),
  };
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success)
    return failure("invalid_input", "resolved policy is invalid", {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        reason: issue.message,
      })),
    });
  return success(null, null, parsed.data);
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function diffPolicy(
  previous: Policy | null,
  next: Policy,
  reason: string,
  now: string,
): PolicyChange | null {
  if (!policySchema.safeParse(previous).success && previous !== null)
    throw new TypeError("previous policy is invalid");
  if (!policySchema.safeParse(next).success) throw new TypeError("next policy is invalid");
  const oldIds = new Set(previous?.requirements.map((item) => item.id) ?? []);
  const newIds = new Set(next.requirements.map((item) => item.id));
  const added = [...newIds].filter((id) => !oldIds.has(id)).toSorted(compareCodeUnits);
  const retired = [...oldIds].filter((id) => !newIds.has(id)).toSorted(compareCodeUnits);
  if (added.length === 0 && retired.length === 0) return null;
  const normalizedReason = reason.trim();
  const changeReason = retired.length
    ? `${normalizedReason || "policy reassessed"} (retired: ${retired.join(",")})`
    : normalizedReason || "policy reassessed";
  const change = {
    recordedAt: now,
    fromInputDigest: previous?.inputDigest ?? null,
    toInputDigest: next.inputDigest,
    added,
    retired,
    reason: changeReason,
  } satisfies PolicyChange;
  const parsed = policyChangeSchema.safeParse(change);
  if (!parsed.success) throw new TypeError("policy change is invalid");
  return parsed.data;
}
