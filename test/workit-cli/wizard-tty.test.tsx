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

// ---------------------------------------------------------------------------
// Deterministic TTY tests
// ---------------------------------------------------------------------------

test("exactly one input control is mounted on every screen", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  await tty.keys(ENTER); // workspaces -> project
  await tty.keys("y"); // project -> summary
  expect(tty.inputListenerCount()).toBe(3);
  tty.unmount();
  cleanup();
});

test("locale and timezone inputs are independent; revisiting shows the current value", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  cleanup();
});

test("a custom Other value is validated before advancing", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  cleanup();
});

test("branch policy screen shows the resolved policy, not the raw preset", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  cleanup();
});

test("custom branch policy requires nonempty allowed and protected patterns", async () => {
  const cleanup = withSeedConfig({
    ...seedConfig,
    branchPolicy: { preset: "custom", allowed: [], protected: [] },
  });
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
  cleanup();
});

test("Back preserves the draft values entered so far", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  cleanup();
});

test("Escape cancels without writing anything", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "workit-wiz-"));
  const configPath = path.join(base, "config");
  process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
  const exitCalls: boolean[] = [];
  const tty = await renderInk(<Wizard onExit={(complete) => exitCalls.push(complete)} />);
  await tty.keys(SPACE, ENTER); // -> locale
  await tty.keys(DOWN, DOWN, ENTER); // -> Other
  await tty.keys("es-MX", ENTER); // -> timezone
  await tty.keys(ESC); // cancel (select screen)
  expect(exitCalls).toEqual([false]);
  expect(existsSync(configPath)).toBe(false);
  tty.unmount();
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  rmSync(base, { recursive: true, force: true });
});

test("no competing Enter/provider race — one submit path per screen", async () => {
  const cleanup = withSeedConfig(seedConfig);
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
  cleanup();
});
