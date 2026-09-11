import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  externalActionDescriptor,
  success,
  type NativeAuthorityVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import type { Provenance } from "@/packages/workit-core/src/core/task-contract";
import { success as contractSuccess } from "@/packages/workit-core/src/core/task-contract";
import {
  priorExternalAction,
  runAuthorizedExternalAction,
} from "@/packages/workit-core/src/core/external-action";
import {
  executeResolvedExternalAction,
  readHostingAction,
  readYouTrackAction,
  resolveExternalActionRequest,
} from "@/packages/workit-core/src/core/external-action-effects";
import { nativeExternalActionRunner } from "@/packages/workit-opencode/src/tools/workit";
import { scope, taskStartRequest } from "./task-fixtures";

const provenance = (actor: string, host: Provenance["host"] = "workit_cli"): Provenance => ({
  kind: "host_observed",
  host,
  session: { kind: "host", host, handle: actor },
  workerId: null,
  receipts: [{ kind: "host", host, handle: `receipt:${actor}` }],
});

const verifier = (
  actor: string,
  host: Provenance["host"] = "workit_cli",
): NativeAuthorityVerifier => ({
  verifyDecision: () => success(null, null, provenance(actor, host)),
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

test("one authorized external workflow reserves and settles without another prompt", async () => {
  const setupState = setup();
  try {
    let effects = 0;
    const result = await runAuthorizedExternalAction(inputFor(setupState), async () => {
      effects += 1;
      return { remoteId: "pr-1" };
    });
    expect(result).toMatchObject({ ok: true, data: { remoteId: "pr-1" } });
    expect(effects).toBe(1);
    const task = setupState.store.readTask(setupState.task.id);
    expect(task).toMatchObject({
      ok: true,
      data: { decisions: [{ data: { consumption: { state: "consumed" } } }] },
    });
  } finally {
    rmSync(setupState.root, { recursive: true, force: true });
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
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://user:secret@example.com/org/repo.git"], {
      cwd: root,
    });
    spawnSync(
      "git",
      [
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://push-user:push-secret@example.com/org/push.git",
      ],
      { cwd: root },
    );
    const resolved = resolveExternalActionRequest(root, { operation: "git.push", payload: {} });
    expect(resolved).toMatchObject({ ok: true });
    if (resolved.ok) {
      const descriptor = JSON.stringify(resolved.data.descriptorPayload);
      expect(descriptor).not.toContain("secret");
      expect(descriptor).not.toContain("user@");
      expect(descriptor).toContain("example.com/org/push.git");
      expect(descriptor).not.toContain("push-secret");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("local commit guards every staged path against the existing writer scope", async () => {
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
      payload: { message: "fix(test): must reject outside scope" },
    });
    if (!outside.ok) throw new Error(outside.error);
    expect(
      await executeResolvedExternalAction(outside.data, narrow.root, undefined, {
        host: "workit_cli",
        actor: narrow.actor,
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { outcome: "not_started" },
    });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: narrow.root,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("feat(test): allowed scoped commit");

    const excluded = setupScoped(scope({ paths: ["."], exclusions: ["secret"] }));
    mkdirSync(join(excluded.root, "secret"));
    writeFileSync(join(excluded.root, "secret", "blocked.txt"), "blocked\n");
    spawnSync("git", ["add", "secret/blocked.txt"], { cwd: excluded.root });
    const rejected = resolveExternalActionRequest(excluded.root, {
      operation: "git.commit",
      payload: { message: "fix(test): must reject exclusion" },
    });
    if (!rejected.ok) throw new Error(rejected.error);
    expect(
      await executeResolvedExternalAction(rejected.data, excluded.root, undefined, {
        host: "workit_cli",
        actor: excluded.actor,
      }),
    ).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { outcome: "not_started" },
    });
    expect(
      spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: excluded.root,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("initial");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("hosting reconciliation reads one exact GitHub result and preserves unknown ambiguity", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-hosting-read-"));
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  const previousFetch = globalThis.fetch;
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], { cwd: root });
    const tokenPath = join(root, "token");
    const configPath = join(root, "vcs.json");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "github", github: { tokenFile: tokenPath } }),
    );
    process.env.WORKFLOW_VCS_CONFIG = configPath;
    const resolved = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main" },
    });
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const actionRef = {
      kind: "host" as const,
      host: "workit_cli" as const,
      handle: "original-action",
    };
    const source = resolved.data.descriptorPayload as {
      target_branch: string;
      resolved: { source_branch: string; source_commit: string; marker: string };
    };
    let ambiguous = false;
    let malformed = false;
    let malformedNested = false;
    let fullPage = false;
    let queries = 0;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => {
        queries += 1;
        if (ambiguous) return [];
        if (malformed) return [null];
        if (malformedNested)
          return [
            {
              number: 42,
              body: source.resolved.marker,
              target_branch: source.target_branch,
              source_branch: source.resolved.source_branch,
              sha: source.resolved.source_commit,
              base: null,
              head: { ref: source.resolved.source_branch, sha: source.resolved.source_commit },
            },
          ];
        if (fullPage)
          return Array.from({ length: 100 }, () => ({
            number: 1,
            body: "",
            base: { ref: source.target_branch },
            head: { ref: source.resolved.source_branch, sha: source.resolved.source_commit },
          }));
        return [
          {
            number: 42,
            body: source.resolved.marker,
            base: { ref: source.target_branch },
            head: { ref: source.resolved.source_branch, sha: source.resolved.source_commit },
          },
        ];
      },
    })) as unknown as typeof fetch;
    const found = await readHostingAction(root, resolved.data, actionRef);
    expect(found).toMatchObject({ ok: true, data: { outcome: "succeeded", data: { id: 42 } } });
    malformed = true;
    expect(await readHostingAction(root, resolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    malformed = false;
    malformedNested = true;
    expect(await readHostingAction(root, resolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    malformedNested = false;
    fullPage = true;
    expect(await readHostingAction(root, resolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    fullPage = false;
    const queriedBeforeHostChange = queries;
    spawnSync("git", ["remote", "set-url", "origin", "https://evil.example/org/repo.git"], {
      cwd: root,
    });
    expect(await readHostingAction(root, resolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    expect(queries).toBe(queriedBeforeHostChange);
    spawnSync("git", ["remote", "set-url", "origin", "https://github.com/org/repo.git"], {
      cwd: root,
    });
    ambiguous = true;
    expect(await readHostingAction(root, resolved.data, actionRef)).toMatchObject({
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
    const gitlabResolved = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main" },
    });
    expect(gitlabResolved).toMatchObject({ ok: true });
    if (!gitlabResolved.ok) return;
    const gitlabSource = gitlabResolved.data.descriptorPayload as {
      target_branch: string;
      resolved: { source_branch: string; source_commit: string; marker: string };
    };
    let gitlabMalformed = false;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () =>
        gitlabMalformed
          ? [
              {
                iid: 7,
                description: gitlabSource.resolved.marker,
                target_branch: gitlabSource.target_branch,
                source_branch: gitlabSource.resolved.source_branch,
                head: { sha: gitlabSource.resolved.source_commit },
              },
            ]
          : [
              {
                iid: 7,
                description: gitlabSource.resolved.marker,
                target_branch: gitlabSource.target_branch,
                source_branch: gitlabSource.resolved.source_branch,
                sha: gitlabSource.resolved.source_commit,
              },
            ],
    })) as unknown as typeof fetch;
    gitlabMalformed = true;
    expect(await readHostingAction(root, gitlabResolved.data, actionRef)).toMatchObject({
      ok: false,
      code: "external_outcome_unknown",
    });
    gitlabMalformed = false;
    expect(await readHostingAction(root, gitlabResolved.data, actionRef)).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", data: { provider: "gitlab", id: 7 } },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
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

test("pull_request resolve defaults babysit true and honors explicit decline", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pr-babysit-"));
  const previousConfig = process.env.WORKFLOW_VCS_CONFIG;
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(join(root, "initial.txt"), "initial\n");
    spawnSync("git", ["add", "initial.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
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
    expect((auto.data.descriptorPayload as { babysit: boolean }).babysit).toBe(true);
    const declined = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "Test", target_branch: "main", babysit: false },
    });
    expect(declined).toMatchObject({ ok: true });
    if (!declined.ok) return;
    expect((declined.data.descriptorPayload as { babysit: boolean }).babysit).toBe(false);
  } finally {
    if (previousConfig === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
