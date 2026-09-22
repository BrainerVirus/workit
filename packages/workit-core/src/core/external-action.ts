import {
  canonicalJson,
  failure,
  success,
  type Id,
  type Ref,
  type Result,
  type Revision,
  type Decision,
  type Entry,
  type TaskRecord,
  refSchema,
  sha256,
} from "./task-contract";
import { WorkitCore } from "./task-engine";
import { TaskStore } from "./task-store";
import { chainStepKey, normalizeChainSteps, type ChainStep } from "./authority";
import * as z from "zod";
import { execFileSync } from "node:child_process";

const chainStepSchema = z.union([
  z.string().min(1),
  z.object({ branch: z.string().min(1) }).strict(),
  z.object({ pr: z.literal(true) }).strict(),
]);

export type AuthorizedActionInput = {
  core: WorkitCore;
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  binding?: Decision["binding"];
  reserveObservation: unknown;
  settleObservation: (
    outcome: "succeeded" | "not_started" | "unknown",
    revisions?: { taskRevision: Revision; workspaceRevision: Revision },
  ) => unknown;
  refresh?: () => Pick<AuthorizedActionInput, "expectedRevision" | "expectedWorkspaceRevision">;
  step?: string;
  capability?: string;
  available?: boolean;
  failureOutcome?: "not_started" | "unknown";
};

export type ExternalActionResult<T> = Result<T>;

const externalActionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("git.branch_setup"),
      payload: z
        .object({
          action: z.enum(["setup", "reapply_stash"]).optional(),
          sdd_dir: z.string().optional(),
          target_branch: z.string().optional(),
          stash: z.enum(["yes", "no"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("git.commit"),
      payload: z
        .object({
          message: z.string().min(1).optional(),
          plan_steps: z.array(chainStepSchema).min(1).max(32).optional(),
          plan_branch: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("git.push"),
      payload: z.object({ branch: z.string().min(1).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("hosting.pull_request"),
      payload: z
        .object({
          title: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional(),
          target_branch: z.string().optional(),
          babysit: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("hosting.merge"),
      payload: z
        .object({
          target_branch: z.string().min(1).optional(),
          source_branch: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.update"),
      payload: z
        .object({
          issueId: z.string().min(1),
          markdown: z.string().min(1),
          minutes: z.number().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.time"),
      payload: z
        .object({
          issueId: z.string().min(1),
          minutes: z.number().positive(),
          text: z.string().optional(),
          dateMs: z.number().finite().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("youtrack.meeting"),
      payload: z
        .object({
          issueId: z.string().min(1),
          minutes: z.number().positive(),
          text: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("changelog.apply"),
      payload: z
        .object({
          entries: z
            .union([
              z.record(z.string(), z.array(z.string())),
              z.array(z.object({ category: z.string().min(1), text: z.string().min(1) }).strict()),
            ])
            .optional(),
          path: z.string().optional(),
          normalize_only: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("context.read"),
      payload: z
        .object({
          kind: z.enum([
            "git",
            "pr",
            "youtrack",
            "github_issue",
            "gitlab_issue",
            "changelog",
            "release",
            "affected",
          ]),
          range: z.string().optional(),
          issueId: z.string().optional(),
          issueUrl: z.string().optional(),
          issueRef: z.string().optional(),
          mode: z.string().optional(),
          specPath: z.string().optional(),
          planPath: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ExternalActionRequest = z.infer<typeof externalActionSchema>;

export type ExternalActionOperation = ExternalActionRequest["operation"];

export const externalActionRequest = (value: unknown): Result<ExternalActionRequest> => {
  const parsed = externalActionSchema.safeParse(value);
  return parsed.success
    ? success(null, null, parsed.data)
    : failure("invalid_input", "external action payload is invalid", {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          reason: issue.message,
        })),
      });
};
export type ExternalActionRunner = <T>(
  input: Omit<AuthorizedActionInput, "core">,
  effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
) => Promise<ExternalActionResult<T>>;
export type ExternalActionEffect = <T>(
  operation: string,
  effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
) => Promise<ExternalActionResult<T>>;
export type ExternalActionBinding = (
  operation: string,
) => Omit<AuthorizedActionInput, "core"> | ExternalActionResult<never>;

/**
 * Host adapters use this exact, canonical string as the native approval
 * binding. It deliberately includes the concrete target/payload so an
 * approved sentence cannot authorize a different effect by substring.
 */
export const externalActionDescriptor = (operation: string, payload: unknown): string =>
  canonicalJson({
    operation,
    payload,
    ...(payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "resolved" in payload &&
    payload.resolved &&
    typeof payload.resolved === "object" &&
    Array.isArray((payload.resolved as { steps?: unknown }).steps)
      ? { steps: (payload.resolved as { steps: string[] }).steps }
      : {}),
  });

/**
 * Plan reservations never execute a git commit. A git.commit whose resolved
 * payload carries a plan_steps array records the listed chain once and lets
 * each listed single commit execute later under that authorization. Adapters
 * must return plan success without running the commit effect, both for prior
 * approvals and standing auto-approval; otherwise the reservation fails as a
 * single commit requiring a message. Returns the listed count, else null.
 */
export const planReservationLength = (
  operation: string,
  descriptorPayload: unknown,
): number | null => {
  if (operation !== "git.commit") return null;
  const payload = (descriptorPayload ?? {}) as { plan_steps?: unknown };
  return Array.isArray(payload.plan_steps) ? payload.plan_steps.length : null;
};

/** Compact host-facing help for the fixed optional-action surface. */
export const externalActionHelp =
  "Fixed actions: git.branch_setup {action?,sdd_dir?,target_branch(required unless reapply_stash; the working branch to create or switch to),stash?}; git.commit {message?; plan_steps?: (string | {branch:string} | {pr:true})[]; plan_branch?}; git.push {branch?}; hosting.pull_request {title,body?,draft?,target_branch?,babysit?}; hosting.merge {target_branch?,source_branch?}; youtrack.update {issueId,markdown,minutes?}; youtrack.time {issueId,minutes,text?,dateMs?}; youtrack.meeting {issueId,minutes,text}; changelog.apply {entries?,path?,normalize_only?}; context.read {kind: git|pr|youtrack|github_issue|gitlab_issue|changelog|release|affected,range?,issueId?,issueUrl?,issueRef?,mode?,specPath?,planPath?}. context.read is read-only and needs no approval; all other operations require native approval (CLI uses a TTY; caller-unattested MCP cannot mutate).";

export const externalActionRef = (
  host: "opencode" | "pi" | "workit_cli",
  actor: string,
  descriptor: string,
): Ref => ({
  kind: "host",
  host,
  handle: `external:${sha256({ actor, descriptor }).slice(0, 32)}`,
});

export const externalActionState = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
) => {
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const candidates = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions
      .filter(
        (entry) =>
          entry.data.purpose === "action" &&
          entry.data.response === "approved" &&
          entry.data.revoked === null &&
          entry.data.binding.approvedContent === operation,
      )
      .map((entry) => ({ task, entry }));
  });
  if (candidates.length !== 1)
    return failure(
      "permission_denied",
      candidates.length === 0
        ? "no approved action is bound to the active task"
        : "multiple approved actions match the active task",
    );
  return success(workspace.data.revision, null, { ...candidates[0], workspace: workspace.data });
};

/** Find a prior decision for the same user-requested operation/payload even when its resolved target drifted. */
export const priorExternalAction = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
  payload: unknown,
) => {
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const candidates = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions
      .filter((entry) => {
        if (
          entry.data.purpose !== "action" ||
          entry.data.response !== "approved" ||
          entry.data.revoked !== null
        )
          return false;
        try {
          const descriptor = JSON.parse(entry.data.binding.approvedContent) as {
            operation?: unknown;
            payload?: Record<string, unknown>;
          };
          if (
            descriptor.operation !== operation ||
            !descriptor.payload ||
            typeof descriptor.payload !== "object"
          )
            return false;
          const storedPayload = { ...descriptor.payload };
          delete storedPayload.resolved;
          return canonicalJson(storedPayload) === canonicalJson(payload);
        } catch {
          return false;
        }
      })
      .map((entry) => ({ task, entry }));
  });
  if (candidates.length !== 1)
    return failure(
      "permission_denied",
      candidates.length === 0
        ? "no prior external action matches this request"
        : "multiple prior external actions match this request",
    );
  return success(workspace.data.revision, null, { ...candidates[0], workspace: workspace.data });
};

/** Parse a plan-commit authorization descriptor (one approved list per plan). */
export const planCommitDescriptor = (
  content: string,
): { steps: ChainStep[]; branch: string; snapshotHead: string | null } | null => {
  try {
    const value = JSON.parse(content) as {
      operation?: unknown;
      payload?: {
        plan_steps?: unknown;
        plan_branch?: unknown;
        resolved?: { head?: unknown; branch?: unknown };
      };
    };
    if (value.operation !== "git.commit" || !value.payload) return null;
    const steps = normalizeChainSteps(value.payload.plan_steps);
    const branch = value.payload.plan_branch;
    if (!steps || typeof branch !== "string" || !branch) return null;
    const head = value.payload.resolved?.head;
    return { steps, branch, snapshotHead: typeof head === "string" ? head : null };
  } catch {
    return null;
  }
};

/**
 * Chain lease: the recorded head must still be an ancestor of the current
 * HEAD — history only moved forward. Rebase/reset underneath an approved
 * chain invalidates it instead of executing on rewritten history.
 */
export const chainLeaseValid = (store: TaskStore, snapshotHead: string | null): boolean => {
  if (!snapshotHead) return true;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: store.root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (head === snapshotHead) return true;
    execFileSync("git", ["merge-base", "--is-ancestor", snapshotHead, head], {
      cwd: store.root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
};

export type PlanCommitAuthorization = {
  task: TaskRecord;
  entry: Entry<Decision>;
  steps: ChainStep[];
  branch: string;
  snapshotHead: string | null;
  completed: string[];
};

/**
 * Find the single active plan-commit authorization whose next unconsumed step
 * is this exact commit message. Consumption order is enforced so each listed
 * commit executes once, in plan order; unlisted or replayed messages find no
 * authorization and require a fresh exact approval. Typed chain positions
 * never match messages (a pathological message falls through to a fresh
 * approval instead of consuming the wrong step), and a rewritten history
 * breaks the lease.
 */
export const approvedPlanCommit = (
  store: TaskStore,
  host: string,
  actor: string,
  message: string,
): Result<PlanCommitAuthorization> => {
  if (typeof message !== "string" || !message)
    return failure("invalid_input", "commit message is required");
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const matches = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions.flatMap((entry) => {
      const decision = entry.data;
      if (
        decision.purpose !== "action" ||
        decision.response !== "approved" ||
        decision.revoked !== null
      )
        return [];
      if (entry.provenance.kind !== "host_observed" || entry.provenance.receipts.length === 0)
        return [];
      const plan = planCommitDescriptor(decision.binding.approvedContent);
      if (!plan) return [];
      const completed =
        task.actionProgress?.find((progress) => progress.decisionId === entry.id)?.completedSteps ??
        [];
      const next = plan.steps[completed.length];
      if (!next || next.kind !== "commit" || next.message !== message) return [];
      if (!chainLeaseValid(store, plan.snapshotHead)) return [];
      return [
        {
          task,
          entry,
          steps: plan.steps,
          branch: plan.branch,
          snapshotHead: plan.snapshotHead,
          completed: [...completed],
        },
      ];
    });
  });
  if (matches.length !== 1)
    return failure(
      "permission_denied",
      matches.length === 0
        ? "no plan commit authorization matches this message"
        : "multiple plan authorizations match this message",
    );
  return success(workspace.data.revision, null, matches[0]);
};

export type ChainStepQuery =
  | { operation: "git.branch_setup"; target: string }
  | { operation: "hosting.pull_request" };

/** Match the next branch or PR step of an active chain authorization. */
export const approvedChainStep = (
  store: TaskStore,
  host: string,
  actor: string,
  query: ChainStepQuery,
): Result<PlanCommitAuthorization> => {
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const matches = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions.flatMap((entry) => {
      const decision = entry.data;
      if (
        decision.purpose !== "action" ||
        decision.response !== "approved" ||
        decision.revoked !== null
      )
        return [];
      if (entry.provenance.kind !== "host_observed" || entry.provenance.receipts.length === 0)
        return [];
      const plan = planCommitDescriptor(decision.binding.approvedContent);
      if (!plan) return [];
      const completed =
        task.actionProgress?.find((progress) => progress.decisionId === entry.id)?.completedSteps ??
        [];
      const next = plan.steps[completed.length];
      if (!next) return [];
      if (query.operation === "git.branch_setup") {
        if (next.kind !== "branch" || next.target !== query.target) return [];
      } else if (next.kind !== "pr") {
        return [];
      }
      if (!chainLeaseValid(store, plan.snapshotHead)) return [];
      return [
        {
          task,
          entry,
          steps: plan.steps,
          branch: plan.branch,
          snapshotHead: plan.snapshotHead,
          completed: [...completed],
        },
      ];
    });
  });
  if (matches.length !== 1)
    return failure(
      "permission_denied",
      matches.length === 0
        ? "no chain authorization matches this step"
        : "multiple chain authorizations match this step",
    );
  return success(workspace.data.revision, null, matches[0]);
};

export const commitMessageFromDescriptor = (operation: string): string | undefined => {
  try {
    const descriptor = JSON.parse(operation) as {
      operation?: unknown;
      payload?: { message?: unknown };
    };
    return descriptor.operation === "git.commit" && typeof descriptor.payload?.message === "string"
      ? descriptor.payload.message
      : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve a chain authorization into the exact binding an adapter needs
 * to run one branch or PR step under the approved chain. Commit steps stay
 * on the plan path; this covers the steps plans could never express. */
export const chainStepBinding = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
): {
  taskId: Id;
  decisionId: Id;
  binding: Decision["binding"];
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  step: string;
} | null => {
  let descriptor: { operation?: unknown; payload?: Record<string, unknown> };
  try {
    descriptor = JSON.parse(operation) as {
      operation?: unknown;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
  const query: ChainStepQuery | null =
    descriptor.operation === "git.branch_setup" &&
    typeof descriptor.payload?.target_branch === "string"
      ? { operation: "git.branch_setup", target: descriptor.payload.target_branch as string }
      : descriptor.operation === "hosting.pull_request"
        ? { operation: "hosting.pull_request" }
        : null;
  if (!query) return null;
  const chain = approvedChainStep(store, host, actor, query);
  if (!chain.ok) return null;
  // PR steps run on the chain branch; the branch step itself creates it.
  if (query.operation === "hosting.pull_request") {
    let branch: string;
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: store.root,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
    if (!branch || branch !== chain.data.branch) return null;
  }
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) return null;
  const next = chain.data.steps[chain.data.completed.length];
  if (!next) return null;
  return {
    taskId: chain.data.task.id,
    decisionId: chain.data.entry.id,
    binding: chain.data.entry.data.binding,
    expectedRevision: chain.data.task.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    step: chainStepKey(next),
  };
};

/** Resolve a plan-commit authorization into the exact binding an adapter needs
 * to run one listed commit under the approved list. */
export const planCommitBinding = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
): {
  taskId: Id;
  decisionId: Id;
  binding: Decision["binding"];
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  step: string;
} | null => {
  const message = commitMessageFromDescriptor(operation);
  if (!message) return null;
  const plan = approvedPlanCommit(store, host, actor, message);
  if (!plan.ok) return null;
  let branch: string;
  try {
    branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: store.root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
  if (!branch || branch !== plan.data.branch) return null;
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) return null;
  return {
    taskId: plan.data.task.id,
    decisionId: plan.data.entry.id,
    binding: plan.data.entry.data.binding,
    expectedRevision: plan.data.task.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    step: message,
  };
};

export const approvedExternalAction = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
) => {
  const selected = externalActionState(store, host, actor, operation);
  if (selected.ok) {
    if (selected.data.entry.data.consumption !== null)
      return failure(
        selected.data.entry.data.consumption.state === "uncertain"
          ? "external_outcome_unknown"
          : "permission_denied",
        selected.data.entry.data.consumption.state === "uncertain"
          ? "previous external action outcome is unknown"
          : "external action was already settled",
      );
    return selected;
  }
  // Intent carry for branch setup: an approval binds (target, base) intent,
  // so unrelated HEAD or dirt moves between approval and execution re-resolve
  // instead of demanding re-approval. Remote, existence, and target drift
  // still fail closed through priorResolvedDrift.
  const intent = approvedBranchSetupIntent(store, host, actor, operation);
  if (intent.ok) {
    if (intent.data.entry.data.consumption !== null)
      return failure(
        intent.data.entry.data.consumption.state === "uncertain"
          ? "external_outcome_unknown"
          : "permission_denied",
        intent.data.entry.data.consumption.state === "uncertain"
          ? "previous external action outcome is unknown"
          : "external action was already settled",
      );
    return intent;
  }
  return selected;
};

/** Intent identity for a branch-setup descriptor: target and base bind the
 * effect; head and dirt are execution-time state that re-resolves. */
export const branchSetupIntent = (
  descriptor: string,
): { target: string; base: string; remoteBase: string | null; targetExists: boolean } | null => {
  try {
    const value = JSON.parse(descriptor) as {
      operation?: unknown;
      payload?: {
        target_branch?: unknown;
        resolved?: {
          base_branch?: unknown;
          remote_base?: unknown;
          target_exists?: unknown;
        };
      };
    };
    if (value.operation !== "git.branch_setup" || !value.payload) return null;
    const { target_branch, resolved } = value.payload;
    if (typeof target_branch !== "string" || !target_branch || !resolved) return null;
    if (typeof resolved.base_branch !== "string" || typeof resolved.target_exists !== "boolean")
      return null;
    return {
      target: target_branch,
      base: resolved.base_branch,
      remoteBase: typeof resolved.remote_base === "string" ? resolved.remote_base : null,
      targetExists: resolved.target_exists,
    };
  } catch {
    return null;
  }
};

/** Find the single unconsumed branch-setup approval with the same intent as
 * the current descriptor, regardless of head or dirt moves since approval. */
export const approvedBranchSetupIntent = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
) => {
  const current = branchSetupIntent(operation);
  if (!current)
    return failure("permission_denied", "no approved action is bound to the active task");
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok)
    return failure("storage_error", "external action state is unavailable");
  if (!workspace.data) return failure("not_found", "workspace not found");
  const candidates = listed.data.flatMap((task) => {
    if (task.status !== "active" || task.workspaceId !== workspace.data!.id) return [];
    return task.decisions
      .filter(
        (entry) =>
          entry.data.purpose === "action" &&
          entry.data.response === "approved" &&
          entry.data.revoked === null,
      )
      .map((entry) => ({ task, entry }));
  });
  const matches = candidates.filter(({ entry }) => {
    const intent = branchSetupIntent(entry.data.binding.approvedContent);
    return (
      intent !== null &&
      intent.target === current.target &&
      intent.base === current.base &&
      intent.remoteBase === current.remoteBase &&
      intent.targetExists === current.targetExists
    );
  });
  if (matches.length !== 1)
    return failure(
      "permission_denied",
      matches.length === 0
        ? "no approved action is bound to the active task"
        : "multiple approved actions match the active task",
    );
  return success(workspace.data.revision, null, { ...matches[0], workspace: workspace.data });
};

/**
 * Re-resolve guard: when a prior approval exists for the same requested
 * operation/payload, the intent baseline must still match. For branch setup
 * only (target, base, remote base, existence) bind the effect — head and
 * dirt moves re-resolve instead of demanding re-approval. Drift names the
 * moved element and returns not_started so the agent re-presents the
 * current state instead of executing a stale effect.
 */
export const priorResolvedDrift = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
  payload: unknown,
  currentResolved: unknown,
): Result<null> => {
  const prior = priorExternalAction(store, host, actor, operation, payload);
  if (!prior.ok) return success(null, null, null);
  let baseline: unknown;
  try {
    const parsed = JSON.parse(prior.data.entry.data.binding.approvedContent) as {
      payload?: { resolved?: unknown };
    };
    baseline = parsed.payload?.resolved;
  } catch {
    return success(null, null, null);
  }
  if (baseline === undefined || baseline === null) return success(null, null, null);
  if (operation === "git.branch_setup") {
    const before = branchSetupIntent(prior.data.entry.data.binding.approvedContent);
    let after: ReturnType<typeof branchSetupIntent> = null;
    try {
      after = branchSetupIntent(
        JSON.stringify({
          operation,
          payload: { ...(payload as Record<string, unknown>), resolved: currentResolved },
        }),
      );
    } catch {
      after = null;
    }
    if (before && after) {
      const moved =
        before.target !== after.target
          ? "target_branch"
          : before.base !== after.base
            ? "base_branch"
            : before.remoteBase !== after.remoteBase
              ? "remote_base"
              : before.targetExists !== after.targetExists
                ? "target_exists"
                : null;
      if (moved === null) return success(null, null, null);
      return failure(
        "invalid_input",
        `repository state changed since approval (${moved} moved); show the current state and approve the action again`,
        { outcome: "not_started", operation },
      );
    }
  }
  if (canonicalJson(baseline) === canonicalJson(currentResolved)) return success(null, null, null);
  return failure(
    "invalid_input",
    "repository state changed since approval; show the current state and approve the action again",
    { outcome: "not_started", operation },
  );
};

export const createAuthorizedExternalActionRunner =
  (core: WorkitCore, bind: ExternalActionBinding): ExternalActionEffect =>
  async <T>(
    operation: string,
    effect: (step?: string) => T | Result<T> | Promise<T | Result<T>>,
  ) => {
    let steps: string[] = [];
    try {
      const parsed = JSON.parse(operation) as { steps?: unknown };
      if (Array.isArray(parsed.steps) && parsed.steps.every((step) => typeof step === "string"))
        steps = parsed.steps;
    } catch {
      /* non-descriptor callers remain one-shot */
    }
    const sequence = steps.length ? steps : [undefined];
    let latest: ExternalActionResult<T> | undefined;
    for (const step of sequence) {
      const binding = bind(operation);
      if ("ok" in binding) return binding as ExternalActionResult<T>;
      const result = await runAuthorizedExternalAction(
        { core, ...(binding as Omit<AuthorizedActionInput, "core">), ...(step ? { step } : {}) },
        () => effect(step),
      );
      latest = result;
      if (!result.ok) return result;
    }
    return latest ?? failure("recovery_required", "external action did not execute");
  };

export type NativeExternalActionObservation = {
  actor: string;
  actionRef: Ref;
  outcome: "reserve" | "succeeded" | "not_started" | "unknown";
  callId?: string;
  taskRevision?: Revision;
  workspaceRevision?: Revision;
};

export const nativeExternalActionObservation = (
  actor: string,
  actionRef: Ref,
  outcome: NativeExternalActionObservation["outcome"],
  callId = actionRef.kind === "host" ? actionRef.handle : "external-action",
  revisions?: { taskRevision: Revision; workspaceRevision: Revision },
): NativeExternalActionObservation =>
  revisions
    ? { actor, actionRef, outcome, callId, ...revisions }
    : { actor, actionRef, outcome, callId };

export const readNativeExternalActionObservation = (
  value: unknown,
): NativeExternalActionObservation | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.actor !== "string" ||
    !refSchema.safeParse(candidate.actionRef).success ||
    !["reserve", "succeeded", "not_started", "unknown"].includes(String(candidate.outcome)) ||
    (candidate.callId !== undefined && typeof candidate.callId !== "string") ||
    (candidate.taskRevision !== undefined && typeof candidate.taskRevision !== "string") ||
    (candidate.workspaceRevision !== undefined && typeof candidate.workspaceRevision !== "string")
  )
    return null;
  return {
    actor: candidate.actor,
    actionRef: candidate.actionRef as Ref,
    outcome: candidate.outcome as NativeExternalActionObservation["outcome"],
    ...(candidate.callId === undefined ? {} : { callId: candidate.callId }),
    ...(candidate.taskRevision === undefined
      ? {}
      : { taskRevision: candidate.taskRevision as Revision }),
    ...(candidate.workspaceRevision === undefined
      ? {}
      : { workspaceRevision: candidate.workspaceRevision as Revision }),
  };
};

export const matchesNativeExternalAction = (
  value: unknown,
  expected: {
    actor: string;
    actionRef: Ref;
    outcome: NativeExternalActionObservation["outcome"];
    taskRevision?: Revision;
    workspaceRevision?: Revision;
  },
): boolean => {
  const observation = readNativeExternalActionObservation(value);
  return (
    observation !== null &&
    observation.actor === expected.actor &&
    observation.outcome === expected.outcome &&
    (expected.taskRevision === undefined || observation.taskRevision === expected.taskRevision) &&
    (expected.workspaceRevision === undefined ||
      observation.workspaceRevision === expected.workspaceRevision) &&
    canonicalJson(observation.actionRef) === canonicalJson(expected.actionRef)
  );
};

/**
 * Run one concrete, already-authorized external effect through the core's
 * one-time reservation and settlement transitions. The adapter supplies the
 * host-observed action evidence; this helper never turns an arbitrary payload
 * into an external effect and never retries an uncertain outcome.
 */
export async function runAuthorizedExternalAction<T>(
  input: AuthorizedActionInput,
  effect: () => T | Result<T> | Promise<T | Result<T>>,
): Promise<ExternalActionResult<T>> {
  if (input.core.isDelegatedCaller())
    return failure("permission_denied", "delegated workers cannot run external actions");
  if (input.available === false)
    return failure(
      "capability_unavailable",
      `${input.capability ?? "external action"} is unavailable`,
      { capability: input.capability ?? "external_action" },
    );

  const reserved = input.core.reserveAction({
    taskId: input.taskId,
    decisionId: input.decisionId,
    actionRef: input.actionRef,
    expectedRevision: input.expectedRevision,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.step ? { step: input.step } : {}),
    observation: input.reserveObservation,
  });
  if (!reserved.ok) return reserved as ExternalActionResult<T>;

  const settle = (
    outcome: "succeeded" | "not_started" | "unknown",
    refreshed = false,
  ): ExternalActionResult<unknown> => {
    try {
      const revisions =
        refreshed && input.refresh
          ? input.refresh()
          : {
              expectedRevision: reserved.data.taskRevision,
              expectedWorkspaceRevision: reserved.data.workspaceRevision,
            };
      return input.core.settleAction({
        ...reserved.data,
        taskRevision: revisions.expectedRevision,
        workspaceRevision: revisions.expectedWorkspaceRevision,
        outcome,
        ...(input.step ? { step: input.step } : {}),
        observation: input.settleObservation(outcome, {
          taskRevision: revisions.expectedRevision,
          workspaceRevision: revisions.expectedWorkspaceRevision,
        }),
      });
    } catch {
      return failure("external_outcome_unknown", "external action settlement is unavailable", {
        operation: "external_action",
        outcome: "unknown",
      });
    }
  };
  const settleWithRefresh = (
    outcome: "succeeded" | "not_started" | "unknown",
    first: ExternalActionResult<unknown>,
  ): ExternalActionResult<unknown> =>
    !first.ok && first.code === "revision_conflict" && input.refresh
      ? settle(outcome, true)
      : first;

  let effectValue: T | Result<T>;
  try {
    effectValue = await effect();
  } catch {
    const settled = settleWithRefresh("unknown", settle("unknown"));
    if (!settled.ok) return settled as ExternalActionResult<T>;
    return failure("external_outcome_unknown", "external action outcome is unknown", {
      operation: "external_action",
      outcome: "unknown",
    });
  }
  if (
    typeof effectValue === "object" &&
    effectValue !== null &&
    "ok" in effectValue &&
    typeof (effectValue as { ok?: unknown }).ok === "boolean"
  ) {
    const contract = effectValue as Result<T>;
    if (!contract.ok) {
      const preflight =
        typeof contract.details === "object" &&
        contract.details !== null &&
        (contract.details as Record<string, unknown>).outcome === "not_started";
      const outcome = input.failureOutcome ?? (preflight ? "not_started" : "unknown");
      const settled = settleWithRefresh(outcome, settle(outcome));
      if (!settled.ok) return settled as ExternalActionResult<T>;
      return contract;
    }
    effectValue = contract.data;
  }
  const settled = settleWithRefresh("succeeded", settle("succeeded"));
  if (!settled.ok) return settled as ExternalActionResult<T>;
  return {
    ok: true,
    schemaVersion: 1,
    revision: settled.revision,
    workspaceRevision: settled.workspaceRevision,
    data: effectValue as T,
  };
}
