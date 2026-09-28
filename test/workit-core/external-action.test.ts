import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir as systemTmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  externalActionDescriptor,
  success,
  type NativeAuthorityVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import type { Provenance, Result } from "@/packages/workit-core/src/core/task-contract";
import { success as contractSuccess } from "@/packages/workit-core/src/core/task-contract";
import {
  createAuthorizedExternalActionRunner,
  externalActionState,
  priorExternalAction,
  runAuthorizedExternalAction,
} from "@/packages/workit-core/src/core/external-action";
import {
  actionProposalQuestion,
  approvedResolvedExternalAction,
  assertLocalExternalActionWriter,
  executeConcreteExternalAction,
  executeResolvedExternalAction,
  readExternalAction,
  readYouTrackAction,
  resolveExternalActionRequest,
} from "@/packages/workit-core/src/core/external-action-effects";
import { nativeExternalActionRunner } from "@/packages/workit-opencode/src/tools/workit";
import { assessment, scope, taskStartRequest } from "./task-fixtures";
import { stubCli, stubPath } from "@/test/shared/helpers/stub-cli";

const tmpdir = () => realpathSync(systemTmpdir());
// Native host CLIs are executables; shell-script stubs cannot be launched by spawnSync on Windows.
const t = process.platform === "win32" ? test.skip : test;

const provenance = (actor: string, host: Provenance["host"] = "workit_cli"): Provenance => ({
  kind: "host_observed",
  host,
  session: { kind: "host", host, handle: actor },
  workerId: null,
  receipts: [{ kind: "host", host, handle: `receipt:${actor}` }],
});

let decisionReceipt = 0;
const verifier = (
  actor: string,
  host: Provenance["host"] = "workit_cli",
): NativeAuthorityVerifier => ({
  verifyDecision: () =>
    success(null, null, {
      ...provenance(actor, host),
      receipts: [{ kind: "host", host, handle: `receipt:${actor}:${(decisionReceipt += 1)}` }],
    }),
  verifyAction: ({ caller, expected, observation }) => {
    if (
      caller.actor !== actor ||
      typeof observation !== "object" ||
      observation === null ||
      JSON.stringify((observation as { actionRef?: unknown }).actionRef) !==
        JSON.stringify(expected.actionRef) ||
      (observation as { outcome?: unknown }).outcome !== expected.outcome
    )
      return {
        ok: false,
        schemaVersion: 1,
        code: "permission_denied",
        error: "action observation mismatch",
        details: {},
      };
    return success(null, null, provenance(actor, host));
  },
  verifyReconciliation: ({ caller, expected, observation }) => {
    const value = observation as Record<string, unknown>;
    if (
      caller.actor !== actor ||
      value?.kind !== "provider_read" ||
      value?.evidenceDigest !== expected.evidenceDigest ||
      JSON.stringify(value?.actionRef) !== JSON.stringify(expected.actionRef) ||
      value?.outcome !== expected.outcome
    )
      return {
        ok: false,
        schemaVersion: 1,
        code: "permission_denied",
        error: "reconciliation evidence mismatch",
        details: {},
      };
    return success(null, null, provenance(actor, host));
  },
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-external-action-"));
  const store = new TaskStore(root);
  const actor = "cli-action";
  const context: OperationContext = {
    root,
    caller: { host: "workit_cli", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeAuthority: verifier(actor),
  };
  const core = new WorkitCore(store, context);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const listed = store.listTasks();
  if (!listed.ok || listed.data.length !== 1) throw new Error("task setup failed");
  const task = store.readTask(listed.data[0].id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
  const decision = core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      purpose: "action",
      binding: {
        taskId: task.data.id,
        workspaceId: workspace.data.id,
        scope: task.data.intent.data.scope,
        presented: "run the approved external action",
        approvedContent: JSON.stringify({ operation: "git.commit", payload: { message: "same" } }),
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    },
    { kind: "decision", actor },
  );
  if (!decision.ok) throw new Error(decision.error);
  const current = store.readTask(task.data.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("decision setup failed");
  return {
    root,
    store,
    core,
    task: current.data,
    workspace: currentWorkspace.data,
    decision: decision.data,
  };
};

type SetupState = {
  root: string;
  store: TaskStore;
  core: WorkitCore;
  task: { id: string; revision: string };
  workspace: { revision: string };
  decision: { id: string };
};

const inputFor = (setup: SetupState) => {
  const actionRef = { kind: "host" as const, host: "workit_cli" as const, handle: "external-1" };
  return {
    core: setup.core,
    taskId: setup.task.id,
    decisionId: setup.decision.id,
    actionRef,
    expectedRevision: setup.task.revision,
    expectedWorkspaceRevision: setup.workspace.revision,
    reserveObservation: { actionRef, outcome: "reserve" },
    settleObservation: (outcome: "succeeded" | "not_started" | "unknown") => ({
      actionRef,
      outcome,
    }),
  };
};

test("managed Git actions validate policy and invalidate only relevant policy changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-action-policy-repo-"));
  const config = mkdtempSync(join(tmpdir(), "workit-action-policy-config-"));
  const envKeys = [
    "WORKFLOW_TOOLKIT_CONFIG",
    "WORKFLOW_TOOLKIT_CONFIG_DIR",
    "WORKFLOW_PROFILE",
    "WORKFLOW_WORKSPACE_NAME",
  ] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const writePolicy = (branchAllowed: string[], commitPolicy: object, ui?: object) => {
    writeFileSync(
      join(config, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: branchAllowed, protected: ["main"] },
        commitPolicy,
        ui,
      }),
    );
    writeFileSync(join(config, "workspaces.json"), JSON.stringify({ workspaces: [] }));
  };
  try {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    delete process.env.WORKFLOW_PROFILE;
    delete process.env.WORKFLOW_WORKSPACE_NAME;
    process.env.WORKFLOW_TOOLKIT_CONFIG = config;
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Workit Test"]);
    writeFileSync(join(root, "initial.txt"), "initial\n");
    git(["add", "initial.txt"]);
    git(["commit", "-qm", "initial"]);
    writePolicy(["feature/*"], { preset: "conventional" });

    const protectedBranch = resolveExternalActionRequest(root, {
      operation: "git.branch_setup",
      payload: { target_branch: "main" },
    });
    expect(protectedBranch).toMatchObject({
      ok: false,
      code: "permission_denied",
      error: expect.stringContaining('protected_ref: branch "main" is protected by user-default'),
    });
    if (protectedBranch.ok) throw new Error("protected branch unexpectedly resolved");

    const branchRequest = {
      operation: "git.branch_setup" as const,
      payload: { target_branch: "feature/policy-check" },
    };
    const approvedBranch = resolveExternalActionRequest(root, branchRequest);
    if (!approvedBranch.ok) throw new Error(approvedBranch.error);
    const approvedBranchFingerprint = (
      approvedBranch.data.descriptorPayload as { resolved: { branchPolicyFingerprint: string } }
    ).resolved.branchPolicyFingerprint;
    writePolicy(["feature/*"], { preset: "conventional" }, { language: "es" });
    const presentationChange = resolveExternalActionRequest(root, branchRequest);
    if (!presentationChange.ok) throw new Error(presentationChange.error);
    expect(
      (
        presentationChange.data.descriptorPayload as {
          resolved: { branchPolicyFingerprint: string };
        }
      ).resolved.branchPolicyFingerprint,
    ).toBe(approvedBranchFingerprint);
    writePolicy(["feature/*", "fix/*"], { preset: "conventional" }, { language: "es" });
    const changedBranchPolicy = await executeResolvedExternalAction(approvedBranch.data, root);
    expect(changedBranchPolicy).toMatchObject({
      ok: false,
      code: "permission_denied",
      error: "branch naming policy changed since approval; approve the operation again",
      details: { outcome: "not_started" },
    });
    expect(git(["show-ref", "--verify", "refs/heads/feature/policy-check"]).status).not.toBe(0);

    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    const commitRequest = {
      operation: "git.commit" as const,
      payload: { message: "fix: preserve the staged change" },
    };
    const approvedCommit = resolveExternalActionRequest(root, commitRequest);
    if (!approvedCommit.ok) throw new Error(approvedCommit.error);
    const beforeHead = git(["rev-parse", "HEAD"]).stdout.trim();
    writePolicy(["feature/*", "fix/*"], { preset: "conventional" }, { language: "en" });
    const presentationOnly = resolveExternalActionRequest(root, commitRequest);
    if (!presentationOnly.ok) throw new Error(presentationOnly.error);
    expect(
      (
        presentationOnly.data.descriptorPayload as {
          resolved: { commitPolicyFingerprint: string };
        }
      ).resolved.commitPolicyFingerprint,
    ).toBe(
      (
        approvedCommit.data.descriptorPayload as {
          resolved: { commitPolicyFingerprint: string };
        }
      ).resolved.commitPolicyFingerprint,
    );
    writePolicy(
      ["feature/*", "fix/*"],
      { preset: "custom", pattern: "^(fix|feat):.*$" },
      { language: "en" },
    );
    const changedCommitPolicy = await executeResolvedExternalAction(approvedCommit.data, root);
    expect(changedCommitPolicy).toMatchObject({
      ok: false,
      code: "permission_denied",
      error: "commit style policy changed since approval; approve the operation again",
      details: { outcome: "not_started" },
    });
    expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(beforeHead);
    expect(git(["status", "--porcelain=v1"]).stdout).toContain("A  staged.txt");
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

test("one authorized external workflow reserves and settles without another prompt", async () => {
  const setupState = setup();
  try {
    let effects = 0;
    let effectFence = "";
    const result = await runAuthorizedExternalAction(inputFor(setupState), async (reservation) => {
      effects += 1;
      effectFence = reservation.workspaceRevision;
      return { remoteId: "pr-1" };
    });
    expect(result).toMatchObject({ ok: true, data: { remoteId: "pr-1" } });
    expect(effects).toBe(1);
    expect(effectFence).toBe(setupState.workspace.revision);
    const task = setupState.store.readTask(setupState.task.id);
    expect(task).toMatchObject({
      ok: true,
      data: { decisions: [{ data: { consumption: { state: "consumed" } } }] },
    });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("cross-checkout writer lease remains held through action settlement", async () => {
  const coordinator = setup();
  const target = setup();
  try {
    let consumedInsideLock: unknown;
    let writerInsideLock: Result<unknown> | null = null;
    const withTargetLock = async <T>(run: () => Promise<Result<T>>): Promise<Result<T>> =>
      new TaskStore(target.root).withExternalActionLock(async () => {
        const actionResult = await run();
        const task = coordinator.store.readTask(coordinator.task.id);
        const currentTarget = target.store.readTask(target.task.id);
        const workspace = target.store.readWorkspace();
        if (!task.ok || !currentTarget.ok || !workspace.ok || !workspace.data)
          throw new Error("settled action state missing");
        consumedInsideLock = task.data.decisions.find(
          (entry) => entry.id === coordinator.decision.id,
        )?.data.consumption?.state;
        writerInsideLock = target.core.writer({
          schemaVersion: 1,
          action: "acquire",
          taskId: currentTarget.data.id,
          expectedRevision: currentTarget.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
          workerId: null,
        });
        return actionResult;
      }, true);
    const result = await runAuthorizedExternalAction(
      inputFor(coordinator),
      async () => "effect complete",
      withTargetLock,
    );
    expect(result).toMatchObject({ ok: true, data: "effect complete" });
    expect(consumedInsideLock).toBe("consumed");
    expect(writerInsideLock).toMatchObject({ ok: false, code: "writer_conflict" });
    const currentTarget = target.store.readTask(target.task.id);
    const workspace = target.store.readWorkspace();
    if (!currentTarget.ok || !workspace.ok || !workspace.data)
      throw new Error("target state missing after settlement");
    expect(
      target.core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: currentTarget.data.id,
        expectedRevision: currentTarget.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }).ok,
    ).toBe(true);
  } finally {
    rmSync(coordinator.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("target writer lease remains held through coordinator action settlement", async () => {
  const coordinator = setup();
  const target = setup();
  let consumedInsideLock: unknown;
  let writerInsideLock: Result<unknown> | null = null;
  const withTargetLock = async <T>(run: () => Promise<Result<T>>): Promise<Result<T>> =>
    new TaskStore(target.root).withExternalActionLock(async () => {
      const result = await run();
      const task = coordinator.store.readTask(coordinator.task.id);
      const targetTask = target.store.readTask(target.task.id);
      const workspace = target.store.readWorkspace();
      if (!task.ok || !targetTask.ok || !workspace.ok || !workspace.data)
        throw new Error("action or target task state missing");
      consumedInsideLock = task.data.decisions.find((entry) => entry.id === coordinator.decision.id)
        ?.data.consumption?.state;
      writerInsideLock = target.core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: targetTask.data.id,
        expectedRevision: targetTask.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      });
      return result;
    }, true);
  try {
    const result = await runAuthorizedExternalAction(
      inputFor(coordinator),
      async () => "effect complete",
      withTargetLock,
    );
    expect(result).toMatchObject({ ok: true, data: "effect complete" });
    expect(consumedInsideLock).toBe("consumed");
    expect(writerInsideLock).toMatchObject({ ok: false, code: "writer_conflict" });

    const targetTask = target.store.readTask(target.task.id);
    const workspace = target.store.readWorkspace();
    if (!targetTask.ok || !workspace.ok || !workspace.data)
      throw new Error("target state missing after settlement");
    expect(
      target.core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: targetTask.data.id,
        expectedRevision: targetTask.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }).ok,
    ).toBe(true);
  } finally {
    rmSync(coordinator.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("authorized cross-checkout action holds the target writer lock through settlement", async () => {
  const coordinator = setup();
  const target = setup();
  const git = (args: string[]) => spawnSync("git", args, { cwd: target.root, encoding: "utf8" });
  let writerDuringEffect: Result<unknown> | null = null;
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      git(args);
    writeFileSync(join(target.root, "initial.txt"), "initial\n");
    git(["add", "initial.txt"]);
    git(["commit", "-qm", "initial"]);
    writeFileSync(join(target.root, "change.txt"), "change\n");
    git(["add", "change.txt"]);

    const coordinatorTask = coordinator.store.readTask(coordinator.task.id);
    const coordinatorWorkspace = coordinator.store.readWorkspace();
    if (!coordinatorTask.ok || !coordinatorWorkspace.ok || !coordinatorWorkspace.data)
      throw new Error("coordinator writer state missing");
    const coordinatorWriter = coordinator.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: coordinatorTask.data.id,
      expectedRevision: coordinatorTask.data.revision,
      expectedWorkspaceRevision: coordinatorWorkspace.data.revision,
      workerId: null,
    });
    if (!coordinatorWriter.ok) throw new Error(coordinatorWriter.error);

    const latestTask = coordinator.store.readTask(coordinator.task.id);
    const latestWorkspace = coordinator.store.readWorkspace();
    if (!latestTask.ok || !latestWorkspace.ok || !latestWorkspace.data)
      throw new Error("updated coordinator state missing");
    const { core: _core, ...binding } = {
      ...inputFor(coordinator),
      expectedRevision: latestTask.data.revision,
      expectedWorkspaceRevision: latestWorkspace.data.revision,
    };
    const runner = createAuthorizedExternalActionRunner(
      coordinator.core,
      () => binding,
      coordinator.root,
    );
    const message = "chore(test): cross-checkout commit";
    const result = await runner(
      externalActionDescriptor("git.commit", { cwd: target.root, message }),
      async () => {
        const action = await executeConcreteExternalAction(
          { operation: "git.commit", payload: { message } },
          target.root,
          undefined,
          undefined,
          undefined,
          undefined,
          { host: "workit_cli", actor: "cli-action" },
          undefined,
          undefined,
          coordinator.root,
        );
        const targetTask = target.store.readTask(target.task.id);
        const targetWorkspace = target.store.readWorkspace();
        if (!targetTask.ok || !targetWorkspace.ok || !targetWorkspace.data)
          throw new Error("target writer state missing");
        writerDuringEffect = target.core.writer({
          schemaVersion: 1,
          action: "acquire",
          taskId: targetTask.data.id,
          expectedRevision: targetTask.data.revision,
          expectedWorkspaceRevision: targetWorkspace.data.revision,
          workerId: null,
        });
        return action;
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(writerDuringEffect).toMatchObject({ ok: false, code: "writer_conflict" });
    expect(git(["log", "-1", "--pretty=%s"]).stdout.trim()).toBe(message);

    const targetTask = target.store.readTask(target.task.id);
    const targetWorkspace = target.store.readWorkspace();
    if (!targetTask.ok || !targetWorkspace.ok || !targetWorkspace.data)
      throw new Error("target state missing after settlement");
    expect(
      target.core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: targetTask.data.id,
        expectedRevision: targetTask.data.revision,
        expectedWorkspaceRevision: targetWorkspace.data.revision,
        workerId: null,
      }).ok,
    ).toBe(true);
  } finally {
    rmSync(coordinator.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("an uncertain external outcome blocks a retry until reconciliation", async () => {
  const setupState = setup();
  try {
    const first = await runAuthorizedExternalAction(inputFor(setupState), async () => {
      throw new Error("connection dropped");
    });
    expect(first).toMatchObject({ ok: false, code: "external_outcome_unknown" });
    const current = setupState.store.readTask(setupState.task.id);
    const workspace = setupState.store.readWorkspace();
    if (!current.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    expect(
      await runAuthorizedExternalAction(
        {
          ...inputFor(setupState),
          expectedRevision: current.data.revision,
          expectedWorkspaceRevision: workspace.data.revision,
        },
        async () => "duplicate",
      ),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("uncertain action dedupe is task/workspace bound, not actor bound", async () => {
  const setupState = setup();
  try {
    const input = inputFor(setupState);
    await runAuthorizedExternalAction(input, async () => {
      throw new Error("lost");
    });
    const prior = priorExternalAction(setupState.store, "pi", "new-session", "git.commit", {
      message: "same",
    });
    expect(prior).toMatchObject({
      ok: true,
      data: { entry: { data: { consumption: { state: "uncertain" } } } },
    });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("resolved remote descriptors never expose URL credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-remote-identity-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-remote-identity-tools-"));
  const previousPath = process.env.PATH;
  const previousVcsConfig = process.env.WORKFLOW_VCS_CONFIG;
  try {
    writeFileSync(
      join(tools, "vcs.json"),
      JSON.stringify({ provider: "github", github: { host: "github.com" } }),
    );
    process.env.WORKFLOW_VCS_CONFIG = join(tools, "vcs.json");
    stubCli(tools, "gh", join(tools, "gh.log"), "");
    process.env.PATH = stubPath(tools);
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["checkout", "-qb", "feature/credentials"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://user:secret@github.com/org/repo.git"], {
      cwd: root,
    });
    spawnSync(
      "git",
      [
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://push-user:push-secret@github.com/org/push.git",
      ],
      { cwd: root },
    );
    const resolved = resolveExternalActionRequest(root, { operation: "git.push", payload: {} });
    expect(resolved).toMatchObject({ ok: true });
    if (resolved.ok) {
      const descriptor = JSON.stringify(resolved.data.descriptorPayload);
      expect(descriptor).not.toContain("secret");
      expect(descriptor).not.toContain("user@");
      expect(descriptor).toContain("github.com/org/push.git");
      expect(descriptor).not.toContain("push-secret");
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousVcsConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousVcsConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("local external effects fail closed without the existing writer and do not mutate Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-writer-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "fixture\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: root });
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.commit",
      payload: { message: "chore(test): must not commit" },
    });
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    const result = await executeResolvedExternalAction(resolved.data, root, undefined, {
      host: "workit_cli",
      actor: "no-writer",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { outcome: "not_started" },
    });
    expect(
      spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    ).toBe(before);
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    ).toBe("fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-session writer lease in another task still blocks an action target", async () => {
  const coordinator = setup();
  const target = setup();
  const acquire = (state: SetupState) => {
    const task = state.store.readTask(state.task.id);
    const workspace = state.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("writer state missing");
    const result = state.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    });
    if (!result.ok) throw new Error(result.error);
  };
  try {
    spawnSync("git", ["init", "-q"], { cwd: target.root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: target.root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: target.root });
    writeFileSync(join(target.root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: target.root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: target.root });
    acquire(coordinator);
    acquire(target);
    const result = await executeConcreteExternalAction(
      { operation: "git.commit", payload: { message: "must not run" } },
      target.root,
      undefined,
      undefined,
      undefined,
      undefined,
      { host: "workit_cli", actor: "cli-action" },
      undefined,
      undefined,
      coordinator.root,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "writer_conflict",
      details: { outcome: "not_started" },
    });
  } finally {
    rmSync(coordinator.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("cross-checkout action lease blocks target writer acquisition until effect settles", async () => {
  const coordinator = setup();
  const target = setup();
  const targetStore = new TaskStore(target.root);
  const git = (args: string[]) => spawnSync("git", args, { cwd: target.root, encoding: "utf8" });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Workit Test"]);
    writeFileSync(join(target.root, "initial.txt"), "initial\n");
    git(["add", "initial.txt"]);
    git(["commit", "-qm", "initial"]);
    writeFileSync(join(target.root, "change.txt"), "change\n");
    git(["add", "change.txt"]);
    const coordinatorTask = coordinator.store.readTask(coordinator.task.id);
    const coordinatorWorkspace = coordinator.store.readWorkspace();
    if (!coordinatorTask.ok || !coordinatorWorkspace.ok || !coordinatorWorkspace.data)
      throw new Error("coordinator writer state missing");
    const coordinatorWriter = coordinator.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: coordinatorTask.data.id,
      expectedRevision: coordinatorTask.data.revision,
      expectedWorkspaceRevision: coordinatorWorkspace.data.revision,
      workerId: null,
    });
    if (!coordinatorWriter.ok) throw new Error(coordinatorWriter.error);

    const leased = await targetStore.withExternalActionLock(async () => {
      const targetTask = target.store.readTask(target.task.id);
      const targetWorkspace = target.store.readWorkspace();
      if (!targetTask.ok || !targetWorkspace.ok || !targetWorkspace.data)
        throw new Error("target writer state missing");
      const writer = target.core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: targetTask.data.id,
        expectedRevision: targetTask.data.revision,
        expectedWorkspaceRevision: targetWorkspace.data.revision,
        workerId: null,
      });
      const action = await executeConcreteExternalAction(
        { operation: "git.commit", payload: { message: "must not run during target lease" } },
        target.root,
        undefined,
        undefined,
        undefined,
        undefined,
        { host: "workit_cli", actor: "cli-action" },
        undefined,
        undefined,
        coordinator.root,
      );
      return contractSuccess(null, null, { writer, action });
    });
    expect(leased).toMatchObject({
      ok: true,
      data: {
        writer: { ok: false, code: "writer_conflict" },
        action: { ok: false, code: "writer_conflict", details: { outcome: "not_started" } },
      },
    });
    expect(git(["log", "-1", "--pretty=%s"]).stdout.trim()).toBe("initial");
    expect(git(["status", "--porcelain=v1"]).stdout).toContain("change.txt");
  } finally {
    rmSync(coordinator.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("approved branch-setup base SHA reaches the fetch-time guard", async () => {
  const coordinator = setup();
  const target = mkdtempSync(join(tmpdir(), "workit-approved-base-target-"));
  const remote = mkdtempSync(join(tmpdir(), "workit-approved-base-remote-"));
  const config = mkdtempSync(join(tmpdir(), "workit-approved-base-config-"));
  const previousVcs = process.env.WORKFLOW_VCS_CONFIG;
  const previousToolkitConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(remote, ["init", "-q", "--bare"]);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      git(target, args);
    writeFileSync(join(target, "initial.txt"), "initial\n");
    git(target, ["add", "initial.txt"]);
    git(target, ["commit", "-qm", "initial"]);
    git(target, ["remote", "add", "origin", remote]);
    git(target, ["push", "-q", "-u", "origin", "main"]);
    git(target, ["checkout", "-q", "-b", "develop"]);
    git(target, ["push", "-q", "-u", "origin", "develop"]);
    git(target, ["checkout", "-q", "main"]);
    git(target, ["branch", "-D", "develop"]);
    writeFileSync(
      join(config, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
    );
    writeFileSync(
      join(config, "vcs.json"),
      JSON.stringify({
        provider: "github",
        defaultTargetBranch: "develop",
        github: { host: "github.com" },
      }),
    );
    writeFileSync(join(config, "workspaces.json"), JSON.stringify({ workspaces: [] }));
    process.env.WORKFLOW_TOOLKIT_CONFIG = config;
    process.env.WORKFLOW_VCS_CONFIG = join(config, "vcs.json");

    const resolved = resolveExternalActionRequest(coordinator.root, {
      operation: "git.branch_setup",
      payload: { cwd: target, target_branch: "feature/pinned-base" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const approvedRemoteBase = (
      resolved.data.descriptorPayload as {
        resolved: { remote_base: string };
      }
    ).resolved.remote_base;
    expect(approvedRemoteBase).toMatch(/^[a-f0-9]{40}$/u);

    const task = coordinator.store.readTask(coordinator.task.id);
    const workspace = coordinator.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("coordinator state missing");
    const writer = coordinator.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    });
    if (!writer.ok) throw new Error(writer.error);

    git(target, ["checkout", "-q", "-b", "develop", "origin/develop"]);
    writeFileSync(join(target, "advance.txt"), "advance\n");
    git(target, ["add", "advance.txt"]);
    git(target, ["commit", "-qm", "advance develop"]);
    git(target, ["push", "-q", "origin", "develop"]);
    git(target, ["checkout", "-q", "main"]);

    const result = await executeConcreteExternalAction(
      resolved.data.request,
      target,
      undefined,
      undefined,
      undefined,
      undefined,
      { host: "workit_cli", actor: "cli-action" },
      undefined,
      undefined,
      coordinator.root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      approvedRemoteBase,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("approved remote base changed"),
      details: { outcome: "not_started" },
    });
    expect(git(target, ["branch", "--show-current"]).stdout.trim()).toBe("main");
    expect(git(target, ["show-ref", "--verify", "refs/heads/feature/pinned-base"]).status).not.toBe(
      0,
    );
  } finally {
    if (previousVcs === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousVcs;
    if (previousToolkitConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousToolkitConfig;
    for (const dir of [coordinator.root, target, remote, config])
      rmSync(dir, { recursive: true, force: true });
  }
});

test("local action authority follows the current writer session, not the task creator", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-writer-session-"));
  try {
    const store = new TaskStore(root);
    const creator = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: "creator" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
      nativeAuthority: verifier("creator", "opencode"),
    });
    const started = creator.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    const descriptor = externalActionDescriptor("git.commit", {
      message: "fix(test): resumed",
      resolved: { head: "a", branch: "feature/test", staged: "b", paths: ["x"] },
    });
    const decision = creator.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        purpose: "action",
        binding: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: "approve original action",
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { kind: "decision", actor: "creator" },
    );
    if (!decision.ok) throw new Error(decision.error);
    const approvedTask = store.readTask(task.data.id);
    const approvedWorkspace = store.readWorkspace();
    if (!approvedTask.ok || !approvedWorkspace.ok || !approvedWorkspace.data)
      throw new Error("approval state missing");
    const resumed = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: "resumed-session" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:01Z",
      nativeAuthority: verifier("resumed-session", "opencode"),
    });
    expect(
      resumed.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: approvedTask.data.revision,
        expectedWorkspaceRevision: approvedWorkspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      assertLocalExternalActionWriter(root, { host: "opencode", actor: "resumed-session" }),
    ).toMatchObject({ ok: true });
    expect(
      assertLocalExternalActionWriter(root, { host: "opencode", actor: "creator" }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
    expect(externalActionState(store, "opencode", "resumed-session", descriptor)).toMatchObject({
      ok: true,
    });
    expect(
      await nativeExternalActionRunner(
        root,
        "resumed-session",
        resumed,
      )(descriptor, async () => success(null, null, "executed")),
    ).toMatchObject({ ok: true, data: "executed" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Git reconciliation proves an applied commit and rejects an unapplied one", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-git-reconcile-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    writeFileSync(join(root, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: root });
    const message = "fix(test): reconciled\n\nExact multiline body.";
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.commit",
      payload: { message },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const persisted = approvedResolvedExternalAction(
      externalActionDescriptor("git.commit", resolved.data.descriptorPayload),
    );
    if (!persisted.ok) throw new Error(persisted.error);
    const actionRef = {
      kind: "host" as const,
      host: "workit_cli" as const,
      handle: "local-git-reconcile",
    };
    expect(await readExternalAction(root, persisted.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    spawnSync("git", ["commit", "-qm", message], { cwd: root });
    expect(await readExternalAction(root, persisted.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded" },
    });

    writeFileSync(join(root, "expected.txt"), "expected\n");
    spawnSync("git", ["add", "expected.txt"], { cwd: root });
    const expected = resolveExternalActionRequest(root, {
      operation: "git.commit",
      payload: { message: "fix(test): exact content" },
    });
    if (!expected.ok) throw new Error(expected.error);
    const expectedPersisted = approvedResolvedExternalAction(
      externalActionDescriptor("git.commit", expected.data.descriptorPayload),
    );
    if (!expectedPersisted.ok) throw new Error(expectedPersisted.error);
    spawnSync("git", ["reset", "-q", "expected.txt"], { cwd: root });
    rmSync(join(root, "expected.txt"));
    writeFileSync(join(root, "other.txt"), "other\n");
    spawnSync("git", ["add", "other.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fix(test): exact content"], { cwd: root });
    expect(await readExternalAction(root, expectedPersisted.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Git reconciliation reads the approved push URL, not the fetch URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-push-reconcile-"));
  const firstRemote = mkdtempSync(join(tmpdir(), "workit-push-first-"));
  const secondRemote = mkdtempSync(join(tmpdir(), "workit-push-second-"));
  try {
    for (const remote of [firstRemote, secondRemote])
      spawnSync("git", ["init", "--bare", "-q"], { cwd: remote });
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["switch", "-qc", "feature/push"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", `file://${firstRemote}`], { cwd: root });
    spawnSync("git", ["push", "-qu", "origin", "feature/push"], { cwd: root });
    spawnSync("git", ["remote", "set-url", "--push", "origin", `file://${secondRemote}`], {
      cwd: root,
    });
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.push",
      payload: { branch: "feature/push" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const persisted = approvedResolvedExternalAction(
      externalActionDescriptor("git.push", resolved.data.descriptorPayload),
    );
    if (!persisted.ok) throw new Error(persisted.error);
    expect(
      await readExternalAction(root, persisted.data, {
        kind: "host",
        host: "workit_cli",
        handle: "local-push-reconcile",
      }),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  } finally {
    for (const path of [root, firstRemote, secondRemote])
      rmSync(path, { recursive: true, force: true });
  }
});

test("git.push sends the approved commit even if its branch ref advances at push time", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-push-sha-race-"));
  const remote = mkdtempSync(join(tmpdir(), "workit-push-sha-bare-"));
  const branch = "feature/push-sha";
  const previousPushRoot = process.env.WORKIT_TEST_PUSH_ROOT;
  const previousPushBranch = process.env.WORKIT_TEST_PUSH_BRANCH;
  const previousPushAdvanced = process.env.WORKIT_TEST_PUSH_ADVANCED;
  const git = (cwd: string, args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } });
  try {
    git(remote, ["init", "-q", "--bare"]);
    for (const args of [
      ["init", "-q", "-b", branch],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      git(root, args);
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, ["add", "base.txt"]);
    git(root, ["commit", "-qm", "approved base"]);
    const approved = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    git(root, ["remote", "add", "origin", `file://${remote}`]);
    const store = new TaskStore(root);
    const actor = "push-sha-writer";
    const core = new WorkitCore(store, {
      root,
      caller: { host: "workit_cli", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
      nativeAuthority: verifier(actor),
    });
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("writer setup failed");
    const writer = core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    });
    if (!writer.ok) throw new Error(writer.error);
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.push",
      payload: { branch },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    expect(
      (resolved.data.descriptorPayload as { resolved: { commit: string } }).resolved.commit,
    ).toBe(approved);
    writeFileSync(join(root, "later.txt"), "later\n");
    git(root, ["add", "later.txt"]);
    git(root, ["commit", "-qm", "unapproved later commit"]);
    const advanced = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    git(root, ["update-ref", `refs/heads/${branch}`, approved]);
    writeFileSync(
      join(root, ".git", "hooks", "pre-push"),
      `#!/bin/sh\ncat >/dev/null\ngit -C "$WORKIT_TEST_PUSH_ROOT" update-ref "refs/heads/$WORKIT_TEST_PUSH_BRANCH" "$WORKIT_TEST_PUSH_ADVANCED"\n`,
      { mode: 0o755 },
    );
    process.env.WORKIT_TEST_PUSH_ROOT = root;
    process.env.WORKIT_TEST_PUSH_BRANCH = branch;
    process.env.WORKIT_TEST_PUSH_ADVANCED = advanced;
    try {
      const result = await executeResolvedExternalAction(resolved.data, root, undefined, {
        host: "workit_cli",
        actor,
      });
      expect(result).toMatchObject({ ok: true });
    } finally {
      if (previousPushRoot === undefined) delete process.env.WORKIT_TEST_PUSH_ROOT;
      else process.env.WORKIT_TEST_PUSH_ROOT = previousPushRoot;
      if (previousPushBranch === undefined) delete process.env.WORKIT_TEST_PUSH_BRANCH;
      else process.env.WORKIT_TEST_PUSH_BRANCH = previousPushBranch;
      if (previousPushAdvanced === undefined) delete process.env.WORKIT_TEST_PUSH_ADVANCED;
      else process.env.WORKIT_TEST_PUSH_ADVANCED = previousPushAdvanced;
    }
    expect(git(root, ["rev-parse", `refs/heads/${branch}`]).stdout.trim()).toBe(advanced);
    expect(
      git(root, ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).stdout.trim(),
    ).toBe(approved);
  } finally {
    for (const dir of [root, remote]) rmSync(dir, { recursive: true, force: true });
  }
});

test("local Git reconciliation rejects a changed branch baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-branch-reconcile-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["branch", "feature/baseline"], { cwd: root });
    writeFileSync(join(root, "later.txt"), "later\n");
    spawnSync("git", ["add", "later.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "later"], { cwd: root });
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.branch_setup",
      payload: { target_branch: "feature/baseline" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const persisted = approvedResolvedExternalAction(
      externalActionDescriptor("git.branch_setup", resolved.data.descriptorPayload),
    );
    if (!persisted.ok) throw new Error(persisted.error);
    if (resolved.data.request.operation !== "git.branch_setup") throw new Error("wrong operation");
    spawnSync("git", ["branch", "-f", "feature/baseline", "HEAD"], { cwd: root });
    spawnSync("git", ["switch", "-q", "feature/baseline"], { cwd: root });
    const sdd = resolved.data.request.payload.sdd_dir;
    if (typeof sdd !== "string") throw new Error("missing sdd_dir");
    mkdirSync(sdd, { recursive: true });
    writeFileSync(join(sdd, "manifest.json"), '{"branch":"feature/baseline"}\n');
    expect(
      await readExternalAction(root, persisted.data, {
        kind: "host",
        host: "workit_cli",
        handle: "local-branch-reconcile",
      }),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Git reconciliation proves an exact reapply-stash", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-local-stash-reconcile-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "initial\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "stashed\n");
    spawnSync("git", ["stash", "push", "-qm", "workit test"], { cwd: root });
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs", "manifest.json"),
      JSON.stringify({ branch: "master", stash_ref: "stash@{0}" }),
    );
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.branch_setup",
      payload: { action: "reapply_stash", sdd_dir: "docs" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const persisted = approvedResolvedExternalAction(
      externalActionDescriptor("git.branch_setup", resolved.data.descriptorPayload),
    );
    if (!persisted.ok) throw new Error(persisted.error);
    const actionRef = {
      kind: "host" as const,
      host: "workit_cli" as const,
      handle: "local-stash-reconcile",
    };
    expect(await readExternalAction(root, persisted.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    spawnSync("git", ["stash", "pop", "stash@{0}"], { cwd: root });
    writeFileSync(join(root, "docs", "manifest.json"), JSON.stringify({ branch: "master" }));
    expect(await readExternalAction(root, persisted.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local commit checks writer ownership, not scopes", async () => {
  const roots: string[] = [];
  const setupScoped = (assignedScope: ReturnType<typeof scope>) => {
    const root = mkdtempSync(join(tmpdir(), "workit-local-scope-"));
    roots.push(root);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    const actor = "scoped-writer";
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "workit_cli", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = core.task(
      taskStartRequest({ intent: { ...taskStartRequest().intent, scope: assignedScope } }),
    );
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("scoped task setup failed");
    const writer = core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    });
    if (!writer.ok) throw new Error(writer.error);
    return { root, actor };
  };

  try {
    const narrow = setupScoped(scope({ paths: ["src"] }));
    mkdirSync(join(narrow.root, "src"));
    writeFileSync(join(narrow.root, "src", "allowed.txt"), "allowed\n");
    spawnSync("git", ["add", "src/allowed.txt"], { cwd: narrow.root });
    const allowed = resolveExternalActionRequest(narrow.root, {
      operation: "git.commit",
      payload: { message: "feat(test): allowed scoped commit" },
    });
    if (!allowed.ok) throw new Error(allowed.error);
    expect(
      await executeResolvedExternalAction(allowed.data, narrow.root, undefined, {
        host: "workit_cli",
        actor: narrow.actor,
      }),
    ).toMatchObject({ ok: true });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: narrow.root,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("feat(test): allowed scoped commit");

    writeFileSync(join(narrow.root, "outside.txt"), "outside\n");
    spawnSync("git", ["add", "outside.txt"], { cwd: narrow.root });
    const outside = resolveExternalActionRequest(narrow.root, {
      operation: "git.commit",
      payload: { message: "fix(test): outside scope commits with writer held" },
    });
    if (!outside.ok) throw new Error(outside.error);
    expect(
      await executeResolvedExternalAction(outside.data, narrow.root, undefined, {
        host: "workit_cli",
        actor: narrow.actor,
      }),
    ).toMatchObject({ ok: true });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: narrow.root,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("fix(test): outside scope commits with writer held");

    const other = mkdtempSync(join(tmpdir(), "workit-other-checkout-"));
    roots.push(other);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: other });
    writeFileSync(join(other, "base.txt"), "base\n");
    spawnSync("git", ["add", "base.txt"], { cwd: other });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: other });
    writeFileSync(join(other, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: other });
    const crossRepo = resolveExternalActionRequest(narrow.root, {
      operation: "git.commit",
      payload: { cwd: other, message: "chore(test): commit in another repository" },
    });
    if (!crossRepo.ok) throw new Error(crossRepo.error);
    const resolvedCwd = (crossRepo.data.descriptorPayload as { cwd: string }).cwd;
    expect(statSync(resolvedCwd).dev).toBe(statSync(other).dev);
    expect(statSync(resolvedCwd).ino).toBe(statSync(other).ino);
    expect(
      await executeResolvedExternalAction(crossRepo.data, narrow.root, undefined, {
        host: "workit_cli",
        actor: narrow.actor,
      }),
    ).toMatchObject({ ok: true });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: other,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("chore(test): commit in another repository");

    const excluded = setupScoped(scope({ paths: ["."], exclusions: ["secret"] }));
    mkdirSync(join(excluded.root, "secret"));
    writeFileSync(join(excluded.root, "secret", "blocked.txt"), "blocked\n");
    spawnSync("git", ["add", "secret/blocked.txt"], { cwd: excluded.root });
    const rejected = resolveExternalActionRequest(excluded.root, {
      operation: "git.commit",
      payload: { message: "fix(test): excluded path commits with writer held" },
    });
    if (!rejected.ok) throw new Error(rejected.error);
    expect(
      await executeResolvedExternalAction(rejected.data, excluded.root, undefined, {
        host: "workit_cli",
        actor: excluded.actor,
      }),
    ).toMatchObject({ ok: true });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: excluded.root,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("fix(test): excluded path commits with writer held");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("Git actions without cwd bind the session to its canonical checkout root", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-nested-session-repo-"));
  const session = join(root, "nested", "session");
  try {
    mkdirSync(session, { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "base.txt"), "base\n");
    spawnSync("git", ["add", "base.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
    writeFileSync(join(session, "change.txt"), "change\n");
    spawnSync("git", ["add", "nested/session/change.txt"], { cwd: root });
    const resolved = resolveExternalActionRequest(session, {
      operation: "git.commit",
      payload: { message: "fix(test): nested session target" },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const rootIdentity = statSync(root, { bigint: true });
    for (const candidate of [
      (resolved.data.descriptorPayload as { cwd: string }).cwd,
      (resolved.data.request.payload as { cwd: string }).cwd,
    ]) {
      const actual = statSync(candidate, { bigint: true });
      expect(actual.isDirectory()).toBe(true);
      expect([actual.dev, actual.ino]).toEqual([rootIdentity.dev, rootIdentity.ino]);
    }
    expect(
      (resolved.data.descriptorPayload as { resolved: { paths: string[] } }).resolved.paths,
    ).toContain("nested/session/change.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

t("hosted create binds PR head; babysitting stays opt-in", async () => {
  const coordinator = setup();
  const remote = mkdtempSync(join(tmpdir(), "workit-pr-head-bare-"));
  const config = mkdtempSync(join(tmpdir(), "workit-pr-head-config-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-pr-head-tools-"));
  const previousPath = process.env.PATH;
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  const previousToolkitConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousBareRemote = process.env.WORKIT_TEST_BARE_REMOTE;
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: coordinator.root, encoding: "utf8", env: { ...process.env } });
  try {
    spawnSync("git", ["init", "-q", "--bare"], { cwd: remote });
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      git(args);
    writeFileSync(join(coordinator.root, "base.txt"), "base\n");
    git(["add", "base.txt"]);
    git(["commit", "-qm", "base"]);
    git(["branch", "feature/pr-head"]);
    git(["switch", "-q", "feature/pr-head"]);
    writeFileSync(join(coordinator.root, "feature.txt"), "feature\n");
    git(["add", "feature.txt"]);
    git(["commit", "-qm", "feature"]);
    git(["remote", "add", "origin", `git@github.com:org/repo.git`]);
    const sshShim = join(tools, "ssh-push.cjs");
    writeFileSync(
      sshShim,
      `const { spawn } = require("node:child_process");
const service = process.argv.some((arg) => arg.includes("upload-pack")) ? "upload-pack" : "receive-pack";
const server = spawn("git", [service, process.env.WORKIT_TEST_BARE_REMOTE], { stdio: "inherit" });
server.on("error", () => process.exit(1));
server.on("exit", (code) => process.exit(code ?? 1));
`,
    );
    const shellPath = (value: string) => value.replaceAll("\\", "/");
    process.env.GIT_SSH_COMMAND = `"${shellPath(process.execPath)}" "${shellPath(sshShim)}"`;
    process.env.WORKIT_TEST_BARE_REMOTE = remote;
    process.env.PATH = `${tools}${delimiter}${previousPath ?? ""}`;
    for (const ref of ["main", "feature/pr-head"]) git(["push", "-q", "origin", ref]);
    writeFileSync(join(tools, "ssh"), '#!/bin/sh\necho "hostname github.com"\n', { mode: 0o755 });
    writeFileSync(join(tools, "ssh.cmd"), "@echo off\r\necho hostname github.com\r\n");
    const wrongHead = "f".repeat(40);
    const reply = join(tools, "pulls.json");
    const log = join(tools, "gh.log");
    writeFileSync(
      join(tools, "gh"),
      `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"stub"}'; exit 0; fi\nif [ "$1" = api ]; then cat "${reply}"; exit 0; fi\necho "$*" >> "${log}"\necho 'https://github.com/org/repo/pull/55'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tools, "gh.cmd"),
      `@echo off\r\nif "%1 %2"=="api user" (echo {"login":"stub"} & exit /b 0)\r\nif "%1"=="api" (type "${reply}" & exit /b 0)\r\n>>"${log}" echo %*\r\necho https://github.com/org/repo/pull/55\r\n`,
    );
    writeFileSync(
      join(config, "vcs.json"),
      JSON.stringify({
        provider: "github",
        github: { host: "github.com" },
        pr: { pushBranch: false },
      }),
    );
    writeFileSync(
      join(config, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "target",
            glob: `${coordinator.root}/**`,
            vcs: { provider: "github", account: "stub" },
          },
        ],
      }),
    );
    process.env.WORKFLOW_VCS_CONFIG = join(config, "vcs.json");
    process.env.WORKFLOW_TOOLKIT_CONFIG = config;
    const writer = coordinator.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: coordinator.task.id,
      expectedRevision: coordinator.task.revision,
      expectedWorkspaceRevision: coordinator.workspace.revision,
      workerId: null,
    });
    if (!writer.ok) throw new Error(writer.error);
    const request = {
      operation: "hosting.pull_request" as const,
      payload: { title: "T", body: "body", target_branch: "main" },
    };
    writeFileSync(log, "");
    const resolved = resolveExternalActionRequest(coordinator.root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    const source = resolved.data.descriptorPayload as {
      resolved: { source_commit: string };
    };
    const setReply = (sha: string) =>
      writeFileSync(
        reply,
        JSON.stringify([
          {
            number: 55,
            body: resolved.data.marker,
            base: { ref: "main" },
            head: { ref: "feature/pr-head", sha },
          },
        ]),
      );
    const caller = { host: "workit_cli" as const, actor: "cli-action" };
    setReply(wrongHead);
    expect(
      await executeResolvedExternalAction(resolved.data, coordinator.root, undefined, caller),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
    expect(readFileSync(log, "utf8")).toContain("pr create");
    writeFileSync(log, "");
    setReply(source.resolved.source_commit);
    const created = await executeResolvedExternalAction(
      resolved.data,
      coordinator.root,
      undefined,
      caller,
    );
    expect(created).toMatchObject({ ok: true, data: { provider: "github" } });
    if (!created.ok) return;
    expect(created.data).not.toHaveProperty("next");
    expect(created.data).not.toHaveProperty("babysitSkill");
    expect(created.data).not.toHaveProperty("babysit");
    expect(readFileSync(log, "utf8")).toContain("pr create");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
    if (previousToolkitConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousToolkitConfig;
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousBareRemote === undefined) delete process.env.WORKIT_TEST_BARE_REMOTE;
    else process.env.WORKIT_TEST_BARE_REMOTE = previousBareRemote;
    for (const dir of [coordinator.root, remote, config, tools])
      rmSync(dir, { recursive: true, force: true });
  }
});

t("branch deletion binds live tip to merged PR head", async () => {
  const coordinator = setup();
  const repo = mkdtempSync(join(tmpdir(), "workit-delete-repo-"));
  const remote = mkdtempSync(join(tmpdir(), "workit-delete-bare-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-delete-tools-"));
  const previousPath = process.env.PATH;
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  const previousToolkitConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousBareRemote = process.env.WORKIT_TEST_BARE_REMOTE;
  const previousRaceFile = process.env.WORKIT_TEST_RACE_FILE;
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(remote, ["init", "-q", "--bare"]);
    for (const args of [
      ["init", "-q", "-b", "feature/merged"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      git(repo, args);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-qm", "base"]);
    const tip = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "origin", "feature/merged"]);
    git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:org/repo.git"]);
    const reply = join(tools, "merged.json");
    writeFileSync(
      reply,
      JSON.stringify([
        {
          number: 123,
          merged_at: "2026-01-01T00:00:00Z",
          head: { ref: "feature/merged", sha: tip },
        },
      ]),
    );
    const config = join(tools, "vcs.json");
    writeFileSync(config, JSON.stringify({ provider: "github", github: { host: "github.com" } }));
    const branchReply = join(tools, "branch.json");
    const visibility = join(tools, "visible");
    writeFileSync(visibility, "yes");
    const writeBranchReply = (sha: string) =>
      writeFileSync(branchReply, JSON.stringify({ object: { sha } }));
    writeBranchReply(tip);
    process.env.WORKFLOW_VCS_CONFIG = config;
    process.env.WORKFLOW_TOOLKIT_CONFIG = tools;
    const raceFile = join(tools, "race.txt");
    const sshShim = join(tools, "ssh.cjs");
    writeFileSync(
      sshShim,
      `const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const remote = process.env.WORKIT_TEST_BARE_REMOTE;
const race = process.env.WORKIT_TEST_RACE_FILE;
if (fs.existsSync(race)) {
  const tip = fs.readFileSync(race, "utf8").trim();
  const changed = spawnSync("git", ["--git-dir", remote, "update-ref", "refs/heads/feature/merged", tip]);
  fs.unlinkSync(race);
  if (changed.status !== 0) process.exit(1);
}
const server = spawn("git", ["receive-pack", remote], { stdio: "inherit" });
server.on("error", () => process.exit(1));
server.on("exit", (code) => process.exit(code ?? 1));
`,
    );
    process.env.WORKIT_TEST_BARE_REMOTE = remote;
    process.env.WORKIT_TEST_RACE_FILE = raceFile;
    writeFileSync(join(tools, "ssh"), "#!/bin/sh\necho 'hostname github.com'\n", { mode: 0o755 });
    writeFileSync(join(tools, "ssh.cmd"), "@echo off\r\necho hostname github.com\r\n");
    const shellPath = (value: string) => value.replaceAll("\\", "/");
    process.env.GIT_SSH_COMMAND = `"${shellPath(process.execPath)}" "${shellPath(sshShim)}"`;
    writeFileSync(
      join(tools, "gh"),
      `#!/bin/sh\nif [ "$2" = user ]; then echo '{"login":"stub"}'; exit 0; fi\nif [ "$2" = repos/org/repo/git/ref/heads/feature/merged ]; then if [ "$(cat "${branchReply}")" = 404 ]; then echo 'HTTP 404' >&2; exit 1; fi; cat "${branchReply}"; exit 0; fi\nif [ "$2" = repos/org/repo ]; then if [ ! -f "${visibility}" ]; then echo 'HTTP 404' >&2; exit 1; fi; echo '{"id":7}'; exit 0; fi\ncat "${reply}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tools, "gh.cmd"),
      `@echo off\r\nif "%2"=="user" (echo {"login":"stub"} & exit /b 0)\r\nif "%2"=="repos/org/repo/git/ref/heads/feature/merged" (\r\nfindstr /x /c:"404" "${branchReply}" >nul && (echo HTTP 404 1>&2 & exit /b 1)\r\ntype "${branchReply}"\r\nexit /b 0\r\n)\r\nif "%2"=="repos/org/repo" (\r\nif not exist "${visibility}" (echo HTTP 404 1>&2 & exit /b 1)\r\necho {"id":7}\r\nexit /b 0\r\n)\r\ntype "${reply}"\r\nexit /b 0\r\n`,
    );
    process.env.PATH = `${tools}${delimiter}${previousPath ?? ""}`;
    const writer = coordinator.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: coordinator.task.id,
      expectedRevision: coordinator.task.revision,
      expectedWorkspaceRevision: coordinator.workspace.revision,
      workerId: null,
    });
    if (!writer.ok) throw new Error(writer.error);
    const request = {
      operation: "hosting.delete_branch" as const,
      payload: { cwd: repo, branch: "feature/merged" },
    };
    const workspaces = join(tools, "workspaces.json");
    const account = (login: string) =>
      writeFileSync(
        workspaces,
        JSON.stringify({
          workspaces: [
            { name: "target", glob: `${repo}/**`, vcs: { provider: "github", account: login } },
          ],
        }),
      );
    account("wrong-account");
    expect(resolveExternalActionRequest(coordinator.root, request).ok).toBe(false);
    account("stub");
    const resolved = resolveExternalActionRequest(coordinator.root, request);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.data.descriptorPayload).toMatchObject({
      cwd: repo,
      resolved: { tip, pr: "123", account: "stub", apiHost: "github.com" },
    });
    const proposal = actionProposalQuestion(request, resolved.data.descriptorPayload);
    expect(proposal.presented).toContain("ssh://git@github.com/org/repo.git");
    expect(proposal.presented).toContain("via `github.com`");
    expect(proposal.presented).toContain("as `stub`");
    git(repo, ["commit", "--allow-empty", "-qm", "changed"]);
    const changed = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    git(repo, ["push", "-q", remote, "HEAD:refs/heads/feature/merged"]);
    writeBranchReply(changed);
    const caller = { host: "workit_cli" as const, actor: "cli-action" };
    expect(
      await executeResolvedExternalAction(resolved.data, coordinator.root, undefined, caller),
    ).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(git(repo, ["ls-remote", "origin", "refs/heads/feature/merged"]).stdout.trim()).toContain(
      changed,
    );
    git(remote, ["update-ref", "refs/heads/feature/merged", tip]);
    writeBranchReply(tip);
    writeFileSync(raceFile, changed);
    expect(
      await executeResolvedExternalAction(resolved.data, coordinator.root, undefined, caller),
    ).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(git(repo, ["ls-remote", "origin", "refs/heads/feature/merged"]).stdout.trim()).toContain(
      changed,
    );
    git(remote, ["update-ref", "refs/heads/feature/merged", tip]);
    expect(
      await executeResolvedExternalAction(resolved.data, coordinator.root, undefined, caller),
    ).toMatchObject({ ok: true });
    expect(git(repo, ["ls-remote", "origin", "refs/heads/feature/merged"]).stdout.trim()).toBe("");
    writeFileSync(branchReply, "404");
    rmSync(visibility);
    expect(
      await readExternalAction(coordinator.root, resolved.data, {
        kind: "host",
        host: "workit_cli",
        handle: "hidden",
      }),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
    writeFileSync(visibility, "yes");
    expect(
      await readExternalAction(coordinator.root, resolved.data, {
        kind: "host",
        host: "workit_cli",
        handle: "delete",
      }),
    ).toMatchObject({ ok: true, data: { outcome: "succeeded" } });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
    if (previousToolkitConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousToolkitConfig;
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousBareRemote === undefined) delete process.env.WORKIT_TEST_BARE_REMOTE;
    else process.env.WORKIT_TEST_BARE_REMOTE = previousBareRemote;
    if (previousRaceFile === undefined) delete process.env.WORKIT_TEST_RACE_FILE;
    else process.env.WORKIT_TEST_RACE_FILE = previousRaceFile;
    for (const dir of [coordinator.root, repo, remote, tools])
      rmSync(dir, { recursive: true, force: true });
  }
});

t("merge reconciliation consumes one exact provider result", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-hosting-read-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-hosting-tools-"));
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  const previousPath = process.env.PATH;
  const reply = join(tools, "reply.json");
  const queryLog = join(tools, "queries.log");
  writeFileSync(reply, "[]");
  writeFileSync(queryLog, "");
  for (const name of ["gh", "glab"]) {
    writeFileSync(
      join(tools, name),
      `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"stub","username":"stub"}'; exit 0; fi\necho x >> "${queryLog}"\ncat "${reply}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tools, `${name}.cmd`),
      `@echo off\r\nif "%1 %2"=="api user" (echo {"login":"stub","username":"stub"} & exit /b 0)\r\n>>"${queryLog}" echo x\r\ntype "${reply}"\r\n`,
    );
  }
  process.env.PATH = `${tools}${delimiter}${previousPath ?? ""}`;
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    const baseBranch = spawnSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    spawnSync("git", ["checkout", "-qb", "feature/reconcile"], { cwd: root });
    writeFileSync(join(root, "feature.txt"), "feature\n");
    spawnSync("git", ["add", "feature.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "feature"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], {
      cwd: root,
    });
    const tokenPath = join(root, "token");
    const configPath = join(root, "vcs.json");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "github", github: { tokenFile: tokenPath } }),
    );
    process.env.WORKFLOW_VCS_CONFIG = configPath;
    const create = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main" },
    });
    // Decision ae03c569: hosted create is enabled with pre/post provider SHA
    // verification; the residual non-atomic source-SHA race is accepted.
    expect(create).toMatchObject({ ok: true });
    if (create.ok)
      expect(create.data.descriptorPayload).toMatchObject({
        resolved: { source_branch: "feature/reconcile", target_branch: "main" },
      });
    const merge = resolveExternalActionRequest(root, {
      operation: "hosting.merge",
      payload: { source_branch: "feature/reconcile", target_branch: "main" },
    });
    expect(merge).toMatchObject({ ok: true });
    if (!merge.ok) return;
    const actionRef = {
      kind: "host" as const,
      host: "workit_cli" as const,
      handle: "original-action",
    };
    const source = merge.data.descriptorPayload as {
      target_branch: string;
      resolved: { source_branch: string; source_commit: string; marker: string };
    };
    const setReply = (records: unknown[]) => writeFileSync(reply, JSON.stringify(records));
    const record = {
      number: 42,
      body: source.resolved.marker,
      base: { ref: source.target_branch },
      head: { ref: source.resolved.source_branch, sha: source.resolved.source_commit },
    };
    setReply([{ ...record, body: "", merged_at: "2026-01-01T00:00:00Z" }]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", data: { provider: "github", id: 42 } },
    });
    setReply([
      { ...record, body: "", merged_at: "2026-01-01T00:00:00Z" },
      {
        ...record,
        number: 43,
        body: "",
        merged_at: null,
        head: { ref: source.resolved.source_branch, sha: "f".repeat(40) },
      },
    ]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    spawnSync("git", ["checkout", "-q", baseBranch], { cwd: root });
    const explicitSource = resolveExternalActionRequest(root, {
      operation: "hosting.merge",
      payload: { source_branch: "feature/reconcile", target_branch: "main" },
    });
    expect(explicitSource).toMatchObject({ ok: true });
    if (explicitSource.ok)
      expect(
        (explicitSource.data.descriptorPayload as { resolved: { source_commit: string } }).resolved
          .source_commit,
      ).toBe(source.resolved.source_commit);
    spawnSync("git", ["checkout", "-q", "feature/reconcile"], { cwd: root });
    setReply([{ ...record, body: "", merged_at: null }]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    setReply([null]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    setReply([{ ...record, base: null }]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    setReply(Array.from({ length: 100 }, () => record));
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    const queriedBeforeHostChange = readFileSync(queryLog, "utf8");
    spawnSync("git", ["remote", "set-url", "origin", "https://evil.example/org/repo.git"], {
      cwd: root,
    });
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    expect(readFileSync(queryLog, "utf8")).toBe(queriedBeforeHostChange);
    spawnSync("git", ["remote", "set-url", "origin", "https://github.com/org/repo.git"], {
      cwd: root,
    });
    setReply([]);
    expect(await readExternalAction(root, merge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    spawnSync("git", ["remote", "set-url", "origin", "https://gitlab.com/group/repo.git"], {
      cwd: root,
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "gitlab",
        gitlab: { tokenFile: tokenPath, apiUrl: "https://gitlab.com/api/v4" },
      }),
    );
    const gitlabMerge = resolveExternalActionRequest(root, {
      operation: "hosting.merge",
      payload: { source_branch: "feature/reconcile", target_branch: "main" },
    });
    expect(gitlabMerge).toMatchObject({ ok: true });
    if (!gitlabMerge.ok) return;
    const gitlabSource = gitlabMerge.data.descriptorPayload as {
      target_branch: string;
      resolved: { source_branch: string; source_commit: string; marker: string };
    };
    const glRecord = {
      iid: 7,
      state: "merged",
      description: gitlabSource.resolved.marker,
      target_branch: gitlabSource.target_branch,
      source_branch: gitlabSource.resolved.source_branch,
      sha: gitlabSource.resolved.source_commit,
    };
    setReply([{ ...glRecord, sha: undefined, head: { sha: glRecord.sha } }]);
    expect(await readExternalAction(root, gitlabMerge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    setReply([glRecord]);
    expect(await readExternalAction(root, gitlabMerge.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", data: { provider: "gitlab", id: 7 } },
    });
    setReply([{ ...glRecord, description: "", state: "merged" }]);
    expect(await readExternalAction(root, gitlabMerge.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", data: { provider: "gitlab", id: 7 } },
    });
    setReply([
      { ...glRecord, state: "merged" },
      { ...glRecord, iid: 8, state: "opened", sha: "f".repeat(40) },
    ]);
    expect(await readExternalAction(root, gitlabMerge.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
    rmSync(tools, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("YouTrack reconciliation matches the approved comment and work item without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-youtrack-read-"));
  const configPath = join(root, "youtrack.json");
  const tokenPath = join(root, "youtrack.token");
  const previousConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
  const previousWrite = process.env.WORKFLOW_YT_WRITE;
  const previousFetch = globalThis.fetch;
  try {
    writeFileSync(tokenPath, "test-token\n");
    chmodSync(tokenPath, 0o600);
    writeFileSync(
      configPath,
      JSON.stringify({ baseUrl: "https://yt.example", tokenFile: tokenPath, timezone: "UTC" }),
    );
    process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
    process.env.WORKFLOW_YT_WRITE = "1";
    const resolved = resolveExternalActionRequest(root, {
      operation: "youtrack.update",
      payload: { issueId: "ABC-1", markdown: "Approved update", minutes: 30 },
    });
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const actionRef = {
      kind: "host" as const,
      host: "workit_cli" as const,
      handle: "youtrack-action",
    };
    const details = (
      resolved.data.descriptorPayload as {
        resolved: { commentText: string; workText: string; dateMs: number };
      }
    ).resolved;
    let ambiguous = false;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain("$top=100");
      return {
        ok: true,
        text: async () =>
          ambiguous
            ? "[]"
            : url.includes("comments")
              ? JSON.stringify([
                  {
                    id: "comment-1",
                    text: details.commentText,
                    deleted: false,
                    created: details.dateMs,
                  },
                ])
              : JSON.stringify([
                  {
                    id: "work-1",
                    text: details.workText,
                    duration: { minutes: 30 },
                    date: details.dateMs,
                  },
                ]),
      };
    }) as unknown as typeof fetch;
    const found = await readYouTrackAction(root, resolved.data, actionRef);
    expect(found).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", data: { provider: "youtrack", id: "comment-1" } },
    });
    ambiguous = true;
    expect(await readYouTrackAction(root, resolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previousConfig;
    if (previousWrite === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previousWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation requires distinct native provider evidence and is single-use", async () => {
  const setupState = setup();
  try {
    const first = await runAuthorizedExternalAction(inputFor(setupState), async () => {
      throw new Error("provider unavailable");
    });
    expect(first).toMatchObject({ ok: false, code: "external_outcome_unknown" });
    const task = setupState.store.readTask(setupState.task.id);
    const workspace = setupState.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const input = inputFor(setupState);
    const evidenceDigest = "a".repeat(64) as never;
    expect(
      setupState.core.reconcileAction({
        taskId: input.taskId,
        decisionId: input.decisionId,
        actionRef: input.actionRef,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        outcome: "succeeded",
        evidenceDigest,
        observation: { actionRef: input.actionRef, outcome: "succeeded", providerRead: true },
      }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
    expect(
      setupState.core.reconcileAction({
        taskId: input.taskId,
        decisionId: input.decisionId,
        actionRef: { kind: "host", host: "workit_cli", handle: "wrong-ref" },
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        outcome: "succeeded",
        evidenceDigest,
        observation: {
          kind: "provider_read",
          actionRef: { kind: "host", host: "workit_cli", handle: "wrong-ref" },
          outcome: "succeeded",
          evidenceDigest,
        },
      }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
    const reconciled = setupState.core.reconcileAction({
      taskId: input.taskId,
      decisionId: input.decisionId,
      actionRef: input.actionRef,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      outcome: "succeeded",
      evidenceDigest,
      observation: {
        kind: "provider_read",
        actionRef: input.actionRef,
        outcome: "succeeded",
        evidenceDigest,
      },
    });
    expect(reconciled).toMatchObject({
      ok: true,
      data: { data: { consumption: { state: "consumed" } } },
    });
    const freshTask = setupState.store.readTask(setupState.task.id);
    const freshWorkspace = setupState.store.readWorkspace();
    if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data)
      throw new Error("state missing");
    expect(
      setupState.core.reconcileAction({
        taskId: input.taskId,
        decisionId: input.decisionId,
        actionRef: input.actionRef,
        expectedRevision: freshTask.data.revision,
        expectedWorkspaceRevision: freshWorkspace.data.revision,
        outcome: "succeeded",
        evidenceDigest,
        observation: {
          kind: "provider_read",
          actionRef: input.actionRef,
          outcome: "succeeded",
          evidenceDigest,
        },
      }),
    ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("missing optional capability and mismatched authority refuse before the effect", async () => {
  const setupState = setup();
  try {
    let effects = 0;
    expect(
      await runAuthorizedExternalAction(
        { ...inputFor(setupState), capability: "github_pull_request", available: false },
        async () => {
          effects += 1;
          return "unreachable";
        },
      ),
    ).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(effects).toBe(0);
    expect(
      await runAuthorizedExternalAction(
        {
          ...inputFor(setupState),
          reserveObservation: {
            actionRef: { kind: "host", host: "workit_cli", handle: "other" },
            outcome: "reserve",
          },
        },
        async () => "unreachable",
      ),
    ).toMatchObject({ ok: false, code: "permission_denied" });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("a concrete failure result is settled conservatively unless preflight proves no write", async () => {
  const setupState = setup();
  try {
    const result = await runAuthorizedExternalAction(inputFor(setupState), async () => ({
      ok: false as const,
      schemaVersion: 1 as const,
      code: "invalid_input" as const,
      error: "remote input rejected",
      details: {},
    }));
    expect(result).toMatchObject({ ok: false, code: "external_outcome_unknown" });
    const task = setupState.store.readTask(setupState.task.id);
    expect(task).toMatchObject({
      ok: true,
      data: { decisions: [{ data: { consumption: { state: "uncertain" } } }] },
    });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("an explicitly preflight-classified failure releases the reservation", async () => {
  const setupState = setup();
  try {
    const result = await runAuthorizedExternalAction(
      { ...inputFor(setupState), failureOutcome: "not_started" },
      async () => ({
        ok: false as const,
        schemaVersion: 1 as const,
        code: "invalid_input" as const,
        error: "preflight rejected",
        details: {},
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(setupState.store.readTask(setupState.task.id)).toMatchObject({
      ok: true,
      data: { decisions: [{ data: { consumption: null } }] },
    });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("a preflight failure does not hide a failed reservation release", async () => {
  const setupState = setup();
  try {
    const result = await runAuthorizedExternalAction(
      {
        ...inputFor(setupState),
        failureOutcome: "not_started",
        refresh: () => {
          throw new Error("state unavailable");
        },
      },
      async () => {
        const current = setupState.store.readTask(setupState.task.id);
        if (!current.ok) throw new Error(current.error);
        const changed = setupState.store.mutateTask(
          setupState.task.id,
          current.data.revision,
          (task, mutation) =>
            contractSuccess(mutation.revision, null, {
              ...task,
              progress: { ...task.progress, summary: "concurrent progress" },
            }),
        );
        if (!changed.ok) throw new Error(changed.error);
        return {
          ok: false as const,
          schemaVersion: 1 as const,
          code: "invalid_input" as const,
          error: "preflight rejected",
          details: {},
        };
      },
    );
    expect(result).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("settlement refreshes exact revisions after unrelated task progress", async () => {
  const setupState = setup();
  try {
    const result = await runAuthorizedExternalAction(
      {
        ...inputFor(setupState),
        refresh: () => {
          const task = setupState.store.readTask(setupState.task.id);
          const workspace = setupState.store.readWorkspace();
          if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
          return {
            expectedRevision: task.data.revision,
            expectedWorkspaceRevision: workspace.data.revision,
          };
        },
      },
      async () => {
        const current = setupState.store.readTask(setupState.task.id);
        if (!current.ok) throw new Error(current.error);
        const changed = setupState.store.mutateTask(
          setupState.task.id,
          current.data.revision,
          (task, mutation) =>
            contractSuccess(mutation.revision, null, {
              ...task,
              progress: { ...task.progress, summary: "unrelated progress" },
            }),
        );
        if (!changed.ok) throw new Error(changed.error);
        return "settled after refresh";
      },
    );
    expect(result).toMatchObject({ ok: true, data: "settled after refresh" });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
  }
});

test("native host action binding requires the exact canonical target and payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-external-host-binding-"));
  try {
    const actor = "opencode-session";
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
      nativeAuthority: verifier(actor, "opencode"),
    });
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("host binding setup failed");
    const descriptor = externalActionDescriptor("git.commit", { message: "approved" });
    const decision = core.observeDecision(
      {
        schemaVersion: 1,
        action: "record",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        purpose: "action",
        binding: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          scope: task.data.intent.data.scope,
          presented: "Approve one commit",
          approvedContent: descriptor,
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { kind: "decision", actor },
    );
    if (!decision.ok) throw new Error(decision.error);
    const runner = nativeExternalActionRunner(root, actor, core);
    let effects = 0;
    expect(
      await runner(externalActionDescriptor("git.commit", { message: "different" }), async () => {
        effects += 1;
        return "must not run";
      }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
    expect(effects).toBe(0);
    expect(
      await runner(descriptor, async () => {
        effects += 1;
        return "committed";
      }),
    ).toMatchObject({ ok: true, data: "committed" });
    expect(effects).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted PR create preserves the optional babysit preference without opting in by default", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pr-babysit-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-pr-babysit-tools-"));
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  const previousPath = process.env.PATH;
  try {
    // Decision ae03c569 re-enabled hosted PR/MR creation with pre/post provider
    // SHA verification (the residual non-atomic source-SHA race is accepted).
    // The gh/glab stubs keep identity resolution deterministic and offline.
    for (const name of ["gh", "glab"]) {
      writeFileSync(
        join(tools, name),
        `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"stub","username":"stub"}'; exit 0; fi\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(tools, `${name}.cmd`),
        `@echo off\r\nif "%1 %2"=="api user" (echo {"login":"stub","username":"stub"} & exit /b 0)\r\nexit /b 1\r\n`,
      );
    }
    process.env.PATH = `${tools}${delimiter}${previousPath ?? ""}`;
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["checkout", "-qb", "feature/babysit"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], { cwd: root });
    const tokenPath = join(root, "token");
    const configPath = join(root, "vcs.json");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "github", github: { tokenFile: tokenPath } }),
    );
    process.env.WORKFLOW_VCS_CONFIG = configPath;
    const auto = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main" },
    });
    expect(auto).toMatchObject({ ok: true });
    if (!auto.ok) return;
    expect(auto.data.descriptorPayload).toMatchObject({
      resolved: { source_branch: "feature/babysit", target_branch: "main" },
    });
    expect(auto.data.descriptorPayload).not.toHaveProperty("babysit");
    const optedIn = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main", babysit: true },
    });
    expect(optedIn).toMatchObject({ ok: true });
    if (!optedIn.ok) return;
    expect(optedIn.data.descriptorPayload).toMatchObject({ babysit: true });
    const declined = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main", babysit: false },
    });
    expect(declined).toMatchObject({ ok: true });
    if (!declined.ok) return;
    expect(declined.data.descriptorPayload).toMatchObject({ babysit: false });
  } finally {
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

const assessedGateSetup = () => {
  const state = setup();
  const assessed = state.core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: state.task.id,
    expectedRevision: state.task.revision,
    assessment: assessment({
      signals: {
        ...assessment().signals,
        behaviorChange: { value: true, basis: "inferred", reason: "gate fixture", refs: [] },
        mechanicalLowRisk: { value: false, basis: "inferred", reason: "gate fixture", refs: [] },
      },
    }),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const current = state.store.readTask(state.task.id);
  if (!current.ok || !current.data.policy) throw new Error("assessed task missing policy");
  const requirementId = current.data.policy.requirements.find(
    (requirement) => requirement.ruleId === "pre-pr-cleanup",
  )?.id;
  if (!requirementId) throw new Error("pre-pr-cleanup requirement missing");
  return { ...state, task: current.data, requirementId };
};

const recordGateDecision = (
  state: ReturnType<typeof assessedGateSetup>,
  purpose: "action" | "limitation",
  approvedContent: string,
  requirementIds: string[],
) => {
  const workspace = state.store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const recorded = state.core.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId: state.task.id,
      expectedRevision: state.task.revision,
      purpose,
      binding: {
        taskId: state.task.id,
        workspaceId: workspace.data.id,
        scope: state.task.intent.data.scope,
        presented: purpose === "action" ? "open the pull request" : "waive deslop",
        approvedContent,
        contentRefs: [],
      },
      response: "approved",
      requirementIds,
    },
    { kind: "decision", actor: "cli-action" },
  );
  if (!recorded.ok) throw new Error(recorded.error);
  const current = state.store.readTask(state.task.id);
  if (!current.ok) throw new Error(current.error);
  state.task = current.data;
  return recorded.data;
};

test("pull request reservation is gated by pre-pr-cleanup evidence", async () => {
  const state = assessedGateSetup();
  try {
    const decision = recordGateDecision(
      state,
      "action",
      externalActionDescriptor("hosting.pull_request", { title: "Gate" }),
      [],
    );
    let effects = 0;
    const denied = await runAuthorizedExternalAction(
      { ...inputFor(state), decisionId: decision.id },
      async () => {
        effects += 1;
        return "pr";
      },
    );
    expect(denied).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
    expect(effects).toBe(0);

    const recorded = state.core.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: state.task.id,
      expectedRevision: state.task.revision,
      evidence: {
        kind: "check",
        claim: "deslop pass",
        requirementIds: [state.requirementId],
        beforeCandidateId: null,
        candidateId: null,
        result: "passed",
        summary: "no slop found",
        refs: [],
        exitCode: 0,
        reviewContext: null,
      },
    });
    expect(recorded.ok).toBe(true);

    const current = state.store.readTask(state.task.id);
    const workspace = state.store.readWorkspace();
    if (!current.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const allowed = await runAuthorizedExternalAction(
      {
        ...inputFor(state),
        decisionId: decision.id,
        expectedRevision: current.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
      },
      async () => {
        effects += 1;
        return "pr";
      },
    );
    expect(allowed).toMatchObject({ ok: true, data: "pr" });
    expect(effects).toBe(1);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("pull request reservation accepts an approved limitation waiver", async () => {
  const state = assessedGateSetup();
  try {
    const decision = recordGateDecision(
      state,
      "action",
      externalActionDescriptor("hosting.pull_request", { title: "Gate" }),
      [],
    );
    recordGateDecision(state, "limitation", "waive deslop cleanup for this change", [
      state.requirementId,
    ]);
    const allowed = await runAuthorizedExternalAction(
      { ...inputFor(state), decisionId: decision.id },
      async () => "pr",
    );
    expect(allowed).toMatchObject({ ok: true, data: "pr" });
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
