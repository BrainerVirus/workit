import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { Wizard, SelectList } from "../../packages/workit-cli/src/steps";
import { renderInk } from "../shared/helpers/ink-tty";
import {
  createInitialDraft,
  reducer,
  type BranchPolicyProposal,
  type WizardAction,
  type WizardDraft,
  type WizardScreen,
} from "../../packages/workit-cli/src/wizard-state";
import type { BranchPreset, ToolkitConfig } from "../../packages/workit-core/src/core/config";

const ENTER = "\r";
// Ink defers a lone \x1b for 20ms to disambiguate escape sequences (a wall-clock
// timer). Two ESCs in one chunk parse as an escape keypress synchronously, so a
// triple-ESC simulates pressing Escape deterministically without a sleep.
const ESC = "\x1b\x1b\x1b";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const SPACE = " ";
const BACKSPACE = "\x7f";

const noop = () => {};

// CA-06 (Task 5): the branchPolicy screen appears only when the resolution root
// is a git repo. This suite drives the non-git flow (workspaces ↔ project
// directly), but it runs in the repo root (a git repo), so pin
// WORKFLOW_WORKSPACE_ROOT to a guaranteed non-git path for the tests that walk
// past the workspaces step.
async function withNonGitRoot(run: () => void | Promise<void>): Promise<void> {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  process.env.WORKFLOW_WORKSPACE_ROOT = path.join(os.tmpdir(), `wiz-nongit-${process.pid}`);
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
  }
}

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

function withSeedConfig(config: ToolkitConfig): () => void {
  const base = mkdtempSync(path.join(os.tmpdir(), "workit-wiz-"));
  const configPath = path.join(base, "config");
  process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
  mkdirSync(configPath, { recursive: true });
  writeFileSync(path.join(configPath, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return () => {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    rmSync(base, { recursive: true, force: true });
  };
}

function draft(preset: BranchPreset): WizardDraft {
  return createInitialDraft({
    locale: "en",
    localeOptions: ["en", "es-CL"],
    timezone: "UTC",
    branchPolicy: { preset, allowed: [], protected: [] },
  });
}

function at(preset: BranchPreset, screen: WizardScreen): WizardDraft {
  return { ...draft(preset), screen };
}

// ---------------------------------------------------------------------------
// Reducer transitions (pure, deterministic)
// ---------------------------------------------------------------------------

test("next advances through the sequential screens", async () => {
  await withNonGitRoot(() => {
    let d = reducer(draft("gitflow"), { type: "set", field: "platforms", value: ["opencode"] });
    const sequence: WizardScreen[] = [
      "locale",
      "timezone",
      "branchPreset",
      "youtrack",
      "vcs",
      "workspaces",
      "project",
      "summary",
    ];
    for (const expected of sequence) {
      d = reducer(d, { type: "next" });
      expect(d.screen).toBe(expected);
    }
    // summary has no next
    expect(reducer(d, { type: "next" }).screen).toBe("summary");
  });
});

test("next skips the custom branch screens when the preset is not custom", () => {
  const d = at("gitflow", "branchPreset");
  expect(reducer(d, { type: "next" }).screen).toBe("youtrack");
});

test("next visits the custom branch screens when the preset is custom", () => {
  let d = at("custom", "branchPreset");
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("branchAllowed");
  d = reducer(d, { type: "set", field: "branchAllowed", value: "feature/*" });
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("branchProtected");
  d = reducer(d, { type: "set", field: "branchProtected", value: "main" });
  expect(reducer(d, { type: "next" }).screen).toBe("youtrack");
});

test("back reverses through screens and skips custom branch screens when not custom", async () => {
  await withNonGitRoot(() => {
    let d = at("gitflow", "youtrack");
    expect(reducer(d, { type: "back" }).screen).toBe("branchPreset");
    d = at("gitflow", "summary");
    d = reducer(d, { type: "back" });
    d = reducer(d, { type: "back" });
    expect(d.screen).toBe("workspaces");
  });
});

test("back from a custom-value screen returns to its parent select screen", () => {
  let d = at("gitflow", "localeOther");
  expect(reducer(d, { type: "back" }).screen).toBe("locale");
  d = at("gitflow", "timezoneOther");
  expect(reducer(d, { type: "back" }).screen).toBe("timezone");
});

test("pickOther opens the custom-value screen for locale and timezone", () => {
  let d = at("gitflow", "locale");
  expect(reducer(d, { type: "pickOther" }).screen).toBe("localeOther");
  d = at("gitflow", "timezone");
  expect(reducer(d, { type: "pickOther" }).screen).toBe("timezoneOther");
  d = at("gitflow", "vcs");
  expect(reducer(d, { type: "pickOther" }).screen).toBe("vcs");
});

test("next refuses to leave a screen whose value is invalid", () => {
  let d = at("custom", "branchAllowed");
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("branchAllowed");
  expect(d.errors.branchAllowed).toContain("required");
  d = reducer(d, { type: "set", field: "branchAllowed", value: "feature/*" });
  expect(d.errors.branchAllowed).toBeUndefined();
  expect(reducer(d, { type: "next" }).screen).toBe("branchProtected");
});

test("platforms requires at least one selection before advancing", () => {
  const d = reducer(draft("gitflow"), { type: "next" });
  expect(d.screen).toBe("platforms");
  expect(d.errors.platforms).toContain("at least one");
});

test("cancel and apply both terminate on the exit screen with the right flag", () => {
  const cancelled = reducer(draft("gitflow"), { type: "cancel" });
  expect(cancelled.screen).toBe("exit");
  expect(cancelled.cancelled).toBe(true);
  const applied = reducer(at("gitflow", "summary"), { type: "apply" });
  expect(applied.screen).toBe("exit");
  expect(applied.cancelled).toBe(false);
});

test("empty locale and timezone cannot be committed from the select screens", () => {
  let d = { ...at("gitflow", "locale"), values: { ...at("gitflow", "locale").values, locale: "" } };
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("locale");
  expect(d.errors.locale).toContain("locale is required");
  d = {
    ...at("gitflow", "timezone"),
    values: { ...at("gitflow", "timezone").values, timezone: "" },
  };
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("timezone");
  expect(d.errors.timezone).toContain("timezone is required");
});

// ---------------------------------------------------------------------------
// Reducer idempotency (D-02): unchanged values return the same draft object so
// the wizard's useReducer bails out instead of re-rendering the control and
// re-firing its onChange (the "Maximum update depth exceeded" feedback loop).
// ---------------------------------------------------------------------------

test("unchanged set values return the same draft object", () => {
  // A settled draft: valid non-empty text values so validation produces no
  // message and an unchanged dispatch is a true no-op.
  let settled = draft("custom");
  settled = reducer(settled, { type: "set", field: "locale", value: "es-CL" });
  settled = reducer(settled, { type: "set", field: "timezone", value: "America/Santiago" });
  settled = reducer(settled, { type: "set", field: "branchAllowed", value: "feature/*" });
  settled = reducer(settled, { type: "set", field: "branchProtected", value: "main" });
  settled = reducer(settled, { type: "set", field: "baseUrl", value: "https://yt.example.com" });
  settled = reducer(settled, { type: "set", field: "vcsProvider", value: "github" });
  settled = reducer(settled, { type: "set", field: "applyProject", value: true });
  settled = reducer(settled, { type: "set", field: "platforms", value: ["opencode"] });

  const wsName = reducer(reducer(draft("gitflow"), { type: "workspaceAdd" }), {
    type: "workspaceDraftName",
    value: "work",
  });
  const wsGlob = reducer(wsName, { type: "workspaceDraftGlob", value: "/work/**" });

  const proposal: BranchPolicyProposal = {
    preset: "gitflow",
    developBranch: "develop",
    integration: "pr",
    protected: ["main"],
    allowed: ["feature/*"],
    prefixes: { feature: "feature/", bugfix: "bugfix/", release: "release/", hotfix: "hotfix/" },
  };
  const withPolicy = reducer(settled, { type: "set", field: "branchPolicy", value: proposal });

  const cases: { name: string; state: WizardDraft; action: WizardAction }[] = [
    {
      name: "platforms",
      state: settled,
      action: { type: "set", field: "platforms", value: ["opencode"] },
    },
    { name: "locale", state: settled, action: { type: "set", field: "locale", value: "es-CL" } },
    {
      name: "timezone",
      state: settled,
      action: { type: "set", field: "timezone", value: "America/Santiago" },
    },
    {
      name: "branchPreset",
      state: settled,
      action: { type: "set", field: "branchPreset", value: "custom" },
    },
    {
      name: "branchAllowed",
      state: settled,
      action: { type: "set", field: "branchAllowed", value: "feature/*" },
    },
    {
      name: "branchProtected",
      state: settled,
      action: { type: "set", field: "branchProtected", value: "main" },
    },
    {
      name: "baseUrl",
      state: settled,
      action: { type: "set", field: "baseUrl", value: "https://yt.example.com" },
    },
    {
      name: "vcsProvider",
      state: settled,
      action: { type: "set", field: "vcsProvider", value: "github" },
    },
    {
      name: "applyProject",
      state: settled,
      action: { type: "set", field: "applyProject", value: true },
    },
    {
      name: "workspaceDraftName",
      state: wsName,
      action: { type: "workspaceDraftName", value: "work" },
    },
    {
      name: "workspaceDraftGlob",
      state: wsGlob,
      action: { type: "workspaceDraftGlob", value: "/work/**" },
    },
    {
      name: "branchPolicyIntegration",
      state: withPolicy,
      action: { type: "set", field: "branchPolicyIntegration", value: "pr" },
    },
    {
      name: "branchPolicyDevelop",
      state: withPolicy,
      action: { type: "set", field: "branchPolicyDevelop", value: "develop" },
    },
  ];

  for (const { name, state, action } of cases) {
    expect(reducer(state, action), name).toBe(state);
  }
});

test("changed set values return a new draft with the expected value", () => {
  const base = draft("gitflow");

  const locale = reducer(base, { type: "set", field: "locale", value: "es-CL" });
  expect(locale).not.toBe(base);
  expect(locale.values.locale).toBe("es-CL");

  const platforms = reducer(base, { type: "set", field: "platforms", value: ["opencode"] });
  expect(platforms).not.toBe(base);
  expect(platforms.values.platforms).toEqual(["opencode"]);

  const preset = reducer(base, { type: "set", field: "branchPreset", value: "custom" });
  expect(preset).not.toBe(base);
  expect(preset.values.branchPreset).toBe("custom");

  const vcs = reducer(base, { type: "set", field: "vcsProvider", value: "github" });
  expect(vcs).not.toBe(base);
  expect(vcs.values.vcsProvider).toBe("github");

  const apply = reducer(base, { type: "set", field: "applyProject", value: true });
  expect(apply).not.toBe(base);
  expect(apply.values.applyProject).toBe(true);

  const allowed = reducer(base, { type: "set", field: "branchAllowed", value: "feature/*" });
  expect(allowed).not.toBe(base);
  expect(allowed.values.branchAllowed).toBe("feature/*");
});

test("idle platform screen settles after a toggle (no update-depth loop)", async () => {
  const cleanup = withSeedConfig(seedConfig);
  const originalError = console.error;
  const errors: string[] = [];
  const commits: number[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  let tty: Awaited<ReturnType<typeof renderInk>> | undefined;
  try {
    tty = await renderInk(
      <React.Profiler id="wizard" onRender={() => commits.push(1)}>
        <Wizard onExit={noop} />
      </React.Profiler>,
    );
    await tty.key(SPACE); // toggle the first platform; deliberately no ENTER
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
    const settledCommits = commits.length;
    const settledErrors = errors.length;
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(commits.length).toBe(settledCommits);
    expect(errors.length).toBe(settledErrors);
    expect(errors.join("\n")).not.toContain("Maximum update depth exceeded");
  } finally {
    console.error = originalError;
    tty?.unmount();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Deterministic TTY tests
// ---------------------------------------------------------------------------

test("exactly one input control is mounted on every screen", async () => {
  await withNonGitRoot(async () => {
    const cleanup = withSeedConfig(seedConfig);
    try {
      const tty = await renderInk(<Wizard onExit={noop} />);
      // Ink tab-navigation listener + wizard nav handler + the screen control
      expect(tty.inputListenerCount()).toBe(3);
      await tty.keys(SPACE, ENTER); // platforms -> locale
      // SearchSelect owns its input handling; its display-only TextInput is
      // disabled and never subscribes, so the invariant holds unchanged
      expect(tty.inputListenerCount()).toBe(3);
      await tty.keys(ENTER); // locale -> timezone
      expect(tty.inputListenerCount()).toBe(3);
      await tty.keys(ENTER); // timezone -> branchPreset
      await tty.keys(DOWN, ENTER); // github-flow -> youtrack
      await tty.keys(ENTER); // youtrack -> vcs
      expect(tty.inputListenerCount()).toBe(3);
      await tty.keys(ENTER); // vcs -> workspaces
      // the workspaces screen renders real controls (WZ-12), not a placeholder
      expect(tty.lastFrame()).toContain("Add workspace");
      expect(tty.inputListenerCount()).toBe(3);
      await tty.keys(ENTER); // workspaces (Done highlighted) -> project
      await tty.keys("y"); // project -> summary
      expect(tty.inputListenerCount()).toBe(3);
      tty.unmount();
    } finally {
      cleanup();
    }
  });
});

test("locale and timezone inputs are independent; revisiting shows the current value", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    const localeFrame = tty.lastFrame();
    expect(localeFrame).toContain("Locale");
    expect(localeFrame).not.toContain("Timezone");

    await tty.keys("mx", ENTER); // search narrows to Español (México) -> commits es-MX
    const tzFrame = tty.lastFrame();
    expect(tzFrame).toContain("Timezone");
    expect(tzFrame).not.toContain("es-MX");

    // timezone search owns cold 'b'; clear the query to hand 'b' back to nav
    await tty.keys("b", BACKSPACE);
    await tty.key("b"); // back -> locale
    const backFrame = tty.lastFrame();
    expect(backFrame).toContain("es-MX");
    expect(backFrame).not.toContain("UTC");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("a custom Other value is validated before advancing", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("other", ENTER); // query isolates Other… -> custom text screen
    await tty.keys("en_US", ENTER); // invalid BCP-47
    const invalid = tty.lastFrame();
    expect(invalid).toContain("invalid locale");
    expect(invalid).toContain("custom");
    for (let i = 0; i < "en_US".length; i++) await tty.key(BACKSPACE);
    await tty.keys("es-MX", ENTER);
    expect(tty.lastFrame()).toContain("Timezone");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("branch policy screen shows the resolved policy, not the raw preset", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER, ENTER); // -> branchPreset
    const gitflow = tty.lastFrame();
    expect(gitflow).toContain("feature/*");
    expect(gitflow).toContain("main");
    await tty.keys(DOWN); // highlight github-flow
    const githubFlow = tty.lastFrame();
    expect(githubFlow).toContain("*");
    expect(githubFlow).not.toContain("feature/*");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("custom branch policy requires nonempty allowed and protected patterns", async () => {
  const cleanup = withSeedConfig({
    ...seedConfig,
    branchPolicy: { preset: "custom", allowed: [], protected: [] },
  });
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER, ENTER); // -> branchPreset (custom)
    await tty.keys(ENTER); // -> branchAllowed
    expect(tty.lastFrame()).toContain("Allowed branch patterns");
    await tty.keys(ENTER); // empty -> validation error
    expect(tty.lastFrame()).toContain("at least one allowed branch pattern");
    await tty.keys("feature/*", ENTER); // -> branchProtected
    expect(tty.lastFrame()).toContain("Protected branch names");
    await tty.keys(ENTER); // empty -> validation error
    expect(tty.lastFrame()).toContain("at least one protected branch name");
    await tty.keys("main", ENTER); // -> youtrack
    expect(tty.lastFrame()).toContain("YouTrack");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("Back preserves the draft values entered so far", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("mx", ENTER); // search narrows to Español (México) -> timezone
    await tty.keys(ENTER); // -> branchPreset
    await tty.keys(DOWN, ENTER); // github-flow -> youtrack
    await tty.keys(ENTER); // -> vcs
    await tty.keys(DOWN, ENTER); // github -> workspaces
    await tty.keys("b"); // back -> vcs
    expect(tty.lastFrame()).toContain("GitHub");
    await tty.keys("b"); // back -> youtrack
    await tty.keys(ESC); // back from a text screen -> branchPreset
    expect(tty.lastFrame()).toContain("GitHub Flow");
    await tty.keys("b"); // back -> timezone
    await tty.keys("b", BACKSPACE); // cold 'b' searches; clearing hands it back…
    await tty.key("b"); // …then navigates back -> locale
    expect(tty.lastFrame()).toContain("es-MX");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("Escape cancels without writing anything", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "workit-wiz-"));
  const configPath = path.join(base, "config");
  process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
  try {
    const exitCalls: boolean[] = [];
    const tty = await renderInk(<Wizard onExit={(complete) => exitCalls.push(complete)} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("mx", ENTER); // -> timezone (searched pick)
    await tty.keys(ESC); // cancel (select screen)
    expect(exitCalls).toEqual([false]);
    expect(existsSync(configPath)).toBe(false);
    tty.unmount();
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    rmSync(base, { recursive: true, force: true });
  }
});

test("no competing Enter/provider race — one submit path per screen", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER, ENTER, ENTER, ENTER); // -> vcs
    expect(tty.lastFrame()).toContain("Step 4");
    await tty.keys(DOWN, ENTER); // gitlab -> github, submit once
    expect(tty.lastFrame()).toContain("Workspaces");
    await tty.keys("b"); // back -> vcs
    expect(tty.lastFrame()).toContain("GitHub");
    await tty.keys(ENTER); // submit again -> workspaces
    expect(tty.lastFrame()).toContain("Workspaces");
    tty.unmount();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SelectList update mechanics (WZ-13): arrow keys must dispatch exactly one
// `set` per keypress — never from inside a setState updater, which React
// StrictMode double-invokes (double onChange) and which desyncs the highlight
// from the committed value.
// ---------------------------------------------------------------------------

const SPY_OPTIONS = [
  { label: "en", value: "en" },
  { label: "es-CL", value: "es-CL" },
  { label: "Other…", value: "other" },
];

// Host wiring identical to the locale screen: SelectList.onChange dispatches a
// real wizard `set` action through the real reducer; the wrapper records every
// dispatched action (outside any updater/reducer, so only genuine dispatches
// are counted).
function SpyHost({
  actions,
  selects,
}: {
  actions: { field: string; value: string }[];
  selects: string[];
}) {
  const [d, dispatch] = React.useReducer(reducer, undefined, () => at("gitflow", "locale"));
  return (
    <SelectList
      options={SPY_OPTIONS}
      value={d.values.locale === "" ? "other" : d.values.locale}
      onChange={(value) => {
        actions.push({ field: "locale", value });
        dispatch({ type: "set", field: "locale", value });
      }}
      onSelect={(value) => selects.push(value)}
    />
  );
}

test("one DOWN dispatches exactly one set for the moved-to option under StrictMode", async () => {
  const actions: { field: string; value: string }[] = [];
  const selects: string[] = [];
  const tty = await renderInk(
    <React.StrictMode>
      <SpyHost actions={actions} selects={selects} />
    </React.StrictMode>,
  );
  await tty.key(DOWN);
  expect(actions).toEqual([{ field: "locale", value: "es-CL" }]);
  expect(tty.lastFrame()).toContain("❯ es-CL");
  tty.unmount();
});

test("down,down,up then Enter submits exactly the highlighted option's value", async () => {
  const actions: { field: string; value: string }[] = [];
  const selects: string[] = [];
  const tty = await renderInk(
    <React.StrictMode>
      <SpyHost actions={actions} selects={selects} />
    </React.StrictMode>,
  );
  await tty.keys(DOWN, DOWN, UP, ENTER); // en -> es-CL -> other -> es-CL -> submit
  expect(selects).toEqual(["es-CL"]);
  expect(tty.lastFrame()).toContain("❯ es-CL");
  tty.unmount();
});

test("Ctrl+C cancels from a text screen instead of walking back (Task 12 advisory)", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const exitCalls: boolean[] = [];
    // exitOnCtrlC disabled so Ink hands \x03 to the wizard's handler — this is
    // the exact latent path the advisory flagged (Ink intercepts it by default).
    const tty = await renderInk(<Wizard onExit={(complete) => exitCalls.push(complete)} />, {
      exitOnCtrlC: false,
    });
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("other", ENTER); // -> Other (text screen)
    await tty.key("\x03"); // ctrl+c must cancel, never walk back
    expect(exitCalls).toEqual([false]);
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("backspace-to-empty custom locale surfaces the block on the select screen", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("other", ENTER); // -> Other
    await tty.keys("en_US"); // invalid BCP-47 stored while editing
    for (let i = 0; i < "en_US".length; i++) await tty.key(BACKSPACE);
    await tty.keys(ESC); // back -> locale select, value now ""
    // the parent select screen must surface the block (the empty current value
    // and the validation error) instead of letting Enter commit an empty locale
    const frame = tty.lastFrame();
    expect(frame).toContain("Current:");
    expect(frame).toContain("invalid locale");
    expect(frame).not.toContain("Timezone");
    tty.unmount();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Locale SearchSelect (Task 3): query narrowing, navigation within the
// filtered set, and Other… routing into the existing validated custom flow.
// ---------------------------------------------------------------------------

test("typing narrows the locale picker's visible rows", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    const full = tty.lastFrame();
    expect(full).toContain("Español (España)");
    expect(full).toContain("Español (Argentina)");
    await tty.keys("chile");
    const narrowed = tty.lastFrame();
    expect(narrowed).toContain("chile"); // the live query
    expect(narrowed).toContain("Español (Chile)");
    expect(narrowed).not.toContain("Argentina");
    expect(narrowed).not.toContain("Timezone");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("arrows move within the filtered set and Enter commits the highlighted row", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("es"); // the five Español rows
    await tty.keys(DOWN, DOWN); // highlight Español (Chile)
    expect(tty.lastFrame()).toContain("❯ Español (Chile)");
    await tty.key(ENTER);
    expect(tty.lastFrame()).toContain("Timezone");
    // timezone search owns cold 'b'; clear the query to hand 'b' back to nav
    await tty.keys("b", BACKSPACE);
    await tty.key("b"); // back -> the select screen shows the committed value
    expect(tty.lastFrame()).toContain("Current: es-CL");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("'Other…' routes to the existing validated custom-locale flow (CA-03)", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys("other", ENTER); // query isolates Other… -> pickOther flow
    expect(tty.lastFrame()).toContain("custom");
    await tty.keys("es-419", ENTER); // 3-digit region subtag validates via LOCALE_RE
    expect(tty.lastFrame()).toContain("Timezone");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("'b' starts a search instead of walking back; once cleared it navigates back", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.key("b"); // first search character must reach the query
    const searching = tty.lastFrame();
    expect(searching).toContain("Locale"); // still the picker…
    expect(searching).not.toContain("Platforms"); // …never walked back
    expect(searching).toContain("Português (Brasil)"); // 'b' filtered set
    expect(searching).not.toContain("Español (España)");
    await tty.key("b"); // live query keeps consuming 'b'
    expect(tty.lastFrame()).toContain("Locale");
    for (let i = 0; i < 2; i++) await tty.key(BACKSPACE); // clear the query
    expect(tty.lastFrame()).toContain("Español (España)"); // full list restored
    await tty.key("b"); // cleared search hands 'b' back to navigation
    expect(tty.lastFrame()).toContain("Step 1 — Platforms");
    tty.unmount();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Timezone SearchSelect (Task 4): full IANA catalog with the detected host
// zone preselected; identical consumed-'b' semantics as locale (the wizard's
// global back handler would otherwise eat the first query character).
// ---------------------------------------------------------------------------

const detectedTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

test("the detected zone is preselected without typing", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys(ENTER); // commit highlighted locale -> timezone
    const frame = tty.lastFrame();
    expect(frame).toContain("Timezone");
    expect(frame).toContain("Type to filter"); // searchable picker mounted
    expect(frame).toContain(`❯ ${detectedTz()}`); // preselected, zero typing
    expect(frame).not.toContain("Use current"); // fixed SelectList gone
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("typing narrows the timezone picker and Enter commits the searched zone", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER); // -> timezone
    await tty.keys("santiago");
    const narrowed = tty.lastFrame();
    expect(narrowed).toContain("America/Santiago");
    expect(narrowed).not.toContain("Europe/London");
    await tty.key(ENTER); // commit America/Santiago -> branchPreset
    expect(tty.lastFrame()).toContain("Branch policy");
    await tty.keys("b"); // back -> the picker shows the committed draft value
    expect(tty.lastFrame()).toContain("Current: America/Santiago");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("'b' starts a timezone search instead of walking back; once cleared it navigates back", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER); // -> timezone
    await tty.key("b"); // cold 'b' must reach the query, never walk back
    const searching = tty.lastFrame();
    expect(searching).toContain("Timezone"); // still the picker…
    expect(searching).not.toContain("Locale"); // …never walked back
    expect(searching).not.toContain("Type to search timezones…"); // live query owns the field
    await tty.key("b"); // live query keeps consuming 'b'
    expect(tty.lastFrame()).not.toContain("Type to search timezones…");
    for (let i = 0; i < 2; i++) await tty.key(BACKSPACE); // clear the query
    const restored = tty.lastFrame();
    expect(restored).toContain("Type to search timezones…"); // full window restored…
    expect(restored).toContain(`❯ ${detectedTz()}`); // …detected zone re-highlighted
    await tty.key("b"); // cleared search hands 'b' back to navigation
    expect(tty.lastFrame()).toContain("Locale");
    tty.unmount();
  } finally {
    cleanup();
  }
});

test("'Other…' keeps the validated custom-timezone flow (CA-04)", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER, ENTER); // -> timezone
    // DOWN isolates Other… ("other" also substring-matches Antarctica/Rothera)
    await tty.keys("other", DOWN, ENTER);
    expect(tty.lastFrame()).toContain("custom");
    await tty.keys("Not/AZone", ENTER); // validateTimezone blocks unknown names
    const invalid = tty.lastFrame();
    expect(invalid).toContain("unknown timezone");
    expect(invalid).toContain("custom");
    for (let i = 0; i < "Not/AZone".length; i++) await tty.key(BACKSPACE);
    await tty.keys("Europe/Madrid", ENTER);
    expect(tty.lastFrame()).toContain("Branch policy");
    tty.unmount();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Apply preview (Task 13: WZ-08 preview is authoritative, WZ-06 malformed
// state blocks Apply, WZ-04 integrations are optional)
// ---------------------------------------------------------------------------

test("summary shows the authoritative preview and Apply completes with it", async () => {
  await withNonGitRoot(async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "workit-wiz-"));
    const configPath = path.join(base, "config");
    process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
    process.env.WORKFLOW_YT_BASE_URL = "https://env.example.com";
    try {
      mkdirSync(configPath, { recursive: true });
      writeFileSync(path.join(configPath, "config.json"), JSON.stringify(seedConfig), "utf8");
      writeFileSync(
        path.join(configPath, "workspaces.json"),
        JSON.stringify({
          workspaces: [{ name: "work", glob: "/work/**", vcs: { provider: "gitlab" } }],
        }),
        "utf8",
      );
      const exitCalls: boolean[] = [];
      const tty = await renderInk(<Wizard onExit={(ok) => exitCalls.push(ok)} />);
      await tty.keys(SPACE, ENTER); // -> locale
      await tty.keys(ENTER); // -> timezone
      await tty.keys(ENTER); // -> branchPreset
      await tty.keys(ENTER); // -> youtrack
      await tty.keys("https://yt.example.com", ENTER); // -> vcs
      await tty.keys(ENTER); // -> workspaces
      // the workspaces screen is a real menu (not a placeholder): edit the seeded
      // entry so the preview carries a workspace rewrite (Task 15 parity — an
      // untouched draft claims no rewrite).
      expect(tty.lastFrame()).toContain("Edit work");
      await tty.keys(UP, UP, UP, UP, ENTER); // Edit work
      await tty.keys(ENTER); // keep the name
      for (let i = 0; i < "/work/**".length; i++) await tty.key(BACKSPACE);
      await tty.keys("/other/**", ENTER); // changed glob -> provider
      await tty.keys(ENTER); // provider -> save -> menu (Done highlighted)
      await tty.keys(ENTER); // Done -> project
      await tty.keys("y"); // -> summary

      const frame = tty.lastFrame();
      expect(frame).toContain("Will apply");
      expect(frame).toContain("config.json");
      expect(frame).toContain("youtrack.json");
      expect(frame).toContain("workspaces.json");
      expect(frame).toContain("https://yt.example.com");
      expect(frame).toContain("WORKFLOW_YT_BASE_URL"); // active override exposed
      expect(frame).toContain("https://env.example.com"); // ...with its actual value

      await tty.keys("y"); // apply
      expect(exitCalls).toEqual([true]);
      tty.unmount();
    } finally {
      delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      delete process.env.WORKFLOW_YT_BASE_URL;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test("malformed configuration blocks Apply in the TTY flow (WZ-06)", async () => {
  await withNonGitRoot(async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "workit-wiz-"));
    const configPath = path.join(base, "config");
    process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
    try {
      mkdirSync(configPath, { recursive: true });
      writeFileSync(path.join(configPath, "config.json"), JSON.stringify(seedConfig), "utf8");
      writeFileSync(path.join(configPath, "youtrack.json"), "{ not json", "utf8");
      const exitCalls: boolean[] = [];
      const tty = await renderInk(<Wizard onExit={(ok) => exitCalls.push(ok)} />);
      await tty.keys(SPACE, ENTER); // -> locale
      await tty.keys(ENTER); // -> timezone
      await tty.keys(ENTER); // -> branchPreset
      await tty.keys(ENTER); // -> youtrack
      await tty.keys(ENTER); // -> vcs
      await tty.keys(ENTER); // -> workspaces
      await tty.keys(ENTER); // -> project
      await tty.keys("y"); // -> summary

      const frame = tty.lastFrame();
      expect(frame).toContain("Apply blocked");
      expect(frame).toContain("youtrack.json");
      expect(frame).not.toContain("Will apply");

      await tty.keys("y"); // ignored: no confirm control, never completes
      expect(exitCalls).toEqual([]);
      tty.unmount();
    } finally {
      delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
