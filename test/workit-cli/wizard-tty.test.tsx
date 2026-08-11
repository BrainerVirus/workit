import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { Wizard } from "../../packages/workit-cli/src/steps";
import { renderInk } from "../shared/helpers/ink-tty";
import {
  createInitialDraft,
  reducer,
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

test("next advances through the sequential screens", () => {
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

test("back reverses through screens and skips custom branch screens when not custom", () => {
  let d = at("gitflow", "youtrack");
  expect(reducer(d, { type: "back" }).screen).toBe("branchPreset");
  d = at("gitflow", "summary");
  d = reducer(d, { type: "back" });
  d = reducer(d, { type: "back" });
  expect(d.screen).toBe("workspaces");
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
// Deterministic TTY tests
// ---------------------------------------------------------------------------

test("exactly one input control is mounted on every screen", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    // Ink tab-navigation listener + wizard nav handler + the screen control
    expect(tty.inputListenerCount()).toBe(3);
    await tty.keys(SPACE, ENTER); // platforms -> locale
    expect(tty.inputListenerCount()).toBe(3);
    await tty.keys(ENTER); // locale -> timezone
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

test("locale and timezone inputs are independent; revisiting shows the current value", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const tty = await renderInk(<Wizard onExit={noop} />);
    await tty.keys(SPACE, ENTER); // -> locale
    const localeFrame = tty.lastFrame();
    expect(localeFrame).toContain("Locale");
    expect(localeFrame).not.toContain("Timezone");

    await tty.keys(DOWN, DOWN, ENTER); // en -> es-CL -> Other
    await tty.keys("es-MX", ENTER); // -> timezone
    const tzFrame = tty.lastFrame();
    expect(tzFrame).toContain("Timezone");
    expect(tzFrame).not.toContain("es-MX");

    await tty.keys("b"); // back -> locale
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
    await tty.keys(DOWN, DOWN, ENTER); // -> Other
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
    await tty.keys(DOWN, DOWN, ENTER); // -> Other
    await tty.keys("es-MX", ENTER); // -> timezone
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
    await tty.keys("b"); // back -> locale
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
    await tty.keys(DOWN, DOWN, ENTER); // -> Other
    await tty.keys("es-MX", ENTER); // -> timezone
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

test("Ctrl+C cancels from a text screen instead of walking back (Task 12 advisory)", async () => {
  const cleanup = withSeedConfig(seedConfig);
  try {
    const exitCalls: boolean[] = [];
    // exitOnCtrlC disabled so Ink hands \x03 to the wizard's handler — this is
    // the exact latent path the advisory flagged (Ink intercepts it by default).
    const tty = await renderInk(
      <Wizard onExit={(complete) => exitCalls.push(complete)} />,
      { exitOnCtrlC: false },
    );
    await tty.keys(SPACE, ENTER); // -> locale
    await tty.keys(DOWN, DOWN, ENTER); // -> Other (text screen)
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
    await tty.keys(DOWN, DOWN, ENTER); // -> Other
    await tty.keys("en_US"); // invalid BCP-47 stored while editing
    for (let i = 0; i < "en_US".length; i++) await tty.key(BACKSPACE);
    await tty.keys(ESC); // back -> locale select, value now ""
    // the parent select screen must surface the block (and the empty "Use
    // current ()" option) instead of letting Enter commit an empty locale
    const frame = tty.lastFrame();
    expect(frame).toContain("Use current ()");
    expect(frame).toContain("invalid locale");
    expect(frame).not.toContain("Timezone");
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

test("malformed configuration blocks Apply in the TTY flow (WZ-06)", async () => {
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
