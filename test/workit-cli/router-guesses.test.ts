import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { VERB_GUESSES, findVerb } from "@/packages/workit-cli/src/verbs/registry";

// W2.9: the verbs agents guess most (`workit commit`, `workit switch`,
// `workit check list`, `workit context`) answer with the command that does
// the job; other near misses get the closest real verb.

const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-router-guesses-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = async (argv: string[], cwd?: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    ...(cwd ? { cwd } : {}),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test.each([
  [["commit", "-m", "x"], "did you mean workit git commit?"],
  [["push"], "did you mean workit git push?"],
  [["switch", "main"], "workit git branch <name> creates a branch and switches to it"],
  [["checkout", "-b", "x"], "git switch <branch> moves to an existing one"],
  [["add", "file.ts"], "did you mean workit git stage <paths…>?"],
  [["merge"], "did you mean workit pr merge?"],
  [["context"], "workit handoff"],
])("Given workit %p, When it runs, Then the unblock names the real command", async (argv, hint) => {
  const result = await run([...argv, "--json"]);
  expect(result.code).toBe(2);
  expect(result.json()).toMatchObject({
    code: "invalid_input",
    error: `unknown command "${argv[0]}"`,
  });
  expect(result.json().unblock).toContain(hint);
});

test("Given an unknown verb one edit from a real one, When it runs, Then the closest verb is suggested", async () => {
  for (const [typo, verb] of [
    ["grnat", "grant"],
    ["hanoff", "handoff"],
    ["confg", "config"],
  ]) {
    const result = await run([typo]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`did you mean workit ${verb}?`);
  }
});

test("Given the guess table, Then no guess shadows a real verb", () => {
  for (const guess of Object.keys(VERB_GUESSES)) expect(findVerb(guess)).toBeUndefined();
});

test("Given workit check list in a repo with configured checks, When it runs, Then it lists the configured names", async () => {
  const repo = path.join(scratch, "repo");
  mkdirSync(path.join(repo, ".workit"), { recursive: true });
  writeFileSync(
    path.join(repo, ".workit", "checks.json"),
    JSON.stringify({ checks: { lint: "true", test: "true" } }),
  );
  const result = await run(["check", "list", "--json"], repo);
  expect(result.code).not.toBe(0);
  expect(result.json()).toMatchObject({
    code: "not_found",
    error: 'no configured check named "list"',
    unblock: "workit check lint|test",
  });
});

test.each([
  [["git", "pull"], 'unknown git subcommand "pull"', "workit git rebase"],
  [["git", "merge", "main"], 'unknown git subcommand "merge"', "workit git rebase"],
  [["git", "checkout", "x"], 'unknown git subcommand "checkout"', "workit git branch <name>"],
  [["git", "status", "--short"], 'unknown git subcommand "status"', "workit handoff"],
  [["ci", "wait", "--ref", "main"], "unknown option --ref", "workit ci wait --branch <branch>"],
  [
    ["task", "list", "--limit", "5"],
    "unknown option --limit",
    "workit task list prints every task",
  ],
  [["help", "review"], 'unknown command "review"', "workit ledger verdict"],
])(
  "Given workit %p, When it runs, Then the unblock names the working command",
  async (argv, error, hint) => {
    const result = await run([...argv, "--json"]);
    expect(result.code).toBe(2);
    expect(result.json().error).toBe(error);
    expect(result.json().unblock).toContain(hint);
  },
);

test("Given workit git push origin <branch>, When it runs, Then the error names workit git push", async () => {
  const result = await run(["git", "push", "origin", "feature/x", "--json"], scratch);
  expect(result.code).toBe(2);
  expect(result.json().error).toContain("workit git push [-u]");
});
