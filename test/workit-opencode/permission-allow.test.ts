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
  ['workit git commit --cwd "$wt" -m x'],
  ["workit pr merge --cwd $wt"],
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

// Only the user runs these (#615, round 2): even when the user's config allows
// bash outright, the plugin turns the allow into an ask naming the call.
test.each([
  ["workit setup --yes", "setup"],
  ["env -u CLAUDECODE workit setup --yes", "setup"],
  ["AI_AGENT=1 workit uninstall --hosts=cursor --yes", "uninstall"],
  ["command workit install --hosts=cursor --yes", "install"],
  ["cd x && workit workspace seal", "workspace seal"],
  ["workit --cwd /x --json grant set ws merge=true", "grant set"],
  ["workit --json ledger void mwbe83fk --reason x", "ledger void"],
  ["workit gr\\\nant set a b=c", "grant set"],
  ["work\\\nit setup --yes", "setup"],
  ["workit s$'e'tup --yes", "setup"],
])(
  "Given a config allow for `%s`, When the plugin evaluates it, Then it asks naming the call",
  (command, words) => {
    for (const effect of ["allow", "ask"]) {
      const event = { sessionID: "s1", action: "shell", resources: [command], effect, message: "" };
      evaluateShellPermission(root, event);
      expect(event.effect, effect).toBe("ask");
      expect(event.message).toContain(`\`workit ${words}\``);
    }
  },
);

test.each([["workit help setup"], ["workit check -- npm install"], ['echo "workit setup"']])(
  "Given a config allow for `%s`, When the plugin evaluates it, Then the allow stands",
  (command) => {
    expect(evaluate(command, "allow")).toBe("allow");
  },
);

test("Given a config deny for `workit setup`, When the plugin evaluates it, Then deny stands", () => {
  expect(evaluate("workit setup --yes", "deny")).toBe("deny");
});
