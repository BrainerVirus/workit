import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  candidateDigest,
  decisionDigest,
  failure,
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

export type CandidateEnvironment = readonly string[] | Record<string, string | null | undefined>;

const digestBytes = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);
const relative = (root: string, candidate: string): string =>
  path.relative(root, candidate).split(path.sep).join("/") || ".";
const excluded = (value: string, exclusions: string[]): boolean =>
  exclusions.some((item) => item === value || (item !== "." && value.startsWith(`${item}/`)));
const scopeMatches = (value: string, scope: Scope): boolean => {
  const paths = scope.paths.length ? scope.paths : ["."];
  return (
    paths.some((item) => item === "." || value === item || value.startsWith(`${item}/`)) &&
    !excluded(value, scope.exclusions)
  );
};
const pathRelevant = (value: string, scope: Scope): boolean => scopeMatches(value, scope);

const gitPaths = (root: string): string[] => {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "buffer",
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((item) => item.split(path.sep).join("/"));
};

const walk = (root: string, directory: string, output: Set<string>): void => {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === ".git" || name === ".workit") continue;
    const target = path.join(directory, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    const item = relative(root, target);
    output.add(item);
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(root, target, output);
  }
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
  const roots = scopeRoots(checkout, scope);
  if (!roots.ok) return roots;
  const names = new Set<string>();
  for (const target of roots.data) {
    if (!fs.existsSync(target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    const item = relative(checkout, target);
    if (item === ".git" || item === ".workit") continue;
    names.add(item);
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(checkout, target, names);
  }
  for (const item of gitPaths(checkout)) if (scopeMatches(item, scope)) names.add(item);

  const files: Candidate["files"] = [];
  let completeness: Candidate["completeness"] = "known";
  for (const item of [...names].sort()) {
    if (!scopeMatches(item, scope)) continue;
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
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        files.push({ path: item, kind: "absent", digest: null, executable: null });
      } else completeness = "uncertain";
    }
  }
  const values = Array.isArray(environment)
    ? environment.map((name) => ({ name, value: process.env[name] ?? null, refs: [] }))
    : Object.keys(environment as Record<string, string | null | undefined>)
        .sort()
        .map((name) => ({
          name,
          value: (environment as Record<string, string | null | undefined>)[name] ?? null,
          refs: [],
        }));
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const partial: Candidate = {
    id: "0".repeat(64),
    scope,
    completeness,
    files,
    environment: values,
    head,
  };
  return success(null, null, { ...partial, id: candidateDigest(partial) });
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

const hostFromRef = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || (value as any).kind !== "host") return null;
  return typeof (value as any).host === "string" ? (value as any).host : null;
};

const evidenceScope = (task: TaskRecord, ids: string[]): Scope | null => {
  const scopes = (task.policy?.requirements ?? [])
    .filter((requirement) => ids.includes(requirement.id))
    .map((requirement) => requirement.scope);
  if (!scopes.length) return null;
  return {
    description: scopes.map((item) => item.description).join("; "),
    paths: [...new Set(scopes.flatMap((item) => item.paths))],
    exclusions: [...new Set(scopes.flatMap((item) => item.exclusions))],
  };
};

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
    if (!evidence.candidateId || !current)
      return {
        evidenceId: entry.id,
        status: evidence.result,
        reason: "evidence has no candidate binding",
      };
    const observed =
      task.candidates.find((item) => item.id === evidence.candidateId) ??
      (current.id === evidence.candidateId ? current : undefined);
    if (!observed || current.completeness === "uncertain")
      return { evidenceId: entry.id, status: "stale", reason: "candidate is missing or uncertain" };
    if (observed.id === current.id)
      return { evidenceId: entry.id, status: evidence.result, reason: "candidate is unchanged" };
    const scope = evidenceScope(task, evidence.requirementIds);
    if (!scope || changedPaths(observed, current).some((item) => pathRelevant(item, scope)))
      return { evidenceId: entry.id, status: "stale", reason: "relevant candidate state changed" };
    return {
      evidenceId: entry.id,
      status: evidence.result,
      reason: "candidate changed outside evidence scope",
    };
  });
}

const scopeCovers = (outer: Scope, inner: Scope): boolean => {
  const covers = (item: string): boolean =>
    outer.paths.some((base) => base === "." || item === base || item.startsWith(`${base}/`)) &&
    !excluded(item, outer.exclusions);
  return inner.paths.every(covers);
};
const applicableDecision = (
  task: TaskRecord,
  workspace: WorkspaceRecord,
  requirement: Requirement,
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
        decision.digest === decisionDigest(decision),
    );

export function evaluateRequirements(
  task: TaskRecord,
  workspace: WorkspaceRecord,
  capabilities: Capability[],
  candidate: Candidate | null = task.candidates.at(-1) ?? null,
  caller?: Caller,
) {
  const evidence = evaluateEvidence(task, candidate);
  return (task.policy?.requirements ?? []).map((requirement) => {
    const related = task.evidence
      .map((entry, index) => ({ entry, evaluation: evidence[index] }))
      .filter(({ entry }) => entry.data.requirementIds.includes(requirement.id));
    const passed = related.filter(({ entry, evaluation }) => {
      if (evaluation.status !== "passed") return false;
      if (requirement.dimension === "testing" && !entry.data.candidateId) return false;
      if (requirement.dimension !== "review") return true;
      const reviewHost = hostFromRef(entry.data.reviewContext);
      return (
        entry.data.kind === "review" &&
        reviewHost !== null &&
        (caller ? reviewHost !== caller.host : reviewHost !== entry.provenance.host)
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
    const decisions = requirement.acceptanceAllowed
      ? applicableDecision(task, workspace, requirement)
      : [];
    if (decisions.length)
      return {
        requirementId: requirement.id,
        status: "accepted_limitation" as const,
        evidenceIds: [],
        decisionIds: decisions.map(
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
  const evaluations = view.requirements;
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
  const evidenceIds = [...new Set(evaluations.flatMap((item) => item.evidenceIds))];
  const decisionIds = [...new Set(evaluations.flatMap((item) => item.decisionIds))];
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
