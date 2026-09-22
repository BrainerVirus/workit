import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveWorkspaceFrom, type WorkspaceConfig } from "./workspaces";
import { configDir } from "./config";
import { verifyPushIdentity } from "./branch";
import {
  failure,
  success,
  type Caller,
  type Id,
  type Provenance,
  type Result,
  type Revision,
  type TaskRecord,
} from "./task-contract";
import { TaskStore } from "./task-store";
import type { WorkitCore } from "./task-engine";
import type { Decision } from "./task-contract";
import { currentWriterOwnsTask } from "./workers";

/** Action classes auto-approval can cover. Unknown classes never match. */
export const AUTO_CLASSES = ["branch", "commit", "push", "pr", "merge"] as const;
export type AutoClass = (typeof AUTO_CLASSES)[number];

export type AutoApproval =
  | { status: "off" }
  | {
      status: "on";
      workspace: string;
      classes: AutoClass[];
      account: string | null;
      configDigest: string | null;
    };

export type StandingReceipt = {
  kind: "standing";
  workspace: string;
  class: string;
  configDigest: string | null;
};

const OPERATION_CLASS: Record<string, AutoClass> = {
  "git.branch_setup": "branch",
  "git.commit": "commit",
  "git.push": "push",
  "hosting.pull_request": "pr",
  "hosting.merge": "merge",
};

/** Map an external-action operation to its auto-approval class, if any. */
export const operationAutoClass = (operation: unknown): AutoClass | null =>
  typeof operation === "string" ? (OPERATION_CLASS[operation] ?? null) : null;

const digestOf = (configDirPath: string): string | null => {
  try {
    const raw = readFileSync(`${configDirPath}/workspaces.json`, "utf8");
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
};

const normalizeClasses = (value: unknown): AutoClass[] => {
  if (value === true) return [...AUTO_CLASSES];
  if (!Array.isArray(value)) return [];
  const seen = new Set<AutoClass>();
  for (const item of value) {
    if (typeof item === "string" && (AUTO_CLASSES as readonly string[]).includes(item))
      seen.add(item as AutoClass);
  }
  return [...seen];
};

/** Resolve the auto-approval rule for a checkout root (live read, never cached). */
export const resolveAutoApproval = (root: string, dir: string = configDir()): AutoApproval => {
  let match: WorkspaceConfig | null;
  try {
    match = resolveWorkspaceFrom(root, dir);
  } catch {
    return { status: "off" };
  }
  if (!match) return { status: "off" };
  const classes = normalizeClasses(match.autoApprove);
  if (classes.length === 0) return { status: "off" };
  return {
    status: "on",
    workspace: match.name,
    classes,
    account: typeof match.vcs?.account === "string" && match.vcs.account ? match.vcs.account : null,
    configDigest: digestOf(dir),
  };
};

/** True when the workspace rule covers the class right now. */
export const autoApproves = (root: string, cls: unknown, dir?: string): boolean => {
  if (typeof cls !== "string" || !(AUTO_CLASSES as readonly string[]).includes(cls)) return false;
  const resolved = resolveAutoApproval(root, dir);
  return resolved.status === "on" && resolved.classes.includes(cls as AutoClass);
};

const isStandingReceipt = (value: unknown): value is StandingReceipt =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "standing";

/**
 * A standing receipt authorizes only while the referenced workspace rule
 * still covers the class. Removing the flag (or narrowing the list) fails
 * closed on the very next reserve — no revocation step needed.
 */
export const standingApprovalLive = (
  root: string,
  receipt: unknown,
  cls: unknown,
  dir?: string,
): boolean => {
  if (!isStandingReceipt(receipt)) return false;
  if (typeof cls !== "string" || !(AUTO_CLASSES as readonly string[]).includes(cls)) return false;
  if (receipt.class !== cls) return false;
  const resolved = resolveAutoApproval(root, dir);
  if (resolved.status !== "on") return false;
  if (resolved.workspace !== receipt.workspace) return false;
  return resolved.classes.includes(cls as AutoClass);
};

/** Build the receipt an auto-recorded decision carries (current digest). */
export const standingReceiptFor = (
  root: string,
  workspace: string,
  cls: AutoClass,
  dir?: string,
): StandingReceipt => {
  const resolved = resolveAutoApproval(root, dir);
  return {
    kind: "standing",
    workspace,
    class: cls,
    configDigest:
      resolved.status === "on" && resolved.workspace === workspace ? resolved.configDigest : null,
  };
};

/**
 * Verify a standing approval record request: active task, lead session
 * match (helpers never auto-approve), operation class equals the claimed
 * class, rule live right now, push identity enforced for push.
 * Returns the host-observed provenance the entry carries on success.
 */
export const verifyStandingApproval = (
  root: string,
  task: TaskRecord,
  caller: Caller,
  binding: {
    standing?: { workspace?: unknown; class?: unknown };
    approvedContent?: unknown;
  },
): Result<Provenance> => {
  if (task.status !== "active")
    return failure("invalid_transition", "only active tasks can authorize actions");
  const workspace = new TaskStore(root).readWorkspace();
  if (!workspace.ok) return workspace as Result<never>;
  if (!workspace.data || !currentWriterOwnsTask(task, workspace.data, caller))
    return failure("permission_denied", "standing approval requires the current writer session");
  const standing = binding.standing;
  if (!standing || typeof standing.workspace !== "string" || typeof standing.class !== "string")
    return failure("invalid_input", "standing approval needs a workspace and class");
  let operation: unknown;
  try {
    operation =
      typeof binding.approvedContent === "string"
        ? (JSON.parse(binding.approvedContent) as { operation?: unknown }).operation
        : null;
  } catch {
    operation = null;
  }
  const cls = operationAutoClass(operation);
  if (!cls || cls !== standing.class)
    return failure("permission_denied", "standing approval does not cover this operation");
  const resolved = resolveAutoApproval(root);
  if (
    resolved.status !== "on" ||
    resolved.workspace !== standing.workspace ||
    !resolved.classes.includes(cls)
  )
    return failure("permission_denied", "standing auto-approval is not live for this operation");
  if (cls === "push") {
    const workspace = resolveWorkspaceFrom(root, configDir());
    const provider = workspace?.vcs?.provider;
    const account = resolved.account;
    if (!provider || !account)
      return failure(
        "permission_denied",
        "auto-push requires a workspace provider and area account",
      );
    const identity = verifyPushIdentity(root, provider, account);
    if (!identity.ok) return failure("permission_denied", identity.error);
  }
  return success(null, null, {
    kind: "host_observed",
    host: caller.host,
    session: { kind: "host", host: caller.host, handle: caller.actor },
    workerId: null,
    receipts: [standingReceiptFor(root, standing.workspace, cls)],
  } as Provenance);
};

export type StandingAutoBinding = {
  taskId: Id;
  decisionId: Id;
  binding: Decision["binding"];
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  step?: string;
};

type StandingMatch = {
  task: TaskRecord;
  workspaceId: Id;
  workspaceRevision: Revision;
  cls: AutoClass;
  workspaceName: string;
};

/**
 * Dry-run half of standingAutoBinding: same matching, no recording. Tool
 * gates use this to decide between executing and asking; the runner records.
 */
export const standingAutoApplies = (
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
): StandingMatch | null => {
  let descriptor: { operation?: unknown };
  try {
    descriptor = JSON.parse(operation) as { operation?: unknown };
  } catch {
    return null;
  }
  const cls = operationAutoClass(descriptor.operation);
  if (!cls || !autoApproves(store.root, cls)) return null;
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !workspace.ok || !workspace.data) return null;
  const matches = listed.data.filter(
    (task) => task.status === "active" && task.workspaceId === workspace.data!.id,
  );
  if (matches.length !== 1) return null;
  const resolved = resolveAutoApproval(store.root);
  if (resolved.status !== "on") return null;
  return {
    task: matches[0],
    workspaceId: workspace.data.id,
    workspaceRevision: workspace.data.revision,
    cls,
    workspaceName: resolved.workspace,
  };
};

/**
 * Shared adapter path: resolve one gated operation under the workspace
 * standing rule without asking. Returns the exact binding the runner needs
 * for reserve/settle, or null when anything is uncovered, ambiguous, or
 * unresolvable — callers fall through to the question proposal.
 *
 * Single active task per session (ambiguity asks), plan-before-mutation
 * (no task asks), guardrails enforced at record time, revocation instant.
 */
export const standingAutoBinding = (
  core: WorkitCore,
  store: TaskStore,
  host: string,
  actor: string,
  operation: string,
): StandingAutoBinding | null => {
  let descriptor: { operation?: unknown };
  try {
    descriptor = JSON.parse(operation) as { operation?: unknown };
  } catch {
    return null;
  }
  const cls = operationAutoClass(descriptor.operation);
  if (!cls || !autoApproves(store.root, cls)) return null;
  const applies = standingAutoApplies(store, host, actor, operation);
  if (!applies) return null;
  const { task } = applies;
  const resolved = resolveAutoApproval(store.root);
  if (resolved.status !== "on") return null;
  const presented =
    `Workit decision: action — auto-approved ${String(descriptor.operation)} ` +
    `under workspace rule "${resolved.workspace}" (no question asked).`;
  const recorded = core.observeStandingDecision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: {
      taskId: task.id,
      workspaceId: applies.workspaceId,
      scope: task.intent.data.scope,
      presented,
      approvedContent: operation,
      contentRefs: [],
      standing: { workspace: resolved.workspace, class: cls },
    },
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) return null;
  const fresh = store.readTask(task.id);
  if (!fresh.ok) return null;
  return {
    taskId: task.id,
    decisionId: recorded.data.id,
    binding: recorded.data.data.binding,
    expectedRevision: fresh.data.revision,
    expectedWorkspaceRevision: applies.workspaceRevision,
  };
};
