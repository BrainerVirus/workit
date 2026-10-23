import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";

// Issue #297: the plugin turns OpenCode's `ask` into `allow` for Workit's
// enumerated delivery verbs only; a config `deny` and every other command keep
// the host's own decision.
const root = mkdtempSync(path.join(tmpdir(), "workit-oc-allow-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const evaluate = (command: string, effect: string, action = "shell") => {
  const event = {
    sessionID: "s1",
    action,
    resources: [command],
    effect,
    message: undefined,
  };
  evaluateShellPermission(root, event);
  return event.effect;
};

test("Given an ask for `workit pr merge`, When the plugin evaluates it, Then it becomes allow", () => {
  expect(evaluate("workit pr merge --pr 7 --method squash", "ask")).toBe("allow");
});

test.each([
  ["workit git push --force-with-lease"],
  ["workit --cwd /tmp/wt git commit -m 'feat: x' -- a.ts"],
  ["workit --json pr status"],
  ["workit ledger verdict verified --how 'ran it'"],
  ["workit --version"],
  ["workit pr merge --reason x '$F'"],
])("Given an ask for the delivery call `%s`, Then it becomes allow", (command) => {
  expect(evaluate(command, "ask")).toBe("allow");
});

test.each([
  ["workit check -- rm -rf x"],
  ["workit lock run -- rm -rf x"],
  ["workit grant set work merge=true"],
  ["workit pr merge --unverified --reason now"],
  ["workit pr merge --reason x ${F:---unverified}"],
  ["workit pr merge --reason x --unverifie?"],
  ['workit pr merge --reason x "$F"'],
  ["workit pr merge --reason x --unver$(echo ified)"],
  ['workit pr create --body-file "$F"'],
  ["workit stack land --unverified --reason now"],
  ["workit --session x git commit -m m -- a"],
  ["workit pr status && rm -rf x"],
  ["workit pr status > out.txt"],
  ['workit pr create --body "$(cat /etc/passwd)"'],
  ["workit gc --prune-recovery --yes"],
  ["workit"],
])("Given an ask for `%s`, When the plugin evaluates it, Then it stays ask", (command) => {
  expect(evaluate(command, "ask")).toBe("ask");
});

test("Given a config deny for `workit pr merge`, When the plugin evaluates it, Then deny stands", () => {
  expect(evaluate("workit pr merge --pr 7", "deny")).toBe("deny");
});

test("Given an ask for a non-shell action, When the plugin evaluates it, Then it stays ask", () => {
  expect(evaluate("workit pr merge", "ask", "webfetch")).toBe("ask");
});
