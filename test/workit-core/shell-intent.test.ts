import { expect, test } from "bun:test";
import { shellWriteIntent } from "@/packages/workit-core/src/core/shell-intent";

// The `install` token covers every package manager uniformly — no per-manager
// list can go stale. Non-install verbs live in one small documented table.
test("install-token managers share one generic rule", () => {
  for (const command of [
    "npm install left-pad",
    "pip install requests",
    "cargo install ripgrep",
    "go install ./...",
    "dotnet --version",
  ]) {
    const parsed = shellWriteIntent(command);
    if (command === "dotnet --version") {
      expect(parsed, command).toEqual({ intent: false, invalid: false, values: [] });
    } else {
      expect(parsed.intent, command).toBe(true);
      expect(parsed.invalid, command).toBe(false);
      expect(parsed.values.length, command).toBeGreaterThan(0);
    }
  }
  // Bare installs with no operands cannot be scoped: deny, don't allow.
  expect(shellWriteIntent("npm install")).toMatchObject({ intent: true, invalid: true });
});

test("non-install manager verbs are covered by the exception table", () => {
  expect(shellWriteIntent("dotnet add package Foo").intent).toBe(true);
  expect(shellWriteIntent("composer require vendor/pkg").intent).toBe(true);
  expect(shellWriteIntent("poetry add requests").intent).toBe(true);
  expect(shellWriteIntent("cargo add serde").intent).toBe(true);
  expect(shellWriteIntent("go get example.com/mod").intent).toBe(true);
  expect(shellWriteIntent("npm ci").intent).toBe(true);
});

test("git clean and restore raise intent; dry runs and checkout do not", () => {
  expect(shellWriteIntent("git clean -fdx").intent).toBe(true);
  expect(shellWriteIntent("git restore src/a.ts").values).toContain("src/a.ts");
  expect(shellWriteIntent("git clean -n")).toEqual({ intent: false, invalid: false, values: [] });
  // Branch switches are routine workflow and lexically indistinguishable
  // from path restores — deliberately out of scope.
  expect(shellWriteIntent("git checkout main")).toEqual({
    intent: false,
    invalid: false,
    values: [],
  });
  expect(shellWriteIntent("git add src/a.ts")).toEqual({
    intent: false,
    invalid: false,
    values: [],
  });
});

test("quoted mentions never raise intent; unparseable writes deny", () => {
  expect(shellWriteIntent('echo "rm -rf /"')).toEqual({
    intent: false,
    invalid: false,
    values: [],
  });
  expect(shellWriteIntent('git commit -m "rm old api"')).toEqual({
    intent: false,
    invalid: false,
    values: [],
  });
  expect(shellWriteIntent("mkdir a && mkdir b")).toMatchObject({ intent: true, invalid: true });
  expect(shellWriteIntent("")).toEqual({ intent: false, invalid: false, values: [] });
});
