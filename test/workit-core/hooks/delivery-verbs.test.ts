import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isAllowedWorkitCall,
  mayRunUserOnly,
  USER_ONLY_WORD,
  userOnlyWorkitCall,
} from "@/packages/workit-core/src/hooks/delivery-verbs";

test("Given release notes approve or grant set/raise, When isAllowedWorkitCall sees them, Then it returns false", () => {
  expect(isAllowedWorkitCall(["workit", "release", "notes", "approve", "1.0.0"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "--cwd", "/w", "release", "notes", "approve", "1"])).toBe(
    false,
  );
  expect(isAllowedWorkitCall(["workit", "release", "--json", "notes", "approve"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "grant", "set", "ws", "merge"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "grant", "raise", "ws"])).toBe(false);
});

test("Given other release calls, When isAllowedWorkitCall sees them, Then they stay allowed", () => {
  expect(isAllowedWorkitCall(["workit", "release", "notes", "show", "1.0.0"])).toBe(true);
  expect(isAllowedWorkitCall(["workit", "release", "check"])).toBe(true);
  expect(isAllowedWorkitCall(["workit", "pr", "list", "--", "approve"])).toBe(true);
});

// The user-only gate's own first test (mayRunUserOnly), copied byte for byte
// into the Claude Code and Codex launchers: a call it misses never reaches the
// runtime, so every shape the gate decides must pass it.
const USER_ONLY_SHAPES = [
  "workit setup --yes",
  "env -u CLAUDECODE workit setup --yes",
  "AI_AGENT=1 workit uninstall --hosts=cursor --yes",
  "command workit install --hosts=cursor --yes",
  "cd x && workit workspace seal",
  "workit --cwd /x --json setup --preview",
  "workit --cwd=/x install --dry-run",
  'w"o"rkit grant set ws merge=true',
  "/usr/local/bin/workit-cli ledger void mwbe83fk --reason x",
  "workit approve ap_aaaaaaaa",
  "workit --json release notes approve 1.0.0",
];

test("G every user-only shape, W the gate and its first test read it, T the gate names the call and the test passes it", () => {
  for (const command of USER_ONLY_SHAPES) {
    expect(userOnlyWorkitCall(command), command).not.toBeNull();
    expect(mayRunUserOnly(command), command).toBe(true);
  }
});

test("G a help call, a call after `--` or a quoted mention, W the gate reads it, T it is not a user-only call", () => {
  for (const command of [
    "workit help setup",
    "workit check -- npm install",
    "workit check test -- workit setup",
    'echo "workit setup --yes"',
    'workit ledger decision "never run workit install here" --why x',
    "workit workspace show",
    "npm install",
  ])
    expect(userOnlyWorkitCall(command), command).toBeNull();
  // Without both words the gate never reads the segments.
  for (const command of ["npm install", "workit pr status", "ls setup"])
    expect(mayRunUserOnly(command), command).toBe(false);
});

test("G both launchers, W their sources are read, T each holds the gate's first test byte for byte", () => {
  const root = path.resolve(import.meta.dir, "../../..");
  for (const launcher of [
    "packages/workit-claude-code/bin/workit-hook.mjs",
    "packages/workit-codex/hooks/launcher.ts",
  ]) {
    const source = readFileSync(path.join(root, launcher), "utf8");
    expect(source, launcher).toContain(`const USER_ONLY_WORD = ${String(USER_ONLY_WORD)};`);
    expect(source, launcher).toContain(`const bare = text.replace(/['"\\\\]/g, "");`);
    expect(source, launcher).toContain(
      'return [bare, bare.replace(/`/g, "")].some(\n    (all) => /\\bworkit\\b/.test(all) && USER_ONLY_WORD.test(all),\n  );',
    );
  }
});
