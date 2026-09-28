import {
  branchPolicySnapshotFor,
  branchSetup,
  classifyBranchDirt,
  commitPolicySnapshotFor,
  resolveBranchPolicyFor,
  validateBranchNamePolicy,
  validateCommitMessagePolicy,
} from "./branch";
import {
  hostingCliAvailable,
  mergePr,
  prCreate,
  pushRemote,
  pushRemoteIdentity,
  pushTargetIsStable,
  safePushUrl,
} from "./pr-create";
import {
  changelogContext,
  docsRefreshContext,
  isSafeContextRange,
  prReadyContext,
  releaseNotesContext,
} from "./repo-context";
import { gitContext } from "./git";
import { fetchGitHubIssueBody, fetchGitLabIssueBody } from "./tracker-issues";
import { defaultOperations, ISSUE_RE, logTimeUpdate, postUpdate } from "./youtrack-tools";
import {
  context as youTrackContext,
  fetchYouTrackIssueBody,
  youTrackConfigPath,
  youTrackRequest,
  youTrackToken,
  youTrackWorkDateMs,
} from "./youtrack";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalJson,
  failure,
  success,
  sha256,
  type Caller,
  type Owner,
  type Result,
  type Ref,
} from "./task-contract";
import { changelogApply, changelogApplyPreview } from "./changelog";
import type { ExternalActionRequest } from "./external-action";
import {
  branchSetupIntent,
  externalActionDescriptor,
  externalActionRequest,
} from "./external-action";
import { normalizeChainSteps } from "./authority";
import { resolveInside, run as coreRun } from "../core";
import { hostingApiHostMatches, vcsCliIdentity, vcsConfig } from "./vcs-config";
import { assertProductWriteAllowed, currentWriterOwnsTask } from "./workers";
import { sameDirectoryIdentity, TaskStore } from "./task-store";

const run = (root: string, args: string[]) => {
  return coreRun(root, "git", args);
};

const gitValue = (root: string, args: string[]): string | null => {
  const result = run(root, args);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
};

const gitRaw = (root: string, args: string[]): string | null => {
  const result = run(root, args);
  return result.exitCode === 0 ? result.stdout : null;
};

/** Return every staged path, including both sides of renames/copies. */
const stagedPaths = (root: string): string[] | null => {
  const raw = gitRaw(root, ["diff", "--cached", "--name-status", "-z", "--find-renames", "HEAD"]);
  if (raw === null) return null;
  const tokens = raw.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const rename = /^(?:R|C)\d{3}$/.test(status);
    const count = rename ? 2 : 1;
    for (let offset = 0; offset < count; offset += 1) {
      const path = tokens[index++];
      if (!path) return null;
      paths.push(path);
    }
  }
  return [...new Set(paths)];
};

type RemoteParts = { host: string; path: string; protocol: string };

const remoteParts = (value: string): RemoteParts | null => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    if (!raw.includes("://")) {
      const match = /^(?:[^@\s]+@)?([^:]+):(.+)$/.exec(raw);
      if (!match) return null;
      return {
        host: match[1].toLowerCase(),
        path: `/${match[2]}`.replace(/\/$/, ""),
        protocol: "ssh:",
      };
    }
    const url = new URL(raw);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname.replace(/\/$/, ""),
      protocol: url.protocol,
    };
  } catch {
    return null;
  }
};

const credentialFreeRemote = (value: string): string | null => pushRemoteIdentity(value);

/** The task root stores coordination; a Git effect runs in the checkout named by the action. */
const actionRoot = (taskRoot: string, request: ExternalActionRequest): Result<string> => {
  const chosen = "cwd" in request.payload ? request.payload.cwd : undefined;
  try {
    const directory = fs.realpathSync(chosen ? path.resolve(taskRoot, chosen) : taskRoot);
    if (request.operation === "context.read") return success(null, null, directory);
    const gitAction =
      request.operation.startsWith("git.") || request.operation.startsWith("hosting.");
    if (!gitAction) return success(null, null, directory);
    const checkout = gitValue(directory, ["rev-parse", "--show-toplevel"]);
    if (!checkout)
      return failure("capability_unavailable", "action target is not a Git repository", {
        outcome: "not_started",
      });
    return success(null, null, fs.realpathSync(checkout));
  } catch {
    return failure("invalid_input", "action target directory cannot be resolved", {
      outcome: "not_started",
    });
  }
};

const bindsActionTarget = (operation: ExternalActionRequest["operation"]): boolean =>
  operation === "context.read" || operation.startsWith("git.") || operation.startsWith("hosting.");

const unknown = (operation: string) =>
  failure("external_outcome_unknown", "external action outcome is unknown", { operation });

type ContextReadPayload = Extract<ExternalActionRequest, { operation: "context.read" }>["payload"];

/** Read one fixed repository/provider context without approval or mutation. */
export const readExternalContext = async (
  root: string,
  payload: ContextReadPayload,
): Promise<Result<unknown>> => {
  if (payload.range !== undefined && !isSafeContextRange(payload.range))
    return failure("invalid_input", "revision range is invalid", {
      fields: [{ path: "range", reason: "option-like or control characters are not allowed" }],
    });
  const render = (result: { stdout: string; stderr: string; exitCode: number; cwd: string }) =>
    result.exitCode === 0
      ? success(null, null, { kind: payload.kind, context: result.stdout })
      : failure("capability_unavailable", "requested context is unavailable", {
          capability: payload.kind,
        });
  switch (payload.kind) {
    case "git": {
      const context = gitContext(root);
      return typeof context.exitCode === "number" && context.exitCode !== 0
        ? failure("capability_unavailable", "Git context is unavailable", { capability: "git" })
        : success(null, null, { kind: payload.kind, context });
    }
    case "pr":
      return render(prReadyContext(root, payload.range));
    case "changelog":
      return render(changelogContext(root, payload.range));
    case "release":
      return render(releaseNotesContext(root, payload.range ?? "HEAD~1...HEAD"));
    case "affected":
      return render(docsRefreshContext(root, payload.range));
    case "youtrack": {
      const value = youTrackContext({
        workspace_root: root,
        ...(payload.specPath ? { spec_path: payload.specPath } : {}),
        ...(payload.planPath ? { plan_path: payload.planPath } : {}),
        ...(payload.issueId ? { issue_id: payload.issueId } : {}),
        ...(payload.issueUrl ? { issue_url: payload.issueUrl } : {}),
        ...(payload.issueRef ? { issue_ref: payload.issueRef } : {}),
        ...(payload.mode ? { mode: payload.mode } : {}),
      });
      if (value && typeof value === "object" && "error" in value)
        return failure("capability_unavailable", "YouTrack context is unavailable", {
          capability: "youtrack",
        });
      if (value.requiresMeetingChoice || !value.issueId)
        return success(null, null, { kind: payload.kind, context: value });
      const body = await fetchYouTrackIssueBody(value.issueId);
      if ("error" in body && body.kind === "request")
        return failure("capability_unavailable", "YouTrack issue body is unavailable", {
          capability: "youtrack",
        });
      return success(null, null, {
        kind: payload.kind,
        context: {
          ...value,
          ...("data" in body
            ? { issueBody: body.data }
            : { issueBody: null, issueBodyError: body.error }),
        },
      });
    }
    case "github_issue": {
      const ref = payload.issueId ?? payload.issueUrl ?? payload.issueRef;
      if (!ref)
        return failure("invalid_input", "github_issue needs issueId, issueUrl, or issueRef");
      const body = await fetchGitHubIssueBody(ref, root);
      if ("error" in body)
        return failure("capability_unavailable", `GitHub issue is unavailable: ${body.error}`, {
          capability: "github_issue",
        });
      return success(null, null, { kind: payload.kind, context: { issueBody: body.data } });
    }
    case "gitlab_issue": {
      const ref = payload.issueId ?? payload.issueUrl ?? payload.issueRef;
      if (!ref)
        return failure("invalid_input", "gitlab_issue needs issueId, issueUrl, or issueRef");
      const body = await fetchGitLabIssueBody(ref, root);
      if ("error" in body)
        return failure("capability_unavailable", `GitLab issue is unavailable: ${body.error}`, {
          capability: "gitlab_issue",
        });
      return success(null, null, { kind: payload.kind, context: { issueBody: body.data } });
    }
  }
};

const localAction = (operation: ExternalActionRequest["operation"]): boolean =>
  operation === "git.branch_setup" ||
  operation === "git.commit" ||
  operation === "git.push" ||
  operation === "hosting.pull_request" ||
  operation === "hosting.merge" ||
  operation === "hosting.delete_branch" ||
  operation === "changelog.apply";

const targetWriterActionLease = Symbol("target-writer-action-lease");

export const assertLocalExternalActionWriter = (
  root: string,
  caller: { host: Caller["host"]; actor: string },
  paths: string[] = ["."],
  expectedWorkspaceRevision?: string,
): Result<Owner> => {
  const store = new TaskStore(root);
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok) return listed as Result<never>;
  if (!workspace.ok) return workspace as Result<never>;
  if (!workspace.data) return failure("not_found", "workspace not found");
  if (
    expectedWorkspaceRevision !== undefined &&
    workspace.data.revision !== expectedWorkspaceRevision
  )
    return failure("revision_conflict", "checkout writer generation changed before the effect", {
      expectedWorkspaceRevision,
      actualWorkspaceRevision: workspace.data.revision,
    });
  const candidates = listed.data.filter((task) =>
    currentWriterOwnsTask(task, workspace.data!, caller),
  );
  if (candidates.length !== 1)
    return failure("permission_denied", "local external action requires exactly one active task");
  const allowed = assertProductWriteAllowed({
    task: candidates[0],
    workspace: workspace.data,
    caller: { host: caller.host, actor: caller.actor, workerId: null },
    paths,
    store,
  });
  return allowed;
};

const safePath = (root: string, value: string): string | null => {
  try {
    return resolveInside(root, value);
  } catch {
    return null;
  }
};

/** Read-only baseline bound into a branch-setup proposal: the exact remote
 * commit the base currently points at, without moving any local ref. */
const branchCreationBaseline = (
  root: string,
  target: string,
  base: string,
): {
  base_branch: string;
  target_exists: boolean;
  local_base: string | null;
  remote_base: string | null;
  target_head: string | null;
} => {
  const exists =
    gitValue(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}`]) !== null;
  if (exists)
    return {
      base_branch: base,
      target_exists: true,
      local_base: null,
      remote_base: null,
      target_head: gitValue(root, ["rev-parse", `refs/heads/${target}`]),
    };
  const remote = run(root, ["ls-remote", "origin", `refs/heads/${base}`]);
  const sha = remote.exitCode === 0 ? remote.stdout.trim().split(/\s+/)[0] : "";
  const remoteBase = /^[0-9a-f]{40}$/.test(sha ?? "") ? (sha as string) : null;
  return {
    base_branch: base,
    target_exists: false,
    local_base: gitValue(root, ["rev-parse", "--verify", `refs/heads/${base}`]),
    remote_base: remoteBase,
    target_head: remoteBase,
  };
};

const shortSha = (value: unknown): string =>
  typeof value === "string" && value ? value.slice(0, 8) : "unknown";

/** Concise, user-facing approval text for one resolved action. The exact
 * descriptor stays machine-facing; this is what the native question shows. */
const actionProposalAtRoot = (
  request: ExternalActionRequest,
  descriptorPayload: unknown,
): { presented: string; approvedText: string } => {
  const payload = (descriptorPayload ?? {}) as Record<string, unknown>;
  const resolved = (payload.resolved ?? {}) as Record<string, unknown>;
  const payloadTarget = String(payload.target_branch ?? "");
  if (request.operation === "git.commit" && Array.isArray(payload.plan_steps)) {
    const steps = payload.plan_steps as unknown[];
    const chain = normalizeChainSteps(steps);
    if (!chain)
      return {
        presented: `Workit decision: action — Approve committing the plan's listed tasks?`,
        approvedText: `Approve the listed plan commits.`,
      };
    const kinds = chain.map((step) => step.kind);
    if (kinds.every((kind) => kind === "commit"))
      return {
        presented: `Workit decision: action — Approve committing the plan's ${steps.length} listed tasks on \`${String(payload.plan_branch ?? "")}\`?`,
        approvedText: `Approve the ${steps.length} listed plan commits.`,
      };
    const summary = [
      kinds.filter((kind) => kind === "branch").length
        ? `${kinds.filter((kind) => kind === "branch").length} branch`
        : null,
      kinds.filter((kind) => kind === "commit").length
        ? `${kinds.filter((kind) => kind === "commit").length} commits`
        : null,
      kinds.includes("pr") ? "PR" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      presented: `Workit decision: action — Approve the ${steps.length}-step chain on \`${String(payload.plan_branch ?? "")}\` (${summary})?`,
      approvedText: `Approve the ${steps.length}-step chain (${summary}).`,
    };
  }
  switch (request.operation) {
    case "git.branch_setup": {
      if (request.payload.action === "reapply_stash")
        return {
          presented:
            "Workit decision: action — Reapply the pre-checkout stash recorded in the branch manifest?",
          approvedText: "Reapply the recorded stash.",
        };
      const target = String(payload.target_branch ?? "");
      // A dirty tree binds stash: the approval carries the stash through,
      // so the question names it instead of failing later at preflight.
      const stashes = payload.stash === "yes" && resolved.dirty === true;
      if (resolved.target_exists === true)
        return stashes
          ? {
              presented: `Workit decision: action — Stash the dirty working tree and switch to branch \`${target}\`?`,
              approvedText: `Stash and switch to \`${target}\`.`,
            }
          : {
              presented: `Workit decision: action — Switch to branch \`${target}\`?`,
              approvedText: `Switch to \`${target}\`.`,
            };
      const base = String(resolved.base_branch ?? "the base branch");
      const localBase =
        typeof resolved.local_base === "string"
          ? `local ${shortSha(resolved.local_base)}`
          : "no local base";
      const remoteBase = shortSha(resolved.remote_base);
      return stashes
        ? {
            presented: `Workit decision: action — Stash and create branch \`${target}\` from \`${base}\` (${localBase}; remote ${remoteBase})?`,
            approvedText: `Stash and create \`${target}\` from \`${base}\` (${localBase}; remote ${remoteBase}).`,
          }
        : {
            presented: `Workit decision: action — Create branch \`${target}\` from \`${base}\` (${localBase}; remote ${remoteBase})?`,
            approvedText: `Create \`${target}\` from \`${base}\` (${localBase}; remote ${remoteBase}).`,
          };
    }
    case "git.commit": {
      const paths = Array.isArray(resolved.paths) ? (resolved.paths as string[]) : [];
      return {
        presented: `Workit decision: action — Commit ${paths.length} staged file(s) as "${String(request.payload.message)}"?`,
        approvedText: `Commit as "${String(request.payload.message)}".`,
      };
    }
    case "git.push":
      return {
        presented: `Workit decision: action — Push branch \`${String(payload.branch ?? "")}\` to \`${String(resolved.remote ?? "unknown remote")}\` via \`${String(resolved.apiHost ?? "Git transport")}\`${resolved.account ? ` as ${String(resolved.account)}` : ""}?`,
        approvedText: `Push \`${String(payload.branch ?? "")}\` to ${String(resolved.remote ?? "unknown remote")} via ${String(resolved.apiHost ?? "Git transport")}${resolved.account ? ` as ${String(resolved.account)}` : ""}.`,
      };
    case "hosting.pull_request": {
      const sourceCommit = shortSha(resolved.source_commit);
      const mergeBase =
        typeof resolved.merge_base_commit === "string"
          ? ` on local merge base ${shortSha(resolved.merge_base_commit)}`
          : "";
      return {
        presented: `Workit decision: action — Open a PR in \`${String(resolved.remote ?? "unknown remote")}\` via \`${String(resolved.apiHost ?? "unknown host")}\`${resolved.account ? ` as ${String(resolved.account)}` : ""} from \`${String(resolved.source_branch ?? "")}\`@${sourceCommit} to \`${payloadTarget}\`${mergeBase} titled "${String(request.payload.title)}"?`,
        approvedText: `Open the PR in ${String(resolved.remote ?? "unknown remote")} via ${String(resolved.apiHost ?? "unknown host")}${resolved.account ? ` as ${String(resolved.account)}` : ""}: ${String(resolved.source_branch ?? "")}@${sourceCommit} → ${payloadTarget}${mergeBase}, "${String(request.payload.title)}".`,
      };
    }
    case "hosting.merge":
      return {
        presented: `Workit decision: action — Merge \`${String(resolved.source_branch ?? "")}\` into \`${payloadTarget}\` in \`${String(resolved.remote ?? "unknown remote")}\` via \`${String(resolved.apiHost ?? "unknown host")}\`${resolved.account ? ` as ${String(resolved.account)}` : ""} (squash, delete branch)?`,
        approvedText: `Merge ${String(resolved.source_branch ?? "")} → ${payloadTarget} in ${String(resolved.remote ?? "unknown remote")} via ${String(resolved.apiHost ?? "unknown host")}${resolved.account ? ` as ${String(resolved.account)}` : ""}.`,
      };
    case "hosting.delete_branch":
      return {
        presented: `Workit decision: action — Delete merged branch \`${String(payload.branch ?? "")}\` from \`${String(resolved.remote ?? "")}\` via \`${String(resolved.apiHost ?? "unknown host")}\` as \`${String(resolved.account ?? "unknown account")}\` at ${shortSha(resolved.tip)} (PR/MR #${String(resolved.pr ?? "")})?`,
        approvedText: `Delete merged branch ${String(payload.branch ?? "")} from ${String(resolved.remote ?? "unknown remote")} via ${String(resolved.apiHost ?? "unknown host")} as ${String(resolved.account ?? "unknown account")}.`,
      };
    case "changelog.apply":
      return {
        presented: `Workit decision: action — Apply changelog changes at \`${String(payload.path ?? "CHANGELOG.md")}\`?`,
        approvedText: `Apply changelog changes at ${String(payload.path ?? "CHANGELOG.md")}.`,
      };
    case "youtrack.update":
      return {
        presented: `Workit decision: action — Update YouTrack issue ${String(request.payload.issueId)}${request.payload.minutes ? ` and log ${String(request.payload.minutes)}m` : ""}?`,
        approvedText: `Update YouTrack issue ${String(request.payload.issueId)}.`,
      };
    case "youtrack.time":
      return {
        presented: `Workit decision: action — Log ${String(request.payload.minutes)}m to YouTrack issue ${String(request.payload.issueId)}?`,
        approvedText: `Log time to YouTrack issue ${String(request.payload.issueId)}.`,
      };
    case "youtrack.meeting":
      return {
        presented: `Workit decision: action — Log meeting time to YouTrack issue ${String(request.payload.issueId)}?`,
        approvedText: `Log meeting time to YouTrack issue ${String(request.payload.issueId)}.`,
      };
    default:
      return {
        presented: `Workit decision: action — Approve ${request.operation}?`,
        approvedText: `Approve ${request.operation}.`,
      };
  }
};

export const actionProposalQuestion = (
  request: ExternalActionRequest,
  descriptorPayload: unknown,
): { presented: string; approvedText: string } => {
  const proposal = actionProposalAtRoot(request, descriptorPayload);
  const cwd = (descriptorPayload as { cwd?: unknown })?.cwd;
  return typeof cwd === "string"
    ? { ...proposal, presented: `${proposal.presented} Target directory: ${cwd}` }
    : proposal;
};

export type ResolvedExternalAction = {
  request: ExternalActionRequest;
  descriptorPayload: unknown;
  marker?: string;
};

export type HostingReadEvidence = {
  outcome: "succeeded" | "unknown";
  evidenceDigest: string;
  observation: object;
  data?: { provider: "github" | "gitlab" | "youtrack"; id: string | number };
  step?: string;
};

/** Rebuild the originally approved hosting target from persisted descriptor bytes. */
export const approvedResolvedExternalAction = (content: string): Result<ResolvedExternalAction> => {
  try {
    const value = JSON.parse(content) as { operation?: unknown; payload?: unknown };
    if (
      value.operation !== "git.branch_setup" &&
      value.operation !== "git.commit" &&
      value.operation !== "git.push" &&
      value.operation !== "hosting.pull_request" &&
      value.operation !== "hosting.merge" &&
      value.operation !== "hosting.delete_branch" &&
      value.operation !== "changelog.apply" &&
      value.operation !== "youtrack.update" &&
      value.operation !== "youtrack.time" &&
      value.operation !== "youtrack.meeting"
    )
      return failure("invalid_input", "approved action is not a reconciliable external action");
    if (!value.payload || typeof value.payload !== "object")
      return failure("invalid_input", "approved action payload is incomplete");
    const payload = { ...(value.payload as Record<string, unknown>) };
    const resolved = payload.resolved;
    delete payload.resolved;
    const request = externalActionRequest({ operation: value.operation, payload });
    if (!request.ok || !resolved || typeof resolved !== "object")
      return failure("invalid_input", "approved hosting target is incomplete");
    const target = resolved as Record<string, unknown>;
    if (
      value.operation === "git.commit" &&
      (typeof target.head !== "string" ||
        typeof target.staged !== "string" ||
        typeof payload.message !== "string")
    )
      return failure("invalid_input", "approved Git commit target is incomplete");
    if (
      value.operation === "git.push" &&
      (typeof target.branch !== "string" ||
        typeof target.commit !== "string" ||
        typeof target.remote !== "string")
    )
      return failure("invalid_input", "approved Git push target is incomplete");
    if (
      value.operation === "git.branch_setup" &&
      (typeof target.head !== "string" ||
        (payload.action === "reapply_stash"
          ? typeof target.stash_commit !== "string"
          : typeof payload.target_branch !== "string" || typeof target.target_head !== "string"))
    )
      return failure("invalid_input", "approved Git branch target is incomplete");
    if (
      value.operation === "hosting.pull_request" &&
      (typeof target.marker !== "string" ||
        typeof target.source_branch !== "string" ||
        typeof target.source_commit !== "string" ||
        typeof target.remote !== "string" ||
        typeof payload.target_branch !== "string")
    )
      return failure("invalid_input", "approved hosting target is incomplete");
    if (
      value.operation === "hosting.merge" &&
      (typeof target.marker !== "string" ||
        typeof target.source_branch !== "string" ||
        typeof target.source_commit !== "string" ||
        typeof target.remote !== "string" ||
        typeof payload.target_branch !== "string")
    )
      return failure("invalid_input", "approved hosting target is incomplete");
    if (
      value.operation === "hosting.delete_branch" &&
      (typeof target.tip !== "string" ||
        typeof target.remote !== "string" ||
        typeof target.pr !== "string")
    )
      return failure("invalid_input", "approved branch deletion target is incomplete");
    if (
      value.operation === "changelog.apply" &&
      (typeof target.target !== "string" ||
        typeof target.beforeDigest !== "string" ||
        typeof target.beforeExists !== "boolean" ||
        typeof target.afterDigest !== "string")
    )
      return failure("invalid_input", "approved changelog target is incomplete");
    if (
      value.operation !== "git.branch_setup" &&
      value.operation !== "git.commit" &&
      value.operation !== "git.push" &&
      value.operation !== "hosting.pull_request" &&
      value.operation !== "hosting.merge" &&
      value.operation !== "hosting.delete_branch" &&
      value.operation !== "changelog.apply" &&
      (typeof target.marker !== "string" ||
        typeof target.baseUrl !== "string" ||
        typeof target.issueId !== "string" ||
        !Array.isArray(target.steps))
    )
      return failure("invalid_input", "approved YouTrack target is incomplete");
    return success(null, null, {
      request: request.data,
      descriptorPayload: value.payload,
      ...(typeof target.marker === "string" ? { marker: target.marker } : {}),
    });
  } catch {
    return failure("invalid_input", "approved action descriptor is invalid");
  }
};

const remoteRepo = (value: string): string | null => {
  const parts = remoteParts(value);
  if (!parts) return null;
  const repo = parts.path.replace(/^\//, "").replace(/\.git$/, "");
  return repo.includes("/") ? repo : null;
};

const remoteIdentity = (value: string): string | null => pushRemoteIdentity(value);

const remoteProvider = (value: string): "github" | "gitlab" | null => {
  const host = remoteParts(value)?.host;
  return host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
};

const hostingCliEnv = (provider: "github" | "gitlab", host: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: process.env.PATH ?? "",
  ...(provider === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
});

const hostingProvider = (root: string, remote: string): "github" | "gitlab" | null => {
  const known = remoteProvider(remote);
  if (known) return known;
  const parts = remoteParts(remote);
  if (!parts?.host || (parts.protocol !== "ssh:" && parts.protocol !== "https:")) return null;
  const cfg = vcsConfig("load", root);
  return cfg.ok && (cfg.provider === "github" || cfg.provider === "gitlab") ? cfg.provider : null;
};

const remoteBranchTip = (
  root: string,
  provider: "github" | "gitlab",
  host: string,
  repo: string,
  branch: string,
): Result<string | null> => {
  const endpoint =
    provider === "github"
      ? `repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`
      : `projects/${encodeURIComponent(repo)}/repository/branches/${encodeURIComponent(branch)}`;
  const response = spawnSync(provider === "github" ? "gh" : "glab", ["api", endpoint], {
    cwd: root,
    encoding: "utf8",
    env: hostingCliEnv(provider, host),
  });
  if (response.status !== 0) {
    if (/\b404\b/.test(response.stderr ?? "")) {
      const project =
        provider === "github" ? `repos/${repo}` : `projects/${encodeURIComponent(repo)}`;
      const visible = spawnSync(provider === "github" ? "gh" : "glab", ["api", project], {
        cwd: root,
        encoding: "utf8",
        env: hostingCliEnv(provider, host),
      });
      try {
        const record = JSON.parse(visible.stdout ?? "") as { id?: unknown };
        if (visible.status === 0 && typeof record.id === "number") return success(null, null, null);
      } catch {}
    }
    return failure("capability_unavailable", "remote branch could not be read", {
      outcome: "not_started",
    });
  }
  try {
    const parsed = JSON.parse(response.stdout ?? "") as Record<string, any>;
    const tip = provider === "github" ? parsed.object?.sha : parsed.commit?.id;
    return typeof tip === "string" && /^[a-f0-9]{40,64}$/.test(tip)
      ? success(null, null, tip)
      : failure("capability_unavailable", "remote branch response is incomplete", {
          outcome: "not_started",
        });
  } catch {
    return failure("capability_unavailable", "remote branch response is invalid", {
      outcome: "not_started",
    });
  }
};

const mergedBranch = (root: string, branch: string): Result<Record<string, string>> => {
  if (run(root, ["check-ref-format", "--branch", branch]).exitCode !== 0)
    return failure("invalid_input", "branch name is invalid", { outcome: "not_started" });
  const remote = pushRemote(root);
  const identity = remote ? credentialFreeRemote(remote) : null;
  const repo = remote ? remoteRepo(remote) : null;
  const provider = remote ? hostingProvider(root, remote) : null;
  if (!remote || !identity || !repo || !provider)
    return failure("capability_unavailable", "branch remote is unavailable", {
      outcome: "not_started",
    });
  const auth = vcsCliIdentity(root);
  if (!auth.ok || auth.provider !== provider)
    return failure("capability_unavailable", "hosting CLI identity is unavailable", {
      outcome: "not_started",
    });
  if (!hostingApiHostMatches(remote, auth.host))
    return failure(
      "capability_unavailable",
      "hosting API host does not match the push destination",
      {
        outcome: "not_started",
      },
    );
  const live = remoteBranchTip(root, provider, auth.host, repo, branch);
  if (!live.ok) return live as Result<never>;
  const tip = live.data;
  if (!tip)
    return failure("invalid_input", "remote branch is absent or could not be read", {
      outcome: "not_started",
    });
  const endpoint =
    provider === "github"
      ? `repos/${repo}/pulls?state=closed&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&per_page=100`
      : `projects/${encodeURIComponent(repo)}/merge_requests?state=merged&source_branch=${encodeURIComponent(branch)}&per_page=100`;
  const response = spawnSync(provider === "github" ? "gh" : "glab", ["api", endpoint], {
    cwd: root,
    encoding: "utf8",
    env: hostingCliEnv(provider, auth.host),
  });
  if (response.status !== 0)
    return failure("capability_unavailable", "merged branch evidence is unavailable", {
      outcome: "not_started",
    });
  try {
    const records = JSON.parse(response.stdout ?? "") as unknown;
    if (!Array.isArray(records) || records.length >= 100) throw new Error("incomplete PR listing");
    const match = records.find(
      (record) =>
        record &&
        typeof record === "object" &&
        (provider === "github" ? record.head?.sha === tip : record.sha === tip) &&
        typeof record.merged_at === "string" &&
        (provider === "github" ? record.head?.ref === branch : record.source_branch === branch),
    );
    const id = match?.number ?? match?.iid;
    if (typeof id !== "number") throw new Error("no exact merged head");
    return success(null, null, {
      branch,
      tip,
      remote: identity,
      provider,
      repo,
      pr: String(id),
      account: String(auth.username),
      apiHost: String(auth.host),
    });
  } catch {
    return failure("capability_unavailable", "branch tip does not match a merged PR head", {
      outcome: "not_started",
    });
  }
};

const unknownHostingEvidence = (operation: string): Result<HostingReadEvidence> =>
  failure("external_outcome_unknown", "hosting action outcome remains unknown", {
    operation,
    outcome: "unknown",
  });

/** Fixed, read-only GitHub/GitLab lookup; callers must keep the returned observation private. */
export const readHostingAction = async (
  root: string,
  resolved: ResolvedExternalAction,
  actionRef: Ref,
): Promise<Result<HostingReadEvidence>> => {
  const operation = resolved.request.operation;
  if ((operation !== "hosting.pull_request" && operation !== "hosting.merge") || !resolved.marker)
    return unknownHostingEvidence(operation);
  try {
    const cfg = vcsConfig("load", root);
    if (!cfg.ok || !cfg.provider || (cfg.provider !== "github" && cfg.provider !== "gitlab"))
      return unknownHostingEvidence(operation);
    const auth = vcsCliIdentity(root);
    if (!auth.ok || auth.provider !== cfg.provider) return unknownHostingEvidence(operation);
    const remote = pushRemote(root);
    const repo = remote ? remoteRepo(remote) : null;
    const approved = resolved.descriptorPayload as {
      target_branch?: unknown;
      resolved?: Record<string, unknown>;
    };
    const target = approved.target_branch;
    const source = approved.resolved;
    const branch = source?.source_branch;
    const sourceCommit = source?.source_commit;
    const approvedRemote = source?.remote;
    const currentIdentity = remote ? remoteIdentity(remote) : null;
    const approvedIdentity =
      typeof approvedRemote === "string" ? remoteIdentity(approvedRemote) : null;
    if (
      !repo ||
      typeof branch !== "string" ||
      typeof target !== "string" ||
      typeof sourceCommit !== "string" ||
      typeof approvedRemote !== "string" ||
      !currentIdentity ||
      currentIdentity !== approvedIdentity ||
      repo !== remoteRepo(approvedRemote) ||
      hostingProvider(root, approvedRemote) !== cfg.provider ||
      !hostingApiHostMatches(approvedRemote, auth.host) ||
      (typeof source?.apiHost === "string" && source.apiHost !== auth.host)
    )
      return unknownHostingEvidence(operation);
    const endpoint =
      cfg.provider === "github"
        ? `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(target)}&per_page=100&page=1`
        : `projects/${encodeURIComponent(repo)}/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(target)}&per_page=100&page=1`;
    const cli = cfg.provider === "github" ? "gh" : "glab";
    const response = spawnSync(cli, ["api", endpoint], {
      cwd: root,
      encoding: "utf8",
      env: hostingCliEnv(cfg.provider, auth.host),
    });
    if (response.status !== 0) return unknownHostingEvidence(operation);
    const values: unknown = JSON.parse(response.stdout ?? "");
    // A full page is intentionally treated as truncated until pagination is added.
    if (!Array.isArray(values) || values.length >= 100) return unknownHostingEvidence(operation);
    const records: Record<string, unknown>[] = [];
    for (const item of values) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return unknownHostingEvidence(operation);
      const record = item as Record<string, unknown>;
      const body = record.body ?? record.description;
      const base = record.base;
      const head = record.head;
      const githubShape =
        cfg.provider === "github" &&
        base !== null &&
        typeof base === "object" &&
        !Array.isArray(base) &&
        head !== null &&
        typeof head === "object" &&
        !Array.isArray(head) &&
        typeof (base as Record<string, unknown>).ref === "string" &&
        typeof (head as Record<string, unknown>).ref === "string" &&
        typeof (head as Record<string, unknown>).sha === "string";
      const gitlabShape =
        cfg.provider === "gitlab" &&
        typeof record.target_branch === "string" &&
        typeof record.source_branch === "string" &&
        typeof record.sha === "string";
      const targetValue =
        cfg.provider === "github" && githubShape
          ? (base as Record<string, unknown>).ref
          : record.target_branch;
      const sourceValue =
        cfg.provider === "github" && githubShape
          ? (head as Record<string, unknown>).ref
          : record.source_branch;
      const shaValue =
        cfg.provider === "github" && githubShape
          ? (head as Record<string, unknown>).sha
          : record.sha;
      const idValue = record.number ?? record.iid ?? record.id;
      if (
        (body !== undefined && body !== null && typeof body !== "string") ||
        (cfg.provider === "github" ? !githubShape : !gitlabShape) ||
        typeof targetValue !== "string" ||
        typeof sourceValue !== "string" ||
        typeof shaValue !== "string" ||
        (typeof idValue !== "string" && typeof idValue !== "number")
      )
        return unknownHostingEvidence(operation);
      records.push(record);
    }
    const matches = records.filter((item) => {
      const body = String(item.body ?? item.description ?? "");
      const base = item.base as Record<string, unknown> | undefined;
      const head = item.head as Record<string, unknown> | undefined;
      const itemTarget = cfg.provider === "github" ? base?.ref : item.target_branch;
      const itemSource = cfg.provider === "github" ? head?.ref : item.source_branch;
      const itemSha = cfg.provider === "github" ? head?.sha : item.sha;
      const merged =
        cfg.provider === "github"
          ? typeof item.merged_at === "string"
          : item.state === "merged" || typeof item.merged_at === "string";
      return (
        (operation === "hosting.merge" ? merged : body.includes(resolved.marker!)) &&
        itemTarget === target &&
        itemSource === branch &&
        itemSha === sourceCommit
      );
    });
    if (
      operation === "hosting.merge" &&
      records.some((item) => {
        const base = item.base as Record<string, unknown> | undefined;
        const head = item.head as Record<string, unknown> | undefined;
        return (
          (cfg.provider === "github" ? base?.ref : item.target_branch) === target &&
          (cfg.provider === "github" ? head?.ref : item.source_branch) === branch &&
          (cfg.provider === "github"
            ? typeof item.merged_at !== "string"
            : item.state !== "merged" && typeof item.merged_at !== "string")
        );
      })
    )
      return unknownHostingEvidence(operation);
    if (matches.length !== 1) return unknownHostingEvidence(operation);
    const item = matches[0];
    const id = item.number ?? item.iid ?? item.id;
    if (typeof id !== "string" && typeof id !== "number") return unknownHostingEvidence(operation);
    const evidenceDigest = sha256({
      operation,
      provider: cfg.provider,
      id,
      marker: resolved.marker,
      target,
      branch,
      sourceCommit,
    });
    const observation = {
      kind: "provider_read",
      actionRef,
      outcome: "succeeded" as const,
      evidenceDigest,
    };
    return success(null, null, {
      outcome: "succeeded",
      evidenceDigest,
      observation,
      data: { provider: cfg.provider, id },
    });
  } catch {
    return unknownHostingEvidence(operation);
  }
};

const appendMarker = (text: string, marker: string): string =>
  `${text}${text ? "\n\n" : ""}${marker}`;

/** Fixed, read-only YouTrack lookup for comments and work items. */
export const readYouTrackAction = async (
  root: string,
  resolved: ResolvedExternalAction,
  actionRef: Ref,
): Promise<Result<HostingReadEvidence>> => {
  const operation = resolved.request.operation;
  if (
    operation !== "youtrack.update" &&
    operation !== "youtrack.time" &&
    operation !== "youtrack.meeting"
  )
    return unknownHostingEvidence(operation);
  try {
    const target = resolved.descriptorPayload as { resolved?: Record<string, unknown> };
    const details = target.resolved;
    const issueId = details?.issueId;
    const baseUrl = details?.baseUrl;
    const marker = details?.marker;
    if (
      typeof issueId !== "string" ||
      !ISSUE_RE.test(issueId) ||
      typeof baseUrl !== "string" ||
      typeof marker !== "string"
    )
      return unknownHostingEvidence(operation);
    if (
      !details ||
      !Array.isArray(details.steps) ||
      !details.steps.every((step) => typeof step === "string")
    )
      return unknownHostingEvidence(operation);
    const creds = youTrackToken();
    if ("error" in creds || creds.base !== baseUrl) return unknownHostingEvidence(operation);
    const bounded = "&$top=100&$skip=0";
    const read = async (path: string): Promise<unknown[] | null> => {
      const result = await youTrackRequest(`${baseUrl}${path}${bounded}`, {
        method: "GET",
        token: creds.token,
      });
      if (result.status !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout);
        return Array.isArray(parsed) && parsed.length < 100 ? parsed : null;
      } catch {
        return null;
      }
    };
    const comments =
      operation === "youtrack.time"
        ? []
        : await read(
            `/api/issues/${encodeURIComponent(issueId)}/comments?fields=id,text,author(id,login),deleted,created`,
          );
    const workItems =
      (operation === "youtrack.update" && details.steps.includes("time")) ||
      operation === "youtrack.time" ||
      operation === "youtrack.meeting"
        ? await read(
            `/api/issues/${encodeURIComponent(issueId)}/timeTracking/workItems?fields=id,text,author(id),creator(id),duration(minutes),date`,
          )
        : [];
    if (comments === null || workItems === null) return unknownHostingEvidence(operation);
    const commentText = typeof details.commentText === "string" ? details.commentText : null;
    const workText = typeof details.workText === "string" ? details.workText : null;
    const minutes = typeof details.minutes === "number" ? details.minutes : null;
    const dateMs = typeof details.dateMs === "number" ? details.dateMs : null;
    const validComment = (value: unknown): value is Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return (
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        (item.deleted === undefined || typeof item.deleted === "boolean") &&
        (item.created === undefined || typeof item.created === "number")
      );
    };
    const validWork = (value: unknown): value is Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      const duration = item.duration;
      return (
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        !!duration &&
        typeof duration === "object" &&
        !Array.isArray(duration) &&
        typeof (duration as Record<string, unknown>).minutes === "number" &&
        typeof item.date === "number"
      );
    };
    if (
      comments.some((value) => !validComment(value)) ||
      workItems.some((value) => !validWork(value))
    )
      return unknownHostingEvidence(operation);
    const matchingComments =
      commentText === null
        ? []
        : comments.filter(
            (value) =>
              !((value as Record<string, unknown>).deleted === true) &&
              (value as Record<string, unknown>).text === commentText,
          );
    const matchingWork =
      workText === null
        ? []
        : workItems.filter((value) => {
            const item = value as Record<string, unknown>;
            return (
              item.text === workText &&
              (item.duration as Record<string, unknown>).minutes === minutes &&
              item.date === dateMs
            );
          });
    const needComment = commentText !== null;
    // `workText` is also retained for update descriptors so the later time
    // step can use the exact approved text.  It is only an expected provider
    // object when the approved workflow actually contains the time step.
    const needWork = details.steps.includes("time") && workText !== null;
    if (needComment && matchingComments.length !== 1) return unknownHostingEvidence(operation);
    // An absent work item is deliberately not evidence that the time step was
    // never applied: the POST may have succeeded before its response was lost.
    // The persisted workflow records which step was attempted; only an exact
    // provider match can reconcile it.
    if (needWork && matchingWork.length !== 1) return unknownHostingEvidence(operation);
    const ids = [...matchingComments, ...matchingWork].map(
      (value) => (value as Record<string, unknown>).id,
    );
    const evidenceDigest = sha256({ operation, issueId, marker, ids, minutes, dateMs });
    const observation = {
      kind: "provider_read",
      actionRef,
      outcome: "succeeded" as const,
      evidenceDigest,
    };
    return success(null, null, {
      outcome: "succeeded",
      evidenceDigest,
      observation,
      data: { provider: "youtrack", id: String(ids[0] ?? "") },
    });
  } catch {
    return unknownHostingEvidence(operation);
  }
};

export const readLocalAction = async (
  root: string,
  resolved: ResolvedExternalAction,
  actionRef: Ref,
): Promise<Result<HostingReadEvidence>> => {
  const operation = resolved.request.operation;
  const target = (resolved.descriptorPayload as { resolved?: Record<string, unknown> }).resolved;
  if (!target) return unknownHostingEvidence(operation);
  let observed: Record<string, unknown> | null = null;
  if (operation === "git.commit") {
    const commit = gitValue(root, ["rev-parse", "HEAD"]);
    const parent = commit ? gitValue(root, ["rev-parse", `${commit}^`]) : null;
    const message = commit ? gitValue(root, ["show", "-s", "--format=%B", commit]) : null;
    const diff =
      commit && parent
        ? gitRaw(root, ["diff", "--raw", "-z", "--no-ext-diff", "--no-textconv", parent, commit])
        : null;
    if (
      commit &&
      parent === target.head &&
      message === resolved.request.payload.message &&
      diff !== null &&
      sha256(diff) === target.staged
    )
      observed = { commit, parent, message, staged: target.staged };
  } else if (operation === "git.push") {
    const branch = target.branch;
    const commit = target.commit;
    const approvedRemote = target.remote;
    const currentRemote = pushRemote(root);
    const currentIdentity = currentRemote ? credentialFreeRemote(currentRemote) : null;
    if (
      typeof branch === "string" &&
      typeof commit === "string" &&
      typeof approvedRemote === "string" &&
      currentIdentity === approvedRemote
    ) {
      const remote = run(root, ["ls-remote", currentRemote!, `refs/heads/${branch}`]);
      const remoteCommit = remote.exitCode === 0 ? remote.stdout.trim().split(/\s+/)[0] : null;
      if (remoteCommit === commit) observed = { branch, commit, remote: approvedRemote };
    }
  } else if (operation === "git.branch_setup") {
    const targetBranch = resolved.request.payload.target_branch;
    const sdd = resolved.request.payload.sdd_dir;
    if (resolved.request.payload.action === "reapply_stash" && typeof sdd === "string") {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(sdd, "manifest.json"), "utf8")) as {
          stash_ref?: unknown;
        };
        const stashes = gitRaw(root, ["stash", "list", "--format=%H"]);
        if (
          typeof target.stash_commit === "string" &&
          manifest.stash_ref === undefined &&
          stashes !== null &&
          !stashes.split("\n").includes(target.stash_commit)
        )
          observed = { stash_commit: target.stash_commit };
      } catch {}
    } else if (
      typeof targetBranch === "string" &&
      typeof sdd === "string" &&
      gitValue(root, ["branch", "--show-current"]) === targetBranch &&
      typeof target.target_head === "string" &&
      gitValue(root, ["rev-parse", "HEAD"]) === target.target_head
    ) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(sdd, "manifest.json"), "utf8")) as {
          branch?: unknown;
        };
        if (manifest.branch === targetBranch) observed = { branch: targetBranch };
      } catch {}
    }
  } else if (operation === "changelog.apply") {
    const afterDigest = target.afterDigest;
    const preview = changelogApplyPreview({ ...resolved.request.payload, workspace_root: root });
    if (!preview.error && typeof afterDigest === "string" && preview.beforeDigest === afterDigest)
      observed = { target: target.target, afterDigest };
  }
  if (!observed) return unknownHostingEvidence(operation);
  const evidenceDigest = sha256({ operation, observed });
  return success(null, null, {
    outcome: "succeeded",
    evidenceDigest,
    observation: {
      kind: "provider_read",
      actionRef,
      outcome: "succeeded",
      evidenceDigest,
    },
  });
};

export const readExternalAction = async (
  root: string,
  resolved: ResolvedExternalAction,
  actionRef: Ref,
): Promise<Result<HostingReadEvidence>> => {
  const target = actionRoot(root, resolved.request);
  if (!target.ok) return unknownHostingEvidence(resolved.request.operation);
  root = target.data;
  return resolved.request.operation === "git.branch_setup" ||
    resolved.request.operation === "git.commit" ||
    resolved.request.operation === "git.push" ||
    resolved.request.operation === "changelog.apply"
    ? readLocalAction(root, resolved, actionRef)
    : resolved.request.operation === "hosting.delete_branch"
      ? readDeletedBranch(root, resolved, actionRef)
      : resolved.request.operation === "hosting.pull_request" ||
          resolved.request.operation === "hosting.merge"
        ? readHostingAction(root, resolved, actionRef)
        : readYouTrackAction(root, resolved, actionRef);
};

const readDeletedBranch = async (
  root: string,
  resolved: ResolvedExternalAction,
  actionRef: Ref,
): Promise<Result<HostingReadEvidence>> => {
  const details = (resolved.descriptorPayload as { resolved?: Record<string, unknown> }).resolved;
  if (
    !details ||
    typeof details.branch !== "string" ||
    typeof details.tip !== "string" ||
    typeof details.remote !== "string" ||
    credentialFreeRemote(pushRemote(root) ?? "") !== details.remote
  )
    return unknownHostingEvidence("hosting.delete_branch");
  const provider = details.provider;
  const repo = details.repo;
  const apiHost = details.apiHost;
  if (
    (provider !== "github" && provider !== "gitlab") ||
    typeof repo !== "string" ||
    typeof apiHost !== "string" ||
    !hostingApiHostMatches(pushRemote(root) ?? "", apiHost)
  )
    return unknownHostingEvidence("hosting.delete_branch");
  const live = remoteBranchTip(root, provider, apiHost, repo, details.branch);
  if (!live.ok || live.data !== null) return unknownHostingEvidence("hosting.delete_branch");
  const evidenceDigest = sha256(details);
  return success(null, null, {
    outcome: "succeeded",
    evidenceDigest,
    observation: { kind: "provider_read", actionRef, outcome: "succeeded", evidenceDigest },
  });
};

const youTrackBase = (): string | null => {
  try {
    const config = JSON.parse(fs.readFileSync(youTrackConfigPath(), "utf8")) as {
      baseUrl?: unknown;
    };
    const value = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
    if (!value || /[\s#?]/.test(value)) return null;
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
};

const youTrackWritePreflight = (): Result<null> => {
  if (process.env.WORKFLOW_YT_WRITE !== "1")
    return failure("capability_unavailable", "YouTrack write capability is unavailable", {
      capability: "youtrack_write",
      outcome: "not_started",
    });
  const credentials = youTrackToken();
  if ("error" in credentials)
    return failure("capability_unavailable", "YouTrack credentials are unavailable", {
      capability: "youtrack",
      outcome: "not_started",
    });
  return success(null, null, null);
};

/**
 * A dirty tree binds stash up front so the proposal names it and one
 * approval carries the whole effect instead of failing at preflight.
 * Carry-class dirt (untracked or docs-confined) rides along silently.
 * Returns the original resolution untouched unless an upgrade applies.
 */
export const upgradeBranchSetupForStash = (
  root: string,
  parsed: ExternalActionRequest,
  resolved: Result<ResolvedExternalAction>,
): Result<ResolvedExternalAction> => {
  if (!resolved.ok || resolved.data.request.operation !== "git.branch_setup") return resolved;
  const target = actionRoot(root, parsed);
  if (
    (resolved.data.descriptorPayload as { resolved?: { dirty?: unknown } }).resolved?.dirty !==
      true ||
    (resolved.data.descriptorPayload as { stash?: unknown }).stash === "yes" ||
    !target.ok ||
    classifyBranchDirt(target.data) !== "stash-required"
  )
    return resolved;
  const upgraded = resolveExternalActionRequest(root, {
    ...parsed,
    payload: { ...(parsed.payload as Record<string, unknown>), stash: "yes" },
  } as typeof parsed);
  return upgraded.ok ? upgraded : resolved;
};

const resolveExternalActionAtRoot = (
  root: string,
  request: ExternalActionRequest,
  preservedDateMs?: number,
): Result<ResolvedExternalAction> => {
  try {
    switch (request.operation) {
      case "git.branch_setup": {
        const sdd_dir = safePath(root, request.payload.sdd_dir ?? "docs");
        if (!sdd_dir) return failure("invalid_input", "sdd_dir must stay inside the workspace");
        const action = request.payload.action ?? "setup";
        const policySnapshot = branchPolicySnapshotFor(root);
        const policy = policySnapshot.branchPolicy;
        const target_branch = request.payload.target_branch;
        if (action !== "reapply_stash" && !target_branch)
          return failure(
            "invalid_input",
            "target_branch (the working branch to create or switch to) is required for setup",
            {
              outcome: "not_started",
              fields: [{ path: "target_branch", reason: "required for action=setup" }],
            },
          );
        if (target_branch) {
          const check = validateBranchNamePolicy(
            target_branch,
            policySnapshot.namePolicy,
            policySnapshot.source,
          );
          if (!check.ok)
            return failure("permission_denied", check.error, {
              outcome: "not_started",
              fields: [{ path: "target_branch", reason: check.rule }],
            });
        }
        const head = gitValue(root, ["rev-parse", "HEAD"]);
        if (!head) return failure("storage_error", "current Git commit could not be resolved");
        const dirty = Boolean((gitRaw(root, ["status", "--short"]) ?? "").trim());
        const creation =
          action === "reapply_stash" || !target_branch
            ? { base_branch: policy.defaultTargetBranch }
            : branchCreationBaseline(root, target_branch, policy.defaultTargetBranch);
        let stashTarget: { stash_ref: string; stash_commit: string } | undefined;
        if (action === "reapply_stash") {
          try {
            const manifest = JSON.parse(
              fs.readFileSync(path.join(sdd_dir, "manifest.json"), "utf8"),
            ) as { stash_ref?: unknown };
            const stash_ref = typeof manifest.stash_ref === "string" ? manifest.stash_ref : "";
            const stash_commit = stash_ref ? gitValue(root, ["rev-parse", stash_ref]) : null;
            if (stash_ref && stash_commit) stashTarget = { stash_ref, stash_commit };
          } catch {}
        }
        const normalized = {
          operation: request.operation,
          payload: {
            ...request.payload,
            action,
            sdd_dir,
            stash: request.payload.stash ?? "no",
            ...(target_branch ? { target_branch } : {}),
          },
        } as ExternalActionRequest;
        return success(null, null, {
          request: normalized,
          descriptorPayload: {
            ...normalized.payload,
            resolved: {
              head,
              dirty,
              ...creation,
              ...stashTarget,
              ...(target_branch ? { branchPolicyFingerprint: policySnapshot.fingerprint } : {}),
            },
          },
        });
      }
      case "git.push": {
        const branch = request.payload.branch ?? gitValue(root, ["branch", "--show-current"]);
        const commit = branch ? gitValue(root, ["rev-parse", branch]) : null;
        const remote = pushRemote(root);
        const identity = remote ? credentialFreeRemote(remote) : null;
        const provider = remote ? hostingProvider(root, remote) : null;
        const auth = provider ? vcsCliIdentity(root) : null;
        if (provider && (!auth?.ok || auth.provider !== provider))
          return failure("capability_unavailable", "hosting CLI identity is unavailable", {
            outcome: "not_started",
          });
        if (provider && auth?.ok && remote && !hostingApiHostMatches(remote, auth.host))
          return failure(
            "capability_unavailable",
            "hosting API host does not match the push destination",
            {
              outcome: "not_started",
            },
          );
        return branch && commit && identity
          ? success(null, null, {
              request: {
                operation: request.operation,
                payload: { branch, ...(request.payload.cwd ? { cwd: request.payload.cwd } : {}) },
              },
              descriptorPayload: {
                branch,
                ...(request.payload.cwd ? { cwd: request.payload.cwd } : {}),
                resolved: {
                  branch,
                  commit,
                  remote: identity,
                  ...(auth?.ok ? { account: auth.username } : {}),
                  ...(auth?.ok ? { apiHost: auth.host } : {}),
                },
              },
            })
          : failure("invalid_input", "git push requires a resolvable current branch");
      }
      case "git.commit": {
        const planSteps = request.payload.plan_steps;
        const planBranch = request.payload.plan_branch;
        const head = gitValue(root, ["rev-parse", "HEAD"]);
        if (!head) return failure("storage_error", "Git state could not be resolved");
        const branch = gitValue(root, ["branch", "--show-current"]);
        if (planSteps !== undefined || planBranch !== undefined) {
          const chain = Array.isArray(planSteps) ? normalizeChainSteps(planSteps) : null;
          if (!chain)
            return failure(
              "invalid_input",
              "plan_steps must be 1-32 unique non-empty commit messages, branch targets, or pull_request markers",
              {
                outcome: "not_started",
                fields: [{ path: "plan_steps", reason: "unique steps" }],
              },
            );
          const commitSteps = chain.filter((step) => step.kind === "commit");
          const branchSteps = chain.filter((step) => step.kind === "branch");
          const commitPolicy = commitSteps.length ? commitPolicySnapshotFor(root) : null;
          const branchPolicy = branchSteps.length ? branchPolicySnapshotFor(root) : null;
          for (const step of commitSteps) {
            if (step.kind !== "commit" || !commitPolicy) continue;
            const check = validateCommitMessagePolicy(
              step.message,
              commitPolicy.policy,
              commitPolicy.source,
            );
            if (!check.ok)
              return failure("permission_denied", check.error, {
                outcome: "not_started",
                fields: [{ path: "plan_steps", reason: check.rule }],
              });
          }
          for (const step of branchSteps) {
            if (step.kind !== "branch" || !branchPolicy) continue;
            const check = validateBranchNamePolicy(
              step.target,
              branchPolicy.namePolicy,
              branchPolicy.source,
            );
            if (!check.ok)
              return failure("permission_denied", check.error, {
                outcome: "not_started",
                fields: [{ path: "plan_steps", reason: check.rule }],
              });
          }
          if (typeof planBranch !== "string" || !planBranch.trim())
            return failure("invalid_input", "plan_branch must name the working branch", {
              outcome: "not_started",
              fields: [{ path: "plan_branch", reason: "required" }],
            });
          // A chain that creates its own branch names that branch; otherwise
          // the plan runs on the branch already checked out.
          const first = chain[0];
          const createsBranch = first?.kind === "branch";
          if (createsBranch ? planBranch !== first.target : planBranch !== branch)
            return failure(
              "invalid_input",
              createsBranch
                ? "plan_branch must name the branch the chain creates"
                : "plan_branch must name the current working branch",
              {
                outcome: "not_started",
                fields: [
                  {
                    path: "plan_branch",
                    reason: createsBranch ? "chain branch" : "current branch",
                  },
                ],
              },
            );
          return success(null, null, {
            request,
            descriptorPayload: {
              plan_steps: planSteps,
              plan_branch: planBranch,
              resolved: {
                head,
                branch,
                steps: planSteps,
                ...(commitPolicy ? { commitPolicyFingerprint: commitPolicy.fingerprint } : {}),
                ...(branchPolicy ? { branchPolicyFingerprint: branchPolicy.fingerprint } : {}),
              },
            },
          });
        }
        const staged = gitRaw(root, [
          "diff",
          "--cached",
          "--raw",
          "-z",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
        ]);
        const paths = stagedPaths(root);
        const message = request.payload.message;
        if (typeof message !== "string" || !message)
          return failure("invalid_input", "git.commit requires a commit message", {
            outcome: "not_started",
            fields: [{ path: "message", reason: "required unless plan_steps is provided" }],
          });
        if (staged === null || paths === null)
          return failure("storage_error", "Git state could not be resolved");
        const commitPolicy = commitPolicySnapshotFor(root);
        const commitCheck = validateCommitMessagePolicy(
          message,
          commitPolicy.policy,
          commitPolicy.source,
        );
        if (!commitCheck.ok)
          return failure("permission_denied", commitCheck.error, {
            outcome: "not_started",
            fields: [{ path: "message", reason: commitCheck.rule }],
          });
        return success(null, null, {
          request,
          descriptorPayload: {
            ...request.payload,
            resolved: {
              head,
              branch,
              staged: sha256(staged),
              paths,
              commitPolicyFingerprint: commitPolicy.fingerprint,
            },
          },
        });
      }
      case "hosting.pull_request": {
        const target_branch =
          request.payload.target_branch ?? resolveBranchPolicyFor(root).defaultTargetBranch;
        const source_branch = gitValue(root, ["branch", "--show-current"]);
        const source_commit = source_branch
          ? gitValue(root, ["rev-parse", "--verify", `refs/heads/${source_branch}`])
          : null;
        const remote = pushRemote(root);
        const identity = remote ? credentialFreeRemote(remote) : null;
        const vcs = vcsConfig("load", root);
        const provider = remote ? hostingProvider(root, remote) : null;
        if (
          !source_branch ||
          !source_commit ||
          !identity ||
          !vcs.ok ||
          !provider ||
          provider !== vcs.provider
        )
          return failure(
            "capability_unavailable",
            "hosting target is not bound to the configured remote provider",
            { capability: "hosting.pull_request", outcome: "not_started" },
          );
        const auth = vcsCliIdentity(root);
        if (!auth.ok || auth.provider !== provider || !hostingCliAvailable(provider))
          return failure("capability_unavailable", "hosting CLI identity is unavailable", {
            capability: "hosting.pull_request",
            outcome: "not_started",
          });
        if (!remote || !hostingApiHostMatches(remote, auth.host))
          return failure(
            "capability_unavailable",
            "hosting API host does not match the push destination",
            { capability: "hosting.pull_request", outcome: "not_started" },
          );
        const merge_base_commit =
          resolveBranchPolicyFor(root).integration === "merge"
            ? gitValue(root, ["rev-parse", "--verify", `refs/heads/${target_branch}`])
            : null;
        const normalized = {
          operation: request.operation,
          payload: { ...request.payload, target_branch },
        } as ExternalActionRequest;
        const marker = `<!-- workit-action:${sha256({ operation: request.operation, payload: normalized.payload, source_commit, remote: identity })} -->`;
        return success(null, null, {
          request: normalized,
          marker,
          descriptorPayload: {
            ...normalized.payload,
            resolved: {
              source_branch,
              source_commit,
              remote: identity,
              target_branch,
              marker,
              account: auth.username,
              apiHost: auth.host,
              ...(merge_base_commit ? { merge_base_commit } : {}),
            },
          },
        });
      }
      case "hosting.merge": {
        const target_branch =
          request.payload.target_branch ?? resolveBranchPolicyFor(root).defaultTargetBranch;
        const source_branch =
          request.payload.source_branch ?? gitValue(root, ["branch", "--show-current"]);
        const source_commit = source_branch
          ? gitValue(root, ["rev-parse", "--verify", `refs/heads/${source_branch}`])
          : null;
        const remote = pushRemote(root);
        const identity = remote ? credentialFreeRemote(remote) : null;
        const vcs = vcsConfig("load", root);
        const provider = remote ? hostingProvider(root, remote) : null;
        if (!source_branch || !source_commit || !identity || !vcs.ok || provider !== vcs.provider)
          return failure(
            "capability_unavailable",
            "hosting target is not bound to the configured remote provider",
            { capability: "hosting.merge" },
          );
        const auth = vcsCliIdentity(root);
        if (!vcs.ok || !auth.ok)
          return failure("capability_unavailable", "hosting credentials are unavailable", {
            capability: "hosting.merge",
            outcome: "not_started",
          });
        if (!remote || !hostingApiHostMatches(remote, auth.host))
          return failure(
            "capability_unavailable",
            "hosting API host does not match the push destination",
            {
              capability: "hosting.merge",
              outcome: "not_started",
            },
          );
        if (!hostingCliAvailable(String(vcs.provider)))
          return failure("capability_unavailable", "hosting CLI is unavailable", {
            capability: "hosting.merge",
            outcome: "not_started",
          });
        const normalized = {
          operation: request.operation,
          payload: { ...request.payload, target_branch, source_branch },
        } as ExternalActionRequest;
        const marker = `<!-- workit-action:${sha256({ operation: request.operation, payload: normalized.payload, source_commit, remote: identity })} -->`;
        return success(null, null, {
          request: normalized,
          marker,
          descriptorPayload: {
            ...normalized.payload,
            resolved: {
              source_branch,
              source_commit,
              remote: identity,
              target_branch,
              marker,
              account: auth.username,
              apiHost: auth.host,
            },
          },
        });
      }
      case "hosting.delete_branch": {
        const checked = mergedBranch(root, request.payload.branch);
        return checked.ok
          ? success(null, null, {
              request,
              descriptorPayload: { ...request.payload, resolved: checked.data },
            })
          : (checked as Result<never>);
      }
      case "changelog.apply": {
        const preview = changelogApplyPreview({ ...request.payload, workspace_root: root });
        if (preview.error) return failure("invalid_input", preview.error);
        const target = String(preview.path);
        const relative =
          path.relative(fs.realpathSync(root), target).replaceAll(path.sep, "/") || "CHANGELOG.md";
        const normalized = {
          operation: request.operation,
          payload: {
            ...request.payload,
            path: relative,
            entries: preview.entries,
            normalize_only: preview.normalize_only,
          },
        } as ExternalActionRequest;
        return success(null, null, {
          request: normalized,
          descriptorPayload: {
            ...normalized.payload,
            resolved: {
              target,
              beforeDigest: preview.beforeDigest,
              beforeExists: preview.beforeExists,
              afterDigest: preview.afterDigest,
            },
          },
        });
      }
      case "context.read":
        return success(null, null, { request, descriptorPayload: request.payload });
      case "youtrack.time":
        if (request.payload.dateMs === undefined)
          return failure("invalid_input", "youtrack.time requires an explicit dateMs");
        {
          const available = youTrackWritePreflight();
          if (!available.ok) return available as Result<ResolvedExternalAction>;
          const baseUrl = youTrackBase();
          const date = youTrackWorkDateMs(String(request.payload.dateMs));
          if (!baseUrl)
            return failure("capability_unavailable", "YouTrack base URL is unavailable", {
              capability: "youtrack",
            });
          if ("error" in date)
            return failure("capability_unavailable", "YouTrack work date is unavailable", {
              capability: "youtrack",
            });
          const marker = `<!-- workit-action:${sha256({ operation: request.operation, issueId: request.payload.issueId, baseUrl, payload: request.payload, dateMs: date.data.dateMs })} -->`;
          const workText = appendMarker(request.payload.text ?? "", marker);
          return success(null, null, {
            request,
            marker,
            descriptorPayload: {
              ...request.payload,
              resolved: {
                baseUrl,
                issueId: request.payload.issueId,
                marker,
                dateMs: date.data.dateMs,
                workText,
                minutes: request.payload.minutes,
                steps: ["time"],
              },
            },
          });
        }
      case "youtrack.update":
      case "youtrack.meeting": {
        const available = youTrackWritePreflight();
        if (!available.ok) return available as Result<ResolvedExternalAction>;
        const baseUrl = youTrackBase();
        const date = youTrackWorkDateMs(
          preservedDateMs === undefined ? "auto" : String(preservedDateMs),
        );
        if (!baseUrl)
          return failure("capability_unavailable", "YouTrack base URL is unavailable", {
            capability: "youtrack",
          });
        if ("error" in date)
          return failure("capability_unavailable", "YouTrack work date is unavailable", {
            capability: "youtrack",
          });
        const marker = `<!-- workit-action:${sha256({ operation: request.operation, issueId: request.payload.issueId, baseUrl, payload: request.payload, dateMs: date.data.dateMs })} -->`;
        const text =
          request.operation === "youtrack.update" ? request.payload.markdown : request.payload.text;
        const annotated = appendMarker(text, marker);
        const steps =
          request.operation === "youtrack.update"
            ? request.payload.minutes
              ? ["comment", "time"]
              : ["comment"]
            : ["time"];
        return success(null, null, {
          request,
          marker,
          descriptorPayload: {
            ...request.payload,
            resolved: {
              baseUrl,
              issueId: request.payload.issueId,
              marker,
              dateMs: date.data.dateMs,
              ...(request.operation === "youtrack.update" ? { commentText: annotated } : {}),
              workText: annotated,
              ...(request.payload.minutes !== undefined
                ? { minutes: request.payload.minutes }
                : {}),
              steps,
            },
          },
        });
      }
      default:
        return success(null, null, {
          request: request as never,
          descriptorPayload: (request as unknown as { payload: unknown }).payload,
        });
    }
  } catch {
    return failure("storage_error", "external action target could not be resolved");
  }
};

export const resolveExternalActionRequest = (
  taskRoot: string,
  request: ExternalActionRequest,
  preservedDateMs?: number,
): Result<ResolvedExternalAction> => {
  const target = actionRoot(taskRoot, request);
  if (!target.ok) return target as Result<never>;
  const bindTarget = bindsActionTarget(request.operation);
  const normalized = bindTarget
    ? ({ ...request, payload: { ...request.payload, cwd: target.data } } as ExternalActionRequest)
    : request;
  const resolved = resolveExternalActionAtRoot(target.data, normalized, preservedDateMs);
  if (!resolved.ok || !bindTarget) return resolved;
  return success(null, null, {
    ...resolved.data,
    request: {
      ...resolved.data.request,
      payload: { ...resolved.data.request.payload, cwd: target.data },
    } as ExternalActionRequest,
    descriptorPayload: {
      ...(resolved.data.descriptorPayload as Record<string, unknown>),
      cwd: target.data,
    },
  });
};

export const prBabysitNext = (output: string): string =>
  `PR ready: ${output}. Babysitting was explicitly requested. Follow workit-babysit to resolve conflicts, review threads, and get checks green. Stop at PR-ready; a PR or babysit request does not authorize merge or release.`;

export const executeConcreteExternalAction = async (
  request: ExternalActionRequest,
  root: string,
  marker?: string,
  dateMs?: number,
  step?: string,
  workText?: string,
  caller?: { host: Caller["host"]; actor: string },
  approvedBeforeDigest?: string,
  approvedBeforeExists?: boolean,
  coordinationRoot: string = root,
  approvedTip?: string,
  approvedRemote?: string,
  approvedAccount?: string,
  approvedApiHost?: string,
  approvedSourceCommit?: string,
  approvedCommit?: string,
  approvedRemoteBase?: string,
  approvedLocalBase?: string | null,
  writerActionLease?: symbol,
  approvedSourceBranch?: string,
  approvedMergeBaseCommit?: string,
  expectedWorkspaceRevision?: string,
): Promise<Result<unknown>> => {
  if (localAction(request.operation)) {
    if (!caller)
      return failure(
        "capability_unavailable",
        "local external action writer authority is unavailable",
        { outcome: "not_started" },
      );
    const paths =
      request.operation === "git.commit"
        ? stagedPaths(root)
        : request.operation === "changelog.apply"
          ? [request.payload.path ?? "CHANGELOG.md"]
          : ["."];
    if (paths === null)
      return failure(
        "capability_unavailable",
        "local external action staged paths are unavailable",
        { outcome: "not_started" },
      );
    const writer = assertLocalExternalActionWriter(
      coordinationRoot,
      caller,
      paths,
      expectedWorkspaceRevision,
    );
    if (!writer.ok)
      return failure(
        "capability_unavailable",
        "local external action writer authority is unavailable",
        { outcome: "not_started" },
      );
    if (writerActionLease !== targetWriterActionLease)
      return new TaskStore(root).withExternalActionLock(() =>
        executeConcreteExternalAction(
          request,
          root,
          marker,
          dateMs,
          step,
          workText,
          caller,
          approvedBeforeDigest,
          approvedBeforeExists,
          coordinationRoot,
          approvedTip,
          approvedRemote,
          approvedAccount,
          approvedApiHost,
          approvedSourceCommit,
          approvedCommit,
          approvedRemoteBase,
          approvedLocalBase,
          targetWriterActionLease,
          approvedSourceBranch,
          approvedMergeBaseCommit,
          expectedWorkspaceRevision,
        ),
      );
    if (!sameDirectoryIdentity(root, coordinationRoot)) {
      const targetWorkspace = new TaskStore(root).readWorkspace();
      if (!targetWorkspace.ok) return targetWorkspace as Result<never>;
      const owner = targetWorkspace.data?.writer?.owner;
      if (
        owner &&
        (owner.taskId !== writer.data.taskId ||
          owner.workerId !== writer.data.workerId ||
          owner.session.host !== caller.host ||
          owner.session.handle !== caller.actor)
      )
        return failure("writer_conflict", "target checkout is owned by another writer", {
          outcome: "not_started",
        });
    }
  }
  switch (request.operation) {
    case "git.branch_setup": {
      const result = branchSetup({
        ...request.payload,
        sdd_dir: request.payload.sdd_dir ?? "docs",
        workspace_root: root,
        expected_remote_base: approvedRemoteBase,
        expected_local_base: approvedLocalBase,
      });
      if ("error" in result) {
        if (result.phase === "preflight")
          return failure("invalid_input", result.error, {
            outcome: "not_started",
            operation: request.operation,
          });
        return unknown(request.operation);
      }
      return success(null, null, result);
    }
    case "git.commit": {
      const message = request.payload.message;
      if (typeof message !== "string" || !message)
        return failure("invalid_input", "git.commit requires a commit message", {
          outcome: "not_started",
          fields: [{ path: "message", reason: "required" }],
        });
      const result = run(root, ["commit", "-m", message]);
      return result.exitCode === 0
        ? success(null, null, { stdout: result.stdout.trim() })
        : unknown(request.operation);
    }
    case "git.push": {
      const remote = pushRemote(root);
      const identity = remote ? pushRemoteIdentity(remote) : null;
      const target = remote ? safePushUrl(remote) : null;
      const provider = remote ? hostingProvider(root, remote) : null;
      const auth = provider ? vcsCliIdentity(root) : null;
      if (
        !remote ||
        !identity ||
        !target ||
        !pushTargetIsStable(root, remote) ||
        (approvedRemote && identity !== approvedRemote)
      )
        return failure(
          "capability_unavailable",
          "push destination is ambiguous, rewritten, or changed after approval",
          {
            outcome: "not_started",
          },
        );
      if (provider && (!auth?.ok || !hostingApiHostMatches(remote, auth.host)))
        return failure(
          "capability_unavailable",
          "hosting API host does not match the push destination",
          {
            outcome: "not_started",
          },
        );
      if (
        approvedAccount &&
        (!auth?.ok || auth.username?.toLowerCase() !== approvedAccount.toLowerCase())
      )
        return failure(
          "capability_unavailable",
          "approved hosting account changed before execution",
          {
            outcome: "not_started",
          },
        );
      if (approvedApiHost && (!auth?.ok || auth.host !== approvedApiHost))
        return failure("capability_unavailable", "approved hosting host changed before execution", {
          outcome: "not_started",
        });
      const branch = request.payload.branch!;
      if (!approvedCommit || !/^[a-f0-9]{40,64}$/i.test(approvedCommit))
        return failure("capability_unavailable", "approved push commit is unavailable", {
          outcome: "not_started",
        });
      if (run(root, ["check-ref-format", "--branch", branch]).exitCode !== 0)
        return failure("invalid_input", "push branch name is invalid", { outcome: "not_started" });
      if (gitValue(root, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== approvedCommit)
        return failure("capability_unavailable", "approved push branch changed before execution", {
          outcome: "not_started",
        });
      const result = run(root, ["push", target, `${approvedCommit}:refs/heads/${branch}`]);
      return result.exitCode === 0
        ? success(null, null, { stdout: result.stdout.trim() })
        : unknown(request.operation);
    }
    case "hosting.pull_request": {
      if (
        !approvedSourceCommit ||
        !approvedSourceBranch ||
        !approvedRemote ||
        !approvedAccount ||
        !approvedApiHost
      )
        return failure("capability_unavailable", "approved PR source or target is incomplete", {
          outcome: "not_started",
        });
      const body = appendMarker(request.payload.body ?? "", marker ?? "");
      const result = prCreate(
        {
          ...process.env,
          WF_PR_TITLE: request.payload.title,
          WF_PR_BODY: body,
          WF_PR_CONFIRMED: "true",
          WF_PR_DRAFT: request.payload.draft ? "true" : "false",
          WF_PR_TARGET: request.payload.target_branch ?? "",
          WORKIT_EXPECTED_SOURCE_BRANCH: approvedSourceBranch,
          WORKIT_EXPECTED_SOURCE_COMMIT: approvedSourceCommit,
          WORKIT_EXPECTED_REMOTE: approvedRemote,
          WORKIT_EXPECTED_ACCOUNT: approvedAccount,
          WORKIT_EXPECTED_API_HOST: approvedApiHost,
          ...(approvedMergeBaseCommit
            ? { WORKIT_EXPECTED_MERGE_BASE_COMMIT: approvedMergeBaseCommit }
            : {}),
        },
        root,
      );
      if (result.error || result.ok === false) return unknown(request.operation);
      const babysit = request.payload.babysit === true;
      return success(null, null, {
        ...result,
        ...(request.payload.babysit !== undefined ? { babysit: request.payload.babysit } : {}),
        ...(babysit
          ? {
              babysitSkill: "workit-babysit",
              next: prBabysitNext(String(result.output ?? "")),
            }
          : {}),
      });
    }
    case "hosting.merge": {
      const target = String(request.payload.target_branch ?? "");
      const source = String(request.payload.source_branch ?? "");
      if (!target || !source)
        return failure("invalid_input", "hosting.merge requires target and source branches", {
          outcome: "not_started",
          fields: [{ path: "target_branch", reason: "required" }],
        });
      if (!approvedSourceCommit || !approvedRemote || !approvedAccount || !approvedApiHost)
        return failure("capability_unavailable", "approved merge target is incomplete", {
          outcome: "not_started",
        });
      const result = mergePr(root, {
        target,
        source,
        sourceCommit: approvedSourceCommit,
        remote: approvedRemote,
        account: approvedAccount,
        apiHost: approvedApiHost,
      });
      return result.error || result.ok === false
        ? unknown(request.operation)
        : success(null, null, result);
    }
    case "hosting.delete_branch": {
      const remote = pushRemote(root);
      const identity = remote ? pushRemoteIdentity(remote) : null;
      const target = remote ? safePushUrl(remote) : null;
      const auth = vcsCliIdentity(root);
      if (!approvedTip || !/^[a-f0-9]{40,64}$/.test(approvedTip))
        return failure("invalid_input", "approved branch tip is unavailable", {
          outcome: "not_started",
        });
      if (
        !remote ||
        !identity ||
        !target ||
        !pushTargetIsStable(root, remote) ||
        (approvedRemote && identity !== approvedRemote)
      )
        return failure(
          "capability_unavailable",
          "deletion destination is ambiguous, rewritten, or changed after approval",
          {
            outcome: "not_started",
          },
        );
      if (!auth.ok || !hostingApiHostMatches(remote, auth.host))
        return failure(
          "capability_unavailable",
          "hosting API host does not match the deletion destination",
          {
            outcome: "not_started",
          },
        );
      if (
        approvedAccount &&
        (!auth.ok || auth.username?.toLowerCase() !== approvedAccount.toLowerCase())
      )
        return failure(
          "capability_unavailable",
          "approved hosting account changed before execution",
          {
            outcome: "not_started",
          },
        );
      if (approvedApiHost && (!auth.ok || auth.host !== approvedApiHost))
        return failure("capability_unavailable", "approved hosting host changed before execution", {
          outcome: "not_started",
        });
      const branch = request.payload.branch;
      const result = run(root, [
        "push",
        `--force-with-lease=refs/heads/${branch}:${approvedTip}`,
        "--delete",
        target,
        branch,
      ]);
      if (result.exitCode === 0) return success(null, null, { branch, deletedTip: approvedTip });
      return /stale info|cannot lock ref|fetch first|non-fast-forward/i.test(result.stderr)
        ? failure("capability_unavailable", "remote branch tip changed before deletion", {
            outcome: "not_started",
          })
        : unknown(request.operation);
    }
    case "changelog.apply": {
      const preview = changelogApplyPreview({ ...request.payload, workspace_root: root });
      if (
        preview.error ||
        (approvedBeforeDigest !== undefined && preview.beforeDigest !== approvedBeforeDigest) ||
        (approvedBeforeExists !== undefined && preview.beforeExists !== approvedBeforeExists)
      )
        return failure(
          "capability_unavailable",
          "approved changelog target changed before execution",
          { outcome: "not_started" },
        );
      const result = changelogApply({ ...request.payload, workspace_root: root });
      return result.error
        ? failure("storage_error", String(result.error))
        : success(null, null, result);
    }
    case "youtrack.update": {
      if (step === "comment") {
        const result = await defaultOperations.postComment(
          request.payload.issueId,
          appendMarker(request.payload.markdown, marker ?? ""),
          root,
        );
        return success(null, null, result);
      }
      if (step === "time") {
        const result = await logTimeUpdate(
          {
            confirmed: true,
            issueId: request.payload.issueId,
            minutes: request.payload.minutes,
            text: workText ?? appendMarker(request.payload.markdown, marker ?? ""),
            dateMs,
            workspace_root: root,
          },
          defaultOperations,
        );
        return result.ok ? success(null, null, result.data) : unknown(request.operation);
      }
      const result = await postUpdate(
        {
          confirmed: true,
          issueId: request.payload.issueId,
          markdown: appendMarker(request.payload.markdown, marker ?? ""),
          minutes: request.payload.minutes,
          dateMs,
          workspace_root: root,
        },
        defaultOperations,
      );
      return result.ok ? success(null, null, result.data) : unknown(request.operation);
    }
    case "youtrack.time": {
      const result = await logTimeUpdate(
        {
          confirmed: true,
          issueId: request.payload.issueId,
          minutes: request.payload.minutes,
          text: appendMarker(request.payload.text ?? "", marker ?? ""),
          dateMs: dateMs ?? request.payload.dateMs,
          workspace_root: root,
        },
        defaultOperations,
      );
      return result.ok ? success(null, null, result.data) : unknown(request.operation);
    }
    case "youtrack.meeting": {
      const result = await logTimeUpdate(
        {
          confirmed: true,
          issueId: request.payload.issueId,
          minutes: request.payload.minutes,
          text: appendMarker(request.payload.text, marker ?? ""),
          dateMs,
          workspace_root: root,
        },
        defaultOperations,
      );
      return result.ok ? success(null, null, result.data) : unknown(request.operation);
    }
    case "context.read":
      return readExternalContext(root, request.payload);
  }
};

/** Re-resolve the concrete target after approval so mutable repository/config state cannot redirect it. */
export const executeResolvedExternalAction = async (
  resolved: ResolvedExternalAction,
  root: string,
  step?: string,
  caller?: { host: Caller["host"]; actor: string },
  expectedWorkspaceRevision?: string,
): Promise<Result<unknown>> => {
  const approvedDetails =
    resolved.descriptorPayload && typeof resolved.descriptorPayload === "object"
      ? (
          resolved.descriptorPayload as {
            resolved?: {
              dateMs?: unknown;
              beforeDigest?: unknown;
              beforeExists?: unknown;
              branchPolicyFingerprint?: unknown;
              commitPolicyFingerprint?: unknown;
            };
          }
        ).resolved
      : undefined;
  const preservedDateMs =
    (resolved.request.operation === "youtrack.update" ||
      resolved.request.operation === "youtrack.meeting") &&
    typeof approvedDetails?.dateMs === "number"
      ? approvedDetails.dateMs
      : undefined;
  const fresh = resolveExternalActionRequest(root, resolved.request, preservedDateMs);
  if (!fresh.ok) {
    if (fresh.code === "permission_denied") return fresh;
    return failure(
      "capability_unavailable",
      "approved external action target changed before execution",
      { outcome: "not_started" },
    );
  }
  const currentResolved = (
    fresh.data.descriptorPayload as {
      resolved?: {
        branchPolicyFingerprint?: unknown;
        commitPolicyFingerprint?: unknown;
      };
    }
  ).resolved;
  for (const [key, label] of [
    ["branchPolicyFingerprint", "branch naming policy"],
    ["commitPolicyFingerprint", "commit style policy"],
  ] as const) {
    const approvedFingerprint = approvedDetails?.[key];
    const currentFingerprint = currentResolved?.[key];
    if (
      (typeof approvedFingerprint === "string" || typeof currentFingerprint === "string") &&
      approvedFingerprint !== currentFingerprint
    )
      return failure(
        "permission_denied",
        `${label} changed since approval; approve the operation again`,
        { outcome: "not_started" },
      );
  }
  const freshDescriptor = externalActionDescriptor(
    resolved.request.operation,
    fresh.data.descriptorPayload,
  );
  const approvedDescriptor = externalActionDescriptor(
    resolved.request.operation,
    resolved.descriptorPayload,
  );
  const freshBranchIntent =
    resolved.request.operation === "git.branch_setup" ? branchSetupIntent(freshDescriptor) : null;
  const approvedBranchIntent =
    resolved.request.operation === "git.branch_setup"
      ? branchSetupIntent(approvedDescriptor)
      : null;
  const unchangedBranchIntent =
    freshBranchIntent !== null &&
    approvedBranchIntent !== null &&
    canonicalJson(freshBranchIntent) === canonicalJson(approvedBranchIntent);
  if (freshDescriptor !== approvedDescriptor && !unchangedBranchIntent)
    return failure(
      "capability_unavailable",
      "approved external action target changed before execution",
      { outcome: "not_started" },
    );
  const resolvedDetails = fresh.data.descriptorPayload as {
    resolved?: {
      dateMs?: unknown;
      beforeDigest?: unknown;
      beforeExists?: unknown;
      remote_base?: unknown;
      local_base?: unknown;
      target_exists?: unknown;
      tip?: unknown;
      remote?: unknown;
      account?: unknown;
      apiHost?: unknown;
      source_commit?: unknown;
      commit?: unknown;
      source_branch?: unknown;
      merge_base_commit?: unknown;
    };
  };
  const resolvedDate =
    typeof resolvedDetails.resolved?.dateMs === "number"
      ? resolvedDetails.resolved.dateMs
      : undefined;
  const workText = (fresh.data.descriptorPayload as { resolved?: { workText?: unknown } }).resolved
    ?.workText;
  const beforeDigest =
    typeof resolvedDetails.resolved?.beforeDigest === "string"
      ? resolvedDetails.resolved.beforeDigest
      : undefined;
  const beforeExists =
    typeof resolvedDetails.resolved?.beforeExists === "boolean"
      ? resolvedDetails.resolved.beforeExists
      : undefined;
  const approvedTip =
    typeof resolvedDetails.resolved?.tip === "string" ? resolvedDetails.resolved.tip : undefined;
  const approvedRemote =
    typeof resolvedDetails.resolved?.remote === "string"
      ? resolvedDetails.resolved.remote
      : undefined;
  const approvedAccount =
    typeof resolvedDetails.resolved?.account === "string"
      ? resolvedDetails.resolved.account
      : undefined;
  const approvedApiHost =
    typeof resolvedDetails.resolved?.apiHost === "string"
      ? resolvedDetails.resolved.apiHost
      : undefined;
  const approvedSourceCommit =
    typeof resolvedDetails.resolved?.source_commit === "string"
      ? resolvedDetails.resolved.source_commit
      : undefined;
  const approvedCommit =
    typeof resolvedDetails.resolved?.commit === "string"
      ? resolvedDetails.resolved.commit
      : undefined;
  const approvedRemoteBase =
    typeof resolvedDetails.resolved?.remote_base === "string"
      ? resolvedDetails.resolved.remote_base
      : undefined;
  const approvedLocalBase =
    typeof resolvedDetails.resolved?.local_base === "string"
      ? resolvedDetails.resolved.local_base
      : resolvedDetails.resolved?.local_base === null
        ? null
        : undefined;
  const approvedSourceBranch =
    typeof resolvedDetails.resolved?.source_branch === "string"
      ? resolvedDetails.resolved.source_branch
      : undefined;
  const approvedMergeBaseCommit =
    typeof resolvedDetails.resolved?.merge_base_commit === "string"
      ? resolvedDetails.resolved.merge_base_commit
      : undefined;
  if (
    fresh.data.request.operation === "git.branch_setup" &&
    fresh.data.request.payload.action !== "reapply_stash" &&
    resolvedDetails.resolved?.target_exists === false &&
    !approvedRemoteBase
  )
    return failure("capability_unavailable", "approved remote base SHA could not be resolved", {
      outcome: "not_started",
    });
  const target = actionRoot(root, fresh.data.request);
  if (!target.ok) return target;
  const result = await executeConcreteExternalAction(
    fresh.data.request,
    target.data,
    fresh.data.marker,
    resolvedDate,
    step,
    typeof workText === "string" ? workText : undefined,
    caller,
    beforeDigest,
    beforeExists,
    root,
    approvedTip,
    approvedRemote,
    approvedAccount,
    approvedApiHost,
    approvedSourceCommit,
    approvedCommit,
    approvedRemoteBase,
    approvedLocalBase,
    undefined,
    approvedSourceBranch,
    approvedMergeBaseCommit,
    expectedWorkspaceRevision,
  );
  if (result.ok && fresh.data.request.operation === "hosting.pull_request") {
    const observed = await readHostingAction(target.data, fresh.data, {
      kind: "host",
      host: caller?.host ?? "workit_cli",
      handle: `post-create:${fresh.data.marker ?? "unknown"}`,
    });
    const output = (result.data as { output?: unknown }).output;
    const id =
      typeof output === "string"
        ? /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(output)?.[1]
        : null;
    if (!observed.ok || !id || String(observed.data.data?.id) !== id)
      return unknown("hosting.pull_request");
  }
  if (!result.ok && result.code === "external_outcome_unknown" && caller) {
    const observed = await readExternalAction(root, fresh.data, {
      kind: "host",
      host: caller.host,
      handle: `local-recovery:${fresh.data.request.operation}`,
    });
    if (observed.ok) return success(null, null, { recovered: true });
  }
  return result;
};
