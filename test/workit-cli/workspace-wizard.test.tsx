import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { Wizard } from "../../packages/workit-cli/src/steps";
import { renderInk } from "../shared/helpers/ink-tty";
import {
  createInitialDraft,
  reducer,
  type WizardDraft,
} from "../../packages/workit-cli/src/wizard-state";
import {
  applySetupPreview,
  buildSetupPreview,
  type SetupMutation,
  type SetupPreviewInput,
} from "../../packages/workit-core/src/core/setup";
import {
  loadWorkspacesFrom,
  matchWorkspace,
  type WorkspaceConfig,
} from "../../packages/workit-core/src/core/workspaces";
import { isolatedEnv } from "../shared/helpers/packages";
import type { ToolkitConfig } from "../../packages/workit-core/src/core/config";

// Task 15 (WZ-12, WZ-16): the workspace draft supports current-project setup and
// add/edit/remove, every accepted pattern shows a match preview produced by the
// SHARED core matcher (workspaces.ts — never duplicated), the workspaces screen
// renders real controls, and the preview emits accurate update-workspaces
// mutations (no rewrite claim when the draft equals disk).

const ENTER = "\r";
const ESC = "\x1b\x1b\x1b";
const UP = "\u001b[A";
const SPACE = " ";
const BACKSPACE = "\x7f";

const noop = () => {};

const seedConfig: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en", "es-CL"],
  timezone: "UTC",
  branchPolicy: {
    preset: "gitflow",
    allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
    protected: ["main", "develop"],
  },
};

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

function withConfigDir(configDir: string, workspaces?: WorkspaceConfig[]): void {
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify(seedConfig), "utf8");
  if (workspaces) {
    writeFileSync(
      path.join(configDir, "workspaces.json"),
      JSON.stringify({ workspaces }, null, 2) + "\n",
      "utf8",
    );
  }
}

function draftWith(workspaces: WorkspaceConfig[]): WizardDraft {
  return {
    screen: "workspaces",
    values: {
      platforms: [],
      locale: "en",
      timezone: "UTC",
      branchPreset: "gitflow",
      branchAllowed: "",
      branchProtected: "",
      baseUrl: "",
      vcsProvider: "gitlab",
      workspaces,
      applyProject: false,
    },
    errors: {},
    cancelled: false,
    workspaceDraft: null,
    workspaceIndex: null,
  };
}

const entry = (name: string, glob: string): WorkspaceConfig => ({
  name,
  glob,
  vcs: { provider: "gitlab" },
});

const previewValues = (over: Partial<SetupPreviewInput> = {}): SetupPreviewInput => ({
  platforms: [],
  locale: "en",
  timezone: "UTC",
  branchPreset: "gitflow",
  branchAllowed: "feature/*, bugfix/*",
  branchProtected: "main, develop",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: false,
  ...over,
});

async function gotoWorkspaces(tty: Awaited<ReturnType<typeof renderInk>>) {
  await tty.keys(SPACE, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER);
  expect(tty.lastFrame()).toContain("Step 5 — Workspaces");
}

// ---------------------------------------------------------------------------
// Shared matcher (WZ-12): the wizard preview routes through core, not a copy.
// ---------------------------------------------------------------------------

test("matchWorkspace is the shared authoritative matcher", () => {
  expect(matchWorkspace("/work/**", "/work/repo")).toBe(true);
  expect(matchWorkspace("/work/**", "/work/repo/deep")).toBe(true);
  expect(matchWorkspace("/work/**", "/work")).toBe(true);
  expect(matchWorkspace("/work/**", "/home/work/repo")).toBe(false);
  expect(matchWorkspace("**/repo", "/repo")).toBe(true);
  expect(matchWorkspace("/work/*", "/work/a/b")).toBe(false);
});

test("loadWorkspacesFrom parses the on-disk list and ignores non-arrays", () => {
  const dir = tmp("wk-ws-load-");
  try {
    expect(loadWorkspacesFrom(dir)).toEqual([]);
    writeFileSync(path.join(dir, "workspaces.json"), "{ not json", "utf8");
    expect(loadWorkspacesFrom(dir)).toEqual([]);
    writeFileSync(
      path.join(dir, "workspaces.json"),
      JSON.stringify({ workspaces: [entry("work", "/work/**")] }),
      "utf8",
    );
    expect(loadWorkspacesFrom(dir)).toEqual([entry("work", "/work/**")]);
  } finally {
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Reducer transitions (pure)
// ---------------------------------------------------------------------------

test("workspaceAdd starts an empty draft; workspaceSave appends the entry", () => {
  let d = reducer(draftWith([]), { type: "workspaceAdd" });
  expect(d.screen).toBe("workspaceName");
  expect(d.workspaceDraft).toEqual({ name: "", glob: "", vcs: { provider: "gitlab" } });
  d = reducer(d, { type: "workspaceDraftName", value: "work" });
  d = reducer(d, { type: "workspaceDraftGlob", value: "/work/**" });
  d = reducer(d, { type: "workspaceSave" });
  expect(d.screen).toBe("workspaces");
  expect(d.values.workspaces).toEqual([entry("work", "/work/**")]);
});

test("workspaceEdit loads the entry and save replaces it, preserving unrelated fields", () => {
  const original: WorkspaceConfig = {
    ...entry("work", "/work/**"),
    youtrack: { link_issues: true },
  };
  let d = reducer(draftWith([original]), { type: "workspaceEdit", index: 0 });
  expect(d.screen).toBe("workspaceName");
  expect(d.workspaceDraft?.name).toBe("work");
  d = reducer(d, { type: "workspaceDraftGlob", value: "/other/**" });
  d = reducer(d, { type: "workspaceSave" });
  expect(d.values.workspaces).toEqual([{ ...original, glob: "/other/**" }]);
  expect(d.values.workspaces[0].youtrack).toEqual({ link_issues: true });
});

test("workspaceEdit with a provider-less entry preserves the shape", () => {
  let d = reducer(draftWith([{ name: "plain", glob: "/p/**" }]), {
    type: "workspaceEdit",
    index: 0,
  });
  d = reducer(d, { type: "workspaceSave" });
  expect(d.values.workspaces[0].vcs).toBeUndefined();
});

test("workspaceRemove splices the entry out", () => {
  const d = reducer(draftWith([entry("work", "/work/**"), entry("personal", "/p/**")]), {
    type: "workspaceRemove",
    index: 0,
  });
  expect(d.values.workspaces).toEqual([entry("personal", "/p/**")]);
  // an out-of-range index is a no-op
  expect(
    reducer(draftWith([entry("work", "/work/**")]), { type: "workspaceRemove", index: 5 }),
  ).toEqual(draftWith([entry("work", "/work/**")]));
});

test("workspaceAddCurrent derives name + pattern from the current project path", () => {
  const d = reducer(draftWith([]), { type: "workspaceAddCurrent", path: "/home/u/proj" });
  expect(d.screen).toBe("workspaces");
  expect(d.values.workspaces).toEqual([
    { name: "proj", glob: "/home/u/proj/**", vcs: { provider: "gitlab" } },
  ]);
});

test("workspaceAddCurrent provider follows the wizard VCS selection", () => {
  const github = reducer(
    { ...draftWith([]), values: { ...draftWith([]).values, vcsProvider: "github" } },
    { type: "workspaceAddCurrent", path: "/home/u/proj" },
  );
  expect(github.values.workspaces[0].vcs?.provider).toBe("github");
  const skip = reducer(
    { ...draftWith([]), values: { ...draftWith([]).values, vcsProvider: "skip" } },
    { type: "workspaceAddCurrent", path: "/home/u/proj" },
  );
  expect(skip.values.workspaces[0].vcs?.provider).toBe("gitlab");
});

test("empty workspace name and glob block next with per-field errors", () => {
  let d = reducer(draftWith([]), { type: "workspaceAdd" });
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("workspaceName");
  expect(d.errors.workspaceName).toContain("name is required");
  d = reducer(d, { type: "workspaceDraftName", value: "work" });
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("workspaceGlob");
  expect(d.errors.workspaceGlob).toBeUndefined();
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("workspaceGlob");
  expect(d.errors.workspaceGlob).toContain("pattern is required");
  d = reducer(d, { type: "workspaceDraftGlob", value: "/work/**" });
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("workspaceProvider");
});

test("workspaceSave without a valid draft is a no-op", () => {
  const base = draftWith([]);
  expect(reducer(base, { type: "workspaceSave" })).toBe(base);
  const empty = reducer(base, { type: "workspaceAdd" });
  expect(reducer(empty, { type: "workspaceSave" }).screen).toBe("workspaceName");
});

test("back walks the workspace flow to the menu and discards the in-progress entry", () => {
  let d = reducer(draftWith([]), { type: "workspaceAdd" });
  expect(reducer(d, { type: "back" }).screen).toBe("workspaces");
  d = reducer(draftWith([]), { type: "workspaceAdd" });
  d = reducer(d, { type: "workspaceDraftName", value: "work" });
  d = reducer(d, { type: "next" }); // name -> glob
  d = reducer(d, { type: "back" });
  expect(d.screen).toBe("workspaceName");
  d = reducer(d, { type: "back" });
  expect(d.screen).toBe("workspaces");
  d = reducer(draftWith([]), { type: "workspaceAdd" });
  d = reducer(d, { type: "workspaceDraftName", value: "work" });
  d = reducer(d, { type: "next" });
  d = reducer(d, { type: "workspaceDraftGlob", value: "/work/**" });
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("workspaceProvider");
  expect(reducer(d, { type: "back" }).screen).toBe("workspaceGlob");
});

// ---------------------------------------------------------------------------
// Preview parity: the draft is authoritative but must not claim a rewrite
// when it is identical to disk (Task 13 advisory).
// ---------------------------------------------------------------------------

test("buildSetupPreview: draft identical to disk emits no update-workspaces mutation", () => {
  const dir = tmp("wk-ws-parity-same-");
  try {
    writeFileSync(
      path.join(dir, "workspaces.json"),
      JSON.stringify({ workspaces: [entry("work", "/work/**")] }, null, 2) + "\n",
      "utf8",
    );
    const preview = buildSetupPreview(previewValues({ workspaces: [entry("work", "/work/**")] }), {
      dir,
      env: {},
    });
    expect(preview.ok).toBe(true);
    expect(preview.mutations.some((m) => m.type === "update-workspaces")).toBe(false);
  } finally {
    clean(dir);
  }
});

test("buildSetupPreview: a changed draft emits update-workspaces with the new entries", () => {
  const dir = tmp("wk-ws-parity-diff-");
  try {
    writeFileSync(
      path.join(dir, "workspaces.json"),
      JSON.stringify({ workspaces: [entry("work", "/work/**")] }, null, 2) + "\n",
      "utf8",
    );
    const preview = buildSetupPreview(previewValues({ workspaces: [entry("work", "/other/**")] }), {
      dir,
      env: {},
    });
    const ws = preview.mutations.find((m) => m.type === "update-workspaces") as Extract<
      SetupMutation,
      { type: "update-workspaces" }
    >;
    expect(ws).toBeDefined();
    expect(ws.entries).toEqual([entry("work", "/other/**")]);
  } finally {
    clean(dir);
  }
});

test("buildSetupPreview: removing every workspace writes an empty list", () => {
  const dir = tmp("wk-ws-parity-removeall-");
  try {
    writeFileSync(
      path.join(dir, "workspaces.json"),
      JSON.stringify({ workspaces: [entry("work", "/work/**")] }, null, 2) + "\n",
      "utf8",
    );
    const preview = buildSetupPreview(previewValues({ workspaces: [] }), { dir, env: {} });
    const ws = preview.mutations.find((m) => m.type === "update-workspaces") as Extract<
      SetupMutation,
      { type: "update-workspaces" }
    >;
    expect(ws).toBeDefined();
    expect(ws.entries).toEqual([]);
  } finally {
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Apply: workspaces write + credential preservation in one reviewed apply.
// ---------------------------------------------------------------------------

test("apply writes workspaces and preserves existing tokens (WZ-12/CA-13)", () => {
  const home = tmp("wk-ws-apply-home-");
  const dir = tmp("wk-ws-apply-cfg-");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const tokenPath = path.join(dir, "youtrack.token");
    writeFileSync(tokenPath, "perm_supersecret\n", { mode: 0o600 });
    const preview = buildSetupPreview(
      previewValues({
        platforms: ["opencode"],
        baseUrl: "https://yt.example.com",
        workspaces: [entry("work", "/work/**")],
      }),
      { dir, cwd: dir, env: {} },
    );
    expect(preview.ok).toBe(true);
    expect(preview.preserved).toContain(tokenPath);
    const result = applySetupPreview(preview, {
      home,
      configDir: dir,
      dev: repoRoot,
      cwd: dir,
      env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
    });
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    const ws = JSON.parse(readFileSync(path.join(dir, "workspaces.json"), "utf8"));
    expect(ws.workspaces).toEqual([entry("work", "/work/**")]);
    expect(readFileSync(tokenPath, "utf8")).toBe("perm_supersecret\n");
    expect(result.entries.some((e) => e.file === tokenPath && e.status === "Skipped")).toBe(true);
    expect(result.entries.some((e) => e.platform === "opencode" && e.status === "Installed")).toBe(
      true,
    );
    expect(result.doctor.length).toBe(1);
    expect(result.doctor[0].exitCode).toBe(0);
  } finally {
    clean(home);
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Deterministic TTY: workspaces menu, add/edit/remove, current project, and
// the shared-matcher preview.
// ---------------------------------------------------------------------------

test("workspaces menu renders real controls, not a placeholder", async () => {
  const configDir = tmp("wk-ws-menu-cfg-");
  const project = tmp("wk-ws-menu-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    const frame = tty.lastFrame();
    expect(frame).toContain("Add workspace");
    expect(frame).toContain("Use current project");
    expect(frame).toContain("Done");
    expect(tty.inputListenerCount()).toBe(3);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("add flow: name → glob preview → provider → menu shows the entry with a verdict", async () => {
  const configDir = tmp("wk-ws-add-cfg-");
  const project = tmp("wk-ws-add-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    // menu highlights Done (last); UP UP -> Add workspace
    await tty.keys(UP, UP, ENTER);
    expect(tty.lastFrame()).toContain("Workspaces · Name");
    await tty.keys("work", ENTER);
    // glob screen: live shared-matcher preview shows matches AND non-matches
    // (typed in two chunks — a single-burst write drops the intermediate frame
    // under Ink's renderer; real terminals deliver per keystroke)
    await tty.keys(`${project}/child`);
    await tty.keys(`-repo/**`);
    const globFrame = tty.lastFrame();
    expect(globFrame).toContain("Match preview (shared matcher):");
    expect(globFrame).toContain("✓ matches");
    expect(globFrame).toContain("✗ no match");
    await tty.keys(ENTER); // -> provider
    expect(tty.lastFrame()).toContain("Workspaces · Provider");
    await tty.keys(ENTER); // provider gitlab -> save -> menu
    const menu = tty.lastFrame();
    expect(menu).toContain("work");
    expect(menu).toContain(`${project}/child-repo/**`);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("a matching current-project pattern renders a ✓ verdict in the menu", async () => {
  const configDir = tmp("wk-ws-verdict-cfg-");
  const project = tmp("wk-ws-verdict-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir, [entry("work", `${project}/**`)]);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    const menu = tty.lastFrame();
    expect(menu).toContain("✓ matches work");
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("edit flow: change the pattern, the verdict flips and the save persists it", async () => {
  const configDir = tmp("wk-ws-edit-cfg-");
  const project = tmp("wk-ws-edit-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir, [entry("work", "/work/**")]);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    expect(tty.lastFrame()).toContain("✗ no match work");
    // menu options: Edit(0) Remove(1) Add(2) Use current(3) Done(4); UP x4 -> Edit
    await tty.keys(UP, UP, UP, UP, ENTER);
    expect(tty.lastFrame()).toContain("Edit workspace name (work):");
    await tty.keys(ENTER); // keep name
    expect(tty.lastFrame()).toContain("Workspaces · Pattern");
    for (let i = 0; i < "/work/**".length; i++) await tty.key(BACKSPACE);
    await tty.keys(`${project}/**`, ENTER);
    await tty.keys(ENTER); // provider gitlab -> save
    const menu = tty.lastFrame();
    expect(menu).toContain("✓ matches work");
    expect(menu).toContain(`${project}/**`);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("remove flow: the entry disappears from the menu", async () => {
  const configDir = tmp("wk-ws-remove-cfg-");
  const project = tmp("wk-ws-remove-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir, [entry("work", "/work/**")]);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    // UP x3 -> Remove work
    await tty.keys(UP, UP, UP, ENTER);
    const menu = tty.lastFrame();
    expect(menu).toContain("No workspaces configured yet.");
    expect(menu).not.toContain("Remove work");
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("current-project setup adds the cwd pattern in one step", async () => {
  const configDir = tmp("wk-ws-current-cfg-");
  const project = tmp("wk-ws-current-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    // UP once -> Use current project
    await tty.keys(UP, ENTER);
    const menu = tty.lastFrame();
    const name = project.slice(project.lastIndexOf("/") + 1);
    expect(menu).toContain(`${name}`);
    expect(menu).toContain(`${project}/**`);
    expect(menu).toContain("✓ matches");
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("workspace name/glob validation blocks advancing with inline errors", async () => {
  const configDir = tmp("wk-ws-validate-cfg-");
  const project = tmp("wk-ws-validate-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const tty = await renderInk(<Wizard onExit={noop} />);
    await gotoWorkspaces(tty);
    await tty.keys(UP, UP, ENTER); // Add workspace
    await tty.keys(ENTER); // empty name
    expect(tty.lastFrame()).toContain("workspace name is required");
    await tty.keys("work", ENTER);
    await tty.keys(ENTER); // empty glob
    expect(tty.lastFrame()).toContain("workspace pattern is required");
    await tty.keys(`${project}/**`, ENTER);
    expect(tty.lastFrame()).toContain("Workspaces · Provider");
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("back and cancel inside the workspace flow preserve state and write nothing", async () => {
  const configDir = tmp("wk-ws-nav-cfg-");
  const project = tmp("wk-ws-nav-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const exitCalls: boolean[] = [];
    const tty = await renderInk(<Wizard onExit={(ok) => exitCalls.push(ok)} />);
    await gotoWorkspaces(tty);
    await tty.keys(UP, UP, ENTER); // Add workspace
    await tty.keys("work", ENTER);
    await tty.keys(`${project}/child-repo/**`, ENTER); // -> provider
    // provider is a select screen: 'b' walks back; Esc on a text screen backs up
    await tty.keys("b");
    expect(tty.lastFrame()).toContain("Workspaces · Pattern");
    await tty.keys(ESC);
    expect(tty.lastFrame()).toContain("Workspaces · Name");
    expect(tty.lastFrame()).toContain("work");
    await tty.keys(ESC); // back to the workspaces menu (draft discarded)
    expect(tty.lastFrame()).toContain("No workspaces configured yet.");
    // Esc on a select screen cancels the whole wizard with no writes
    await tty.keys(ESC);
    expect(exitCalls).toEqual([false]);
    expect(existsSync(path.join(configDir, "workspaces.json"))).toBe(false);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("summary shows the update-workspaces mutation after an add", async () => {
  const configDir = tmp("wk-ws-summary-cfg-");
  const project = tmp("wk-ws-summary-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir);
    const exitCalls: boolean[] = [];
    const tty = await renderInk(<Wizard onExit={(ok) => exitCalls.push(ok)} />);
    await gotoWorkspaces(tty);
    await tty.keys(UP, UP, ENTER); // Add workspace
    await tty.keys("work", ENTER);
    await tty.keys(`${project}/child-repo/**`, ENTER);
    await tty.keys(ENTER); // provider -> save -> menu (Done highlighted)
    await tty.keys(ENTER); // Done -> project
    await tty.keys("y"); // project -> summary
    const frame = tty.lastFrame();
    expect(frame).toContain("Will apply");
    expect(frame).toContain("workspaces.json");
    expect(frame).toContain("1 workspace");
    await tty.keys("y"); // apply
    expect(exitCalls).toEqual([true]);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("untouched workspaces produce no update-workspaces mutation in the summary", async () => {
  const configDir = tmp("wk-ws-summary-skip-cfg-");
  const project = tmp("wk-ws-summary-skip-proj-");
  const previous = process.cwd();
  process.chdir(project);
  try {
    withConfigDir(configDir, [entry("work", "/work/**")]);
    const exitCalls: boolean[] = [];
    const tty = await renderInk(<Wizard onExit={(ok) => exitCalls.push(ok)} />);
    await gotoWorkspaces(tty);
    await tty.keys(ENTER); // Done (default highlight) -> project
    await tty.keys("y"); // project -> summary
    const frame = tty.lastFrame();
    expect(frame).toContain("Will apply");
    expect(frame).not.toContain("workspaces.json");
    await tty.keys("y"); // apply
    expect(exitCalls).toEqual([true]);
    tty.unmount();
  } finally {
    process.chdir(previous);
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(configDir);
    clean(project);
  }
});

test("createInitialDraft seeds workspaces from the configured dir", () => {
  const dir = tmp("wk-ws-seed-cfg-");
  try {
    withConfigDir(dir, [entry("work", "/work/**")]);
    const draft = createInitialDraft(seedConfig);
    expect(draft.values.workspaces).toEqual([entry("work", "/work/**")]);
    expect(draft.workspaceDraft).toBeNull();
    expect(draft.workspaceIndex).toBeNull();
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});
