import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  success,
  type NativeAuthorityVerifier,
} from "@/packages/workit-core/src/core";
import {
  autoApproves,
  resolveAutoApproval,
  standingAutoApplies,
  standingApprovalLive,
  type AutoApproval,
} from "@/packages/workit-core/src/core/auto-approval";
import { verifyPushIdentity, isProtectedTarget } from "@/packages/workit-core/src/core/branch";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";
import { taskStartRequest } from "./task-fixtures";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-auto-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
};

test("auto-approval resolves per workspace and defaults off", () => {
  const root = repo();
  try {
    // No config anywhere: nothing is auto-approved.
    expect(resolveAutoApproval(root)).toEqual({ status: "off" });
    expect(autoApproves(root, "commit")).toBe(false);
    expect(autoApproves(root, "push")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-approval honors class lists and rejects unknown classes", () => {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "workit-autocfg-"));
  try {
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "t",
            glob: `${root}/**`,
            autoApprove: ["commit", "branch"],
            vcs: { provider: "github", account: "someone" },
          },
        ],
      }),
    );
    const resolved = resolveAutoApproval(root, configDir) as Extract<
      AutoApproval,
      { status: "on" }
    >;
    expect(resolved.status).toBe("on");
    expect(autoApproves(root, "commit", configDir)).toBe(true);
    expect(autoApproves(root, "push", configDir)).toBe(false);
    expect(autoApproves(root, "publish" as never, configDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("standing approval dies with its rule (fail closed on removal)", () => {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "workit-autocfg-"));
  try {
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({ workspaces: [{ name: "t", glob: `${root}/**`, autoApprove: true }] }),
    );
    const receipt = {
      kind: "standing",
      workspace: "t",
      class: "commit",
      configDigest: "x",
    } as const;
    expect(standingApprovalLive(root, receipt, "commit", configDir)).toBe(true);
    writeFileSync(join(configDir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
    expect(standingApprovalLive(root, receipt, "commit", configDir)).toBe(false);
    expect(standingApprovalLive(root, receipt, "push", configDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("protected targets fail closed", () => {
  const root = repo();
  try {
    expect(isProtectedTarget(root, "main")).toBe(true);
    expect(isProtectedTarget(root, "feature/x")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push identity check enforces the area account", () => {
  const root = repo();
  // Hermetic: empty PATH so gh/glab resolve to nothing and fail fast.
  // (On Windows CI the real gh hangs instead of failing.)
  const emptyBin = mkdtempSync(join(tmpdir(), "workit-empty-bin-"));
  const previousPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    // Unreachable identity fails closed, never open.
    const result = verifyPushIdentity(root, "github", "someone");
    expect(result.ok).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("push identity probe selects the action target's configured CLI host", () => {
  const root = repo();
  const config = mkdtempSync(join(tmpdir(), "workit-target-cli-config-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-target-cli-tools-"));
  const log = join(tools, "host.txt");
  const previous = {
    PATH: process.env.PATH,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
    WORKFLOW_VCS_CONFIG: process.env.WORKFLOW_VCS_CONFIG,
  };
  try {
    git(root, ["remote", "add", "origin", "git@github-work:org/repo.git"]);
    writeFileSync(
      join(config, "vcs.json"),
      JSON.stringify({ provider: "github", github: { host: "github.enterprise.test" } }),
    );
    writeFileSync(
      join(config, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "target", glob: `${root}/**`, vcs: { provider: "github", account: "expected" } },
        ],
      }),
    );
    writeFileSync(
      join(tools, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$GH_HOST" > "${log}"\necho '{"login":"expected"}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tools, "gh.cmd"),
      `@echo off\r\necho %GH_HOST%>"${log}"\r\necho {"login":"expected"}\r\n`,
    );
    process.env.WORKFLOW_TOOLKIT_CONFIG = config;
    process.env.WORKFLOW_VCS_CONFIG = join(config, "vcs.json");
    process.env.PATH = `${tools}${delimiter}${previous.PATH ?? ""}`;
    expect(verifyPushIdentity(root, "github", "expected")).toEqual({ ok: true });
    expect(readFileSync(log, "utf8").trim()).toBe("github.enterprise.test");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, config, tools]) rmSync(dir, { recursive: true, force: true });
  }
});

test("git.push checks the configured area account for a custom SSH host alias", () => {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "workit-alias-config-"));
  const tools = mkdtempSync(join(tmpdir(), "workit-alias-tools-"));
  const previous = {
    PATH: process.env.PATH,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
    WORKFLOW_VCS_CONFIG: process.env.WORKFLOW_VCS_CONFIG,
  };
  try {
    git(root, ["remote", "add", "origin", "git@github-work.com:org/repo.git"]);
    writeFileSync(join(configDir, "vcs.json"), JSON.stringify({ provider: "github" }));
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "target", glob: `${root}/**`, vcs: { provider: "github", account: "expected" } },
        ],
      }),
    );
    writeFileSync(join(tools, "gh"), '#!/bin/sh\necho \'{"login":"wrong"}\'\n', { mode: 0o755 });
    writeFileSync(join(tools, "gh.cmd"), '@echo off\r\necho {"login":"wrong"}\r\n');
    process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
    process.env.WORKFLOW_VCS_CONFIG = join(configDir, "vcs.json");
    process.env.PATH = `${tools}${delimiter}${previous.PATH ?? ""}`;
    expect(
      resolveExternalActionRequest(root, { operation: "git.push", payload: { branch: "main" } }),
    ).toMatchObject({ ok: false, code: "capability_unavailable" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, configDir, tools]) rmSync(dir, { recursive: true, force: true });
  }
});

test("git.push refuses ambiguous origin push destinations", () => {
  const root = repo();
  try {
    git(root, ["remote", "add", "origin", "https://github.com/org/repo.git"]);
    git(root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://github.com/org/repo.git",
    ]);
    git(root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://mirror.example/org/repo.git",
    ]);
    expect(
      resolveExternalActionRequest(root, {
        operation: "git.push",
        payload: { branch: "main" },
      }).ok,
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push needs a real remote even when the branch is protected by a preset", () => {
  const root = repo();
  try {
    const resolved = resolveExternalActionRequest(root, {
      operation: "git.push",
      payload: { branch: "main" },
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toMatch(/resolvable current branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR creation without a provider-bound remote still fails closed", () => {
  const root = repo();
  try {
    // Decision ae03c569: creation is enabled, but a checkout with no remote
    // (or a non-provider remote) can never bind the approved source SHA.
    const resolved = resolveExternalActionRequest(root, {
      operation: "hosting.pull_request",
      payload: { title: "x" },
    });
    expect(resolved).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      details: { capability: "hosting.pull_request", outcome: "not_started" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosting.merge resolves source and target with protections", () => {
  const root = repo();
  try {
    git(root, ["checkout", "-qb", "feature/merge"]);
    const resolved = resolveExternalActionRequest(root, {
      operation: "hosting.merge",
      payload: { target_branch: "main" },
    });
    // No remote/token here: must fail, but with resolution (not schema) errors.
    if (!resolved.ok) expect(resolved.error).not.toMatch(/invalid_input.*operation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosting.merge needs a bound remote regardless of source branch", () => {
  const root = repo();
  try {
    const resolved = resolveExternalActionRequest(root, {
      operation: "hosting.merge",
      payload: { target_branch: "main" },
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toMatch(/configured remote provider/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const standingSetup = (actor = "cli-auto") => {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "workit-autocfg-"));
  writeFileSync(
    join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "t", glob: `${root}/**`, autoApprove: ["commit"], vcs: { provider: "github" } },
      ],
    }),
  );
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "workit_cli", actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeAuthority: {
      verifyDecision: () => success(null, null, null as never),
      verifyAction: () => success(null, null, null as never),
      verifyReconciliation: () => success(null, null, null as never),
    } satisfies NativeAuthorityVerifier,
  });
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const writer = core.writer({ schemaVersion: 1, action: "acquire", taskId });
  if (!writer.ok) throw new Error(writer.error);
  return { root, configDir, store, core, actor, taskId };
};

const standingRecord = (
  setupValue: ReturnType<typeof standingSetup>,
  descriptor: string,
  cls: string,
) => {
  const { store, core, taskId } = setupValue;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  return core.observeStandingDecision({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    purpose: "action",
    binding: {
      taskId,
      workspaceId: workspace.data.id,
      scope: task.data.intent.data.scope,
      presented: "auto",
      approvedContent: descriptor,
      contentRefs: [],
      standing: { workspace: "t", class: cls },
    },
    response: "approved",
    requirementIds: [],
  });
};

test("standing decisions record without a question and die with the rule", () => {
  const value = standingSetup();
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = value.configDir;
  try {
    // Hand-built descriptor: the record path checks class coverage, not git state.
    const fake = JSON.stringify({
      operation: "git.commit",
      payload: { message: "auto one", resolved: { branch: "main" } },
    });
    const recorded = standingRecord(value, fake, "commit");
    expect(recorded.ok).toBe(true);
    // Wrong class for the operation: rejected.
    const wrongClass = standingRecord(value, fake, "push");
    expect(wrongClass.ok).toBe(false);
    // Rule removed: new standing records fail closed.
    writeFileSync(join(value.configDir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
    const afterRemoval = standingRecord(value, fake, "commit");
    expect(afterRemoval.ok).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.configDir, { recursive: true, force: true });
  }
});

test("standing approval for an action-time target uses that area's rule", () => {
  const value = standingSetup();
  const other = mkdtempSync(join(tmpdir(), "workit-other-area-"));
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = value.configDir;
  try {
    const descriptor = JSON.stringify({
      operation: "git.commit",
      payload: { cwd: other, message: "plain message" },
    });
    writeFileSync(
      join(value.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "coordinator", glob: `${value.root}/**`, autoApprove: ["commit"] },
          { name: "target", glob: `${other}/**`, autoApprove: ["push"] },
        ],
      }),
    );
    expect(standingAutoApplies(value.store, "workit_cli", value.actor, descriptor)).toBeNull();
    writeFileSync(
      join(value.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "coordinator", glob: `${value.root}/**`, autoApprove: ["commit"] },
          { name: "target", glob: `${other}/**`, autoApprove: ["commit"] },
        ],
      }),
    );
    expect(
      standingAutoApplies(value.store, "workit_cli", value.actor, descriptor)?.workspaceName,
    ).toBe("target");
    expect(
      standingApprovalLive(
        value.root,
        { kind: "standing", workspace: "coordinator", class: "commit", configDigest: null },
        "commit",
        value.configDir,
        descriptor,
      ),
    ).toBe(false);
    expect(
      standingApprovalLive(
        value.root,
        { kind: "standing", workspace: "target", class: "commit", configDigest: null },
        "commit",
        value.configDir,
        descriptor,
      ),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
    rmSync(other, { recursive: true, force: true });
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.configDir, { recursive: true, force: true });
  }
});

test("standing decisions follow the current writer after session resumption", () => {
  const value = standingSetup("creator");
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = value.configDir;
  try {
    const resumed = new WorkitCore(value.store, {
      root: value.root,
      caller: { host: "workit_cli", actor: "resumed" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:01Z",
    });
    const acquired = resumed.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: value.taskId,
    });
    expect(acquired.ok).toBe(true);
    const fake = JSON.stringify({
      operation: "git.commit",
      payload: { message: "auto resumed", resolved: { branch: "main" } },
    });
    const task = value.store.readTask(value.taskId);
    const workspace = value.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const recorded = resumed.observeStandingDecision({
      schemaVersion: 1,
      action: "record",
      taskId: value.taskId,
      purpose: "action",
      binding: {
        taskId: value.taskId,
        workspaceId: workspace.data.id,
        scope: task.data.intent.data.scope,
        presented: "auto",
        approvedContent: fake,
        contentRefs: [],
        standing: { workspace: "t", class: "commit" },
      },
      response: "approved",
      requirementIds: [],
    });
    expect(recorded).toMatchObject({
      ok: true,
      data: { provenance: { session: { handle: "resumed" } } },
    });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.configDir, { recursive: true, force: true });
  }
});

test("standing auto-approval selects the writer task when another task is active", () => {
  const value = standingSetup();
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = value.configDir;
  try {
    const other = new WorkitCore(value.store, {
      root: value.root,
      caller: { host: "workit_cli", actor: "other" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:01Z",
    });
    expect(other.task(taskStartRequest({ expectedWorkspaceRevision: undefined })).ok).toBe(true);
    const operation = JSON.stringify({ operation: "git.commit" });
    expect(standingAutoApplies(value.store, "workit_cli", value.actor, operation)?.task.id).toBe(
      value.taskId,
    );
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.configDir, { recursive: true, force: true });
  }
});
