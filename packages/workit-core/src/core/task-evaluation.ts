import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  POLICY_VERSION,
  candidateDigest,
  candidateSchema,
  decisionDigest,
  failure,
  scopeCovers as contractScopeCovers,
  success,
  type Candidate,
  type Capability,
  type Caller,
  type Decision,
  type EvidenceEvaluation,
  type Outcome,
  type Requirement,
  type Result,
  type Scope,
  type TaskRecord,
  type TaskView,
  type WorkspaceRecord,
} from "./task-contract";
import { verifyDecisionContentAtRoot } from "./authority";

export type CandidateEnvironment =
  | readonly (string | { name: string; value?: string | null })[]
  | Record<string, string | null | undefined>;

const digestBytes = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);
const relative = (root: string, candidate: string): string =>
  path.relative(root, candidate).split(path.sep).join("/") || ".";
const canonicalPath = (value: string): string | null => {
  if (typeof value !== "string" || !value) return null;
  if (value.includes("\\") || value.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/"))
    return null;
  return normalized === "." ? "." : normalized.replace(/\/$/, "");
};
const canonicalScope = (scope: Scope): Scope | null => {
  const paths = scope.paths.length ? scope.paths : ["."];
  const normalizedPaths = paths.map(canonicalPath);
  const normalizedExclusions = scope.exclusions.map(canonicalPath);
  if (
    normalizedPaths.some((value) => value === null) ||
    normalizedExclusions.some((value) => value === null)
  )
    return null;
  return {
    description: scope.description,
    paths: [...new Set(normalizedPaths as string[])],
    exclusions: [...new Set(normalizedExclusions as string[])],
  };
};
const excluded = (value: string, exclusions: string[]): boolean =>
  exclusions.some((item) => item === value || (item !== "." && value.startsWith(`${item}/`)));
const scopeMatches = (value: string, scope: Scope): boolean => {
  const normalized = canonicalScope(scope);
  if (!normalized) return false;
  const paths = normalized.paths;
  return (
    paths.some((item) => item === "." || value === item || value.startsWith(`${item}/`)) &&
    !excluded(value, normalized.exclusions)
  );
};
const pathRelevant = (value: string, scope: Scope): boolean => scopeMatches(value, scope);
const compareCodeUnits = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

type Inventory = { paths: string[]; uncertain: boolean };
const gitPaths = (root: string): Inventory => {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "buffer",
    },
  );
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    return { paths: [], uncertain: !/not a git repository/i.test(stderr) };
  }
  const paths = result.stdout
    ? result.stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((item) => item.split(path.sep).join("/"))
    : [];
  const stagedDeleted = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=D", "-z"],
    { cwd: root, encoding: "buffer" },
  );
  if (stagedDeleted.status !== 0) {
    const stderr = stagedDeleted.stderr?.toString("utf8") ?? "";
    if (!/not a git repository/i.test(stderr)) return { paths, uncertain: true };
  } else if (stagedDeleted.stdout) {
    paths.push(
      ...stagedDeleted.stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((item) => item.split(path.sep).join("/")),
    );
  }
  return { paths: [...new Set(paths)], uncertain: false };
};

const walk = (root: string, directory: string, output: Set<string>): boolean => {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return true;
  }
  let uncertain = false;
  for (const name of names) {
    if (name === ".git" || name === ".workit") continue;
    const target = path.join(directory, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      uncertain = true;
      continue;
    }
    const item = relative(root, target);
    output.add(item);
    if (stat.isDirectory() && !stat.isSymbolicLink())
      uncertain = walk(root, target, output) || uncertain;
  }
  return uncertain;
};

const scopeRoots = (root: string, scope: Scope): Result<string[]> => {
  const roots: string[] = [];
  for (const item of scope.paths.length ? scope.paths : ["."]) {
    const target = path.resolve(root, item);
    if (!inside(root, target)) return failure("invalid_input", "candidate scope escapes checkout");
    let ancestor = target;
    while (!fs.existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
    try {
      if (!inside(root, fs.realpathSync(ancestor)))
        return failure("invalid_input", "candidate scope escapes checkout");
    } catch {
      return failure("invalid_input", "candidate scope cannot be inspected");
    }
    roots.push(target);
  }
  return success(null, null, roots);
};

export function captureCandidate(
  root: string,
  scope: Scope,
  environment: CandidateEnvironment = [],
): Result<Candidate> {
  let checkout: string;
  try {
    checkout = fs.realpathSync(root);
  } catch {
    return failure("invalid_input", "candidate root does not exist");
  }
  const normalizedScope = canonicalScope(scope);
  if (!normalizedScope) return failure("invalid_input", "candidate scope is invalid");
  const roots = scopeRoots(checkout, normalizedScope);
  if (!roots.ok) return roots;
  const names = new Set<string>();
  let uncertain = false;
  for (const target of roots.data) {
    const item = relative(checkout, target);
    if (item === ".git" || item === ".workit") continue;
    names.add(item);
    if (!fs.existsSync(target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      uncertain = true;
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink())
      uncertain = walk(checkout, target, names) || uncertain;
  }
  const git = gitPaths(checkout);
  uncertain = git.uncertain || uncertain;
  for (const item of git.paths) if (scopeMatches(item, normalizedScope)) names.add(item);

  const files: Candidate["files"] = [];
  let completeness: Candidate["completeness"] = uncertain ? "uncertain" : "known";
  for (const item of [...names].sort()) {
    if (!scopeMatches(item, normalizedScope)) continue;
    const target = path.join(checkout, item);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(target);
        files.push({ path: item, kind: "symlink", digest: digestBytes(link), executable: null });
      } else if (stat.isFile()) {
        files.push({
          path: item,
          kind: "file",
          digest: digestBytes(fs.readFileSync(target)),
          executable: (stat.mode & 0o111) !== 0,
        });
      } else if (!stat.isDirectory()) {
        completeness = "uncertain";
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        files.push({ path: item, kind: "absent", digest: null, executable: null });
      } else completeness = "uncertain";
    }
  }
  const supplied = Array.isArray(environment)
    ? environment.map((value) =>
        typeof value === "string"
          ? { name: value, value: process.env[value] ?? null }
          : { name: value.name, value: value.value ?? null },
      )
    : Object.keys(environment as Record<string, string | null | undefined>).map((name) => ({
        name,
        value: (environment as Record<string, string | null | undefined>)[name] ?? null,
      }));
  const namesByEnvironment = supplied.map(({ name }) => name);
  if (
    new Set(namesByEnvironment).size !== namesByEnvironment.length ||
    namesByEnvironment.some((name) => typeof name !== "string" || !name)
  )
    return failure("invalid_input", "candidate environment names must be unique and non-empty");
  const values = supplied
    .sort((left, right) => compareCodeUnits(left.name, right.name))
    .map(({ name, value }) => ({ name, value, refs: [] }));
  if (values.some(({ value }) => value === null)) completeness = "uncertain";
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
  if (headResult.status !== 0 && !/not a git repository/i.test(headResult.stderr ?? ""))
    completeness = "uncertain";
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const partial: Candidate = {
    id: "0".repeat(64),
    scope: normalizedScope,
    completeness,
    files,
    environment: values,
    head,
  };
  const candidate = { ...partial, id: candidateDigest(partial) };
  const parsed = candidateSchema.safeParse(candidate);
  return parsed.success
    ? success(null, null, parsed.data)
    : failure("invalid_input", "captured candidate is invalid");
}

const fileMap = (candidate: Candidate): Map<string, Candidate["files"][number]> =>
  new Map(candidate.files.map((file) => [file.path, file]));
const changedPaths = (before: Candidate, after: Candidate): string[] => {
  const paths = new Set([...before.files, ...after.files].map((file) => file.path));
  const left = fileMap(before);
  const right = fileMap(after);
  const changed = [...paths].filter(
    (item) => JSON.stringify(left.get(item) ?? null) !== JSON.stringify(right.get(item) ?? null),
  );
  if (before.head !== after.head) changed.push(".");
  if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) changed.push(".");
  return changed;
};

const sessionFromRef = (value: unknown): { host: string; handle: string } | null => {
  if (typeof value !== "object" || value === null || (value as any).kind !== "host") return null;
  return typeof (value as any).host === "string" && typeof (value as any).handle === "string"
    ? { host: (value as any).host, handle: (value as any).handle }
    : null;
};
const sameSession = (left: { host: string; handle: string } | null, right: unknown): boolean => {
  const other = sessionFromRef(right);
  return (
    left !== null && other !== null && left.host === other.host && left.handle === other.handle
  );
};

const evidenceScopes = (task: TaskRecord, ids: string[]): Scope[] =>
  (task.policy?.requirements ?? [])
    .filter((requirement) => ids.includes(requirement.id))
    .map((requirement) => requirement.scope);

export function evaluateEvidence(
  task: TaskRecord,
  candidate: Candidate | null,
): EvidenceEvaluation[] {
  const current = candidate ?? task.candidates.at(-1) ?? null;
  return task.evidence.map((entry) => {
    const evidence = entry.data;
    if (evidence.result === "failed")
      return {
        evidenceId: entry.id,
        status: "failed" as const,
        reason: "failed evidence remains historical",
      };
    if (evidence.kind === "check" || evidence.kind === "review") {
      if (!evidence.beforeCandidateId || !evidence.candidateId)
        return {
          evidenceId: entry.id,
          status: "stale",
          reason: "check or review evidence lacks start and end candidates",
        };
      if (evidence.beforeCandidateId !== evidence.candidateId)
        return {
          evidenceId: entry.id,
          status: "stale",
          reason: "candidate changed during the check or review",
        };
    }
    if (!evidence.candidateId || !current)
      return {
        evidenceId: entry.id,
        status: evidence.result,
        reason: "evidence has no candidate binding",
      };
    const observed =
      task.candidates.find((item) => item.id === evidence.candidateId) ??
      (current.id === evidence.candidateId ? current : undefined);
    if (!observed || observed.completeness === "uncertain" || current.completeness === "uncertain")
      return { evidenceId: entry.id, status: "stale", reason: "candidate is missing or uncertain" };
    if (observed.id === current.id)
      return { evidenceId: entry.id, status: evidence.result, reason: "candidate is unchanged" };
    const scopes = evidenceScopes(task, evidence.requirementIds);
    const changed = changedPaths(observed, current);
    const environmentChanged =
      JSON.stringify(observed.environment) !== JSON.stringify(current.environment);
    if (
      !scopes.length ||
      environmentChanged ||
      changed.some((item) => scopes.some((scope) => pathRelevant(item, scope)))
    )
      return { evidenceId: entry.id, status: "stale", reason: "relevant candidate state changed" };
    return {
      evidenceId: entry.id,
      status: evidence.result,
      reason: "candidate changed outside evidence scope",
    };
  });
}

export const scopeCovers = contractScopeCovers;
const applicableDecision = (
  task: TaskRecord,
  workspace: WorkspaceRecord,
  requirement: Requirement,
  checkoutRoot?: string,
): Decision[] =>
  task.decisions
    .map((entry) => entry.data)
    .filter(
      (decision) =>
        decision.purpose === "limitation" &&
        decision.response === "approved" &&
        decision.revoked === null &&
        decision.binding.taskId === task.id &&
        decision.binding.workspaceId === workspace.id &&
        decision.requirementIds.includes(requirement.id) &&
        decision.binding.scope &&
        scopeCovers(decision.binding.scope, requirement.scope) &&
        decision.digest === decisionDigest(decision) &&
        (checkoutRoot ? verifyDecisionContentAtRoot(checkoutRoot, decision.binding).ok : true),
    );

const applicableRequirementDecision = (
  task: TaskRecord,
  workspace: WorkspaceRecord,
  requirement: Requirement,
  checkoutRoot?: string,
): { id: string }[] =>
  task.decisions
    .filter(
      ({ data }) =>
        data.purpose !== "limitation" &&
        data.response === "approved" &&
        data.revoked === null &&
        data.binding.taskId === task.id &&
        data.binding.workspaceId === workspace.id &&
        data.requirementIds.includes(requirement.id) &&
        scopeCovers(data.binding.scope, requirement.scope) &&
        data.digest === decisionDigest(data) &&
        (checkoutRoot ? verifyDecisionContentAtRoot(checkoutRoot, data.binding).ok : true),
    )
    .map(({ id }) => ({ id }));

const evidenceMatchesRequirement = (
  kind: EvidenceEvaluation["status"],
  evidenceKind: string,
  dimension: Requirement["dimension"],
): boolean => {
  if (kind !== "passed") return false;
  if (dimension === "testing" || dimension === "verification") return evidenceKind === "check";
  if (dimension === "review") return evidenceKind === "review";
  if (dimension === "investigation" || dimension === "challenge")
    return evidenceKind === "investigation";
  if (dimension === "artifacts" || dimension === "continuity") return evidenceKind === "artifact";
  return false;
};

export function evaluateRequirements(
  task: TaskRecord,
  workspace: WorkspaceRecord,
  capabilities: Capability[],
  candidate: Candidate | null = task.candidates.at(-1) ?? null,
  _caller?: Caller,
  checkoutRoot?: string,
) {
  const evidence = evaluateEvidence(task, candidate);
  if (task.policy && task.policy.policyVersion !== POLICY_VERSION)
    return task.policy.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: "unsatisfied" as const,
      evidenceIds: [],
      decisionIds: [],
      reason: "stored policy version is unsupported; reassessment is required",
    }));
  return (task.policy?.requirements ?? []).map((requirement) => {
    const related = task.evidence
      .map((entry, index) => ({ entry, evaluation: evidence[index] }))
      .filter(({ entry }) => entry.data.requirementIds.includes(requirement.id));
    const passed = related.filter(({ entry, evaluation }) => {
      if (!evidenceMatchesRequirement(evaluation.status, entry.data.kind, requirement.dimension))
        return false;
      if (
        (entry.data.kind === "check" || entry.data.kind === "review") &&
        (!entry.data.beforeCandidateId ||
          !entry.data.candidateId ||
          entry.data.beforeCandidateId !== entry.data.candidateId)
      )
        return false;
      if (requirement.dimension !== "review") return true;
      const reviewSession = sessionFromRef(entry.data.reviewContext);
      const implementationSession = sessionFromRef(task.intent.provenance.session);
      const sameImplementation = sameSession(reviewSession, implementationSession);
      const sameEvidenceSession = task.evidence.some(
        (other) => other.id !== entry.id && sameSession(reviewSession, other.provenance.session),
      );
      return (
        entry.data.kind === "review" &&
        reviewSession !== null &&
        sameSession(reviewSession, entry.provenance.session) &&
        !sameImplementation &&
        !sameEvidenceSession
      );
    });
    if (passed.length)
      return {
        requirementId: requirement.id,
        status: "satisfied" as const,
        evidenceIds: passed.map(({ entry }) => entry.id),
        decisionIds: [],
        reason: "fresh applicable evidence passed",
      };
    const decisions =
      requirement.dimension === "decisions"
        ? applicableRequirementDecision(task, workspace, requirement, checkoutRoot)
        : [];
    if (decisions.length)
      return {
        requirementId: requirement.id,
        status: "satisfied" as const,
        evidenceIds: [],
        decisionIds: decisions.map((decision) => decision.id),
        reason: "an applicable approved decision satisfies the requirement",
      };
    const limitations = requirement.acceptanceAllowed
      ? applicableDecision(task, workspace, requirement, checkoutRoot)
      : [];
    if (limitations.length)
      return {
        requirementId: requirement.id,
        status: "accepted_limitation" as const,
        evidenceIds: [],
        decisionIds: limitations.map(
          (decision) => task.decisions.find((entry) => entry.data === decision)!.id,
        ),
        reason: "an applicable approved limitation permits the missing evidence",
      };
    const unavailable = capabilities.some(
      (capability) =>
        capability.assurance === "unavailable" &&
        (capability.name === requirement.dimension || capability.surface === requirement.dimension),
    );
    return {
      requirementId: requirement.id,
      status: unavailable ? ("unavailable" as const) : ("unsatisfied" as const),
      evidenceIds: related.map(({ entry }) => entry.id),
      decisionIds: [],
      reason: unavailable ? "required capability is unavailable" : "no fresh passing evidence",
    };
  });
}

export type ClosureEvaluation = {
  outcome: Outcome;
  evidenceIds: string[];
  decisionIds: string[];
  requirementIds: string[];
};

export function evaluateClosure(
  requestedOutcome: Outcome,
  view: TaskView,
): Result<ClosureEvaluation> {
  if (requestedOutcome !== "stopped" && !view.task.policy)
    return failure("requirements_unsatisfied", "task has not been assessed");
  if (
    view.task.policy &&
    (view.task.policy as { policyVersion: string }).policyVersion !== POLICY_VERSION
  )
    return failure(
      "requirements_unsatisfied",
      "stored policy version is unsupported; reassessment is required",
    );
  const evaluations = view.requirements;
  const openFindings = view.task.findings.filter((entry) => entry.data.disposition === "open");
  if (requestedOutcome !== "stopped" && openFindings.length)
    return failure("requirements_unsatisfied", "open findings must be resolved before closure");
  if (requestedOutcome !== "stopped") {
    const evidenceById = new Map(view.evidence.map((entry) => [entry.evidenceId, entry.status]));
    for (const entry of view.task.findings) {
      if (entry.data.disposition === "fixed") {
        const verified = entry.data.resolution?.evidenceIds.some((id) => {
          const evidence = view.task.evidence.find((item) => item.id === id);
          return (
            evidenceById.get(id) === "passed" &&
            (evidence?.data.kind === "check" || evidence?.data.kind === "review")
          );
        });
        if (!verified)
          return failure("requirements_unsatisfied", "fixed findings require current verification");
      }
      if (entry.data.disposition === "deferred") {
        const valid = entry.data.resolution?.decisionIds.some((id) => {
          const decision = view.task.decisions.find((item) => item.id === id)?.data;
          return Boolean(
            decision &&
            decision.purpose === "limitation" &&
            decision.response === "approved" &&
            decision.revoked === null &&
            decision.digest === decisionDigest(decision) &&
            verifyDecisionContentAtRoot(view.workspace.root, decision.binding).ok &&
            decision.binding.taskId === view.task.id &&
            decision.binding.workspaceId === view.workspace.id &&
            scopeCovers(decision.binding.scope, entry.data.scope) &&
            decision.requirementIds.some((requirementId) =>
              view.task.policy?.requirements.some(
                (requirement) => requirement.id === requirementId && requirement.acceptanceAllowed,
              ),
            ),
          );
        });
        if (!valid)
          return failure(
            "requirements_unsatisfied",
            "deferred findings require an applicable limitation",
          );
      }
    }
  }
  const blocking = evaluations.filter(
    (item) => item.status === "unsatisfied" || item.status === "unavailable",
  );
  if (requestedOutcome !== "stopped" && blocking.length)
    return failure("requirements_unsatisfied", "applicable requirements are unsatisfied", {
      requirementIds: blocking.map((item) => item.requirementId),
    });
  const accepted = evaluations.filter((item) => item.status === "accepted_limitation");
  if (requestedOutcome === "verified" && accepted.length)
    return failure(
      "requirements_unsatisfied",
      "accepted limitations cannot be reported as verified",
      {
        requirementIds: accepted.map((item) => item.requirementId),
      },
    );
  const evidenceIds = [
    ...new Set([
      ...evaluations.flatMap((item) => item.evidenceIds),
      ...view.task.findings.flatMap((item) => item.data.resolution?.evidenceIds ?? []),
    ]),
  ];
  const decisionIds = [
    ...new Set([
      ...evaluations.flatMap((item) => item.decisionIds),
      ...view.task.findings.flatMap((item) => item.data.resolution?.decisionIds ?? []),
    ]),
  ];
  return success(null, null, {
    outcome:
      requestedOutcome === "stopped"
        ? "stopped"
        : accepted.length
          ? "accepted_limitations"
          : "verified",
    evidenceIds,
    decisionIds,
    requirementIds: evaluations.map((item) => item.requirementId),
  });
}
