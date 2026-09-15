import { expect, test } from "bun:test";
import { shellRouteIntent } from "@/packages/workit-core/src/core/route-intent";

test("direct branch creation routes to git.branch_setup", () => {
  for (const command of [
    "git switch -c feature/x",
    "git switch --create feature/x",
    "git checkout -b fix/y",
    "git checkout -B fix/y",
    "cd repo && git switch -c feature/x",
    'git switch -c "feature/x"',
    "FOO=bar git checkout -b fix/y",
  ]) {
    expect(shellRouteIntent(command), command).toMatchObject({ route: "git.branch_setup" });
  }
});

test("direct pull and merge request creation routes to hosting.pull_request", () => {
  for (const command of [
    "gh pr create --title t --body b",
    "glab mr create --title t",
    "git push -u origin feature/x && gh pr create --fill",
  ]) {
    expect(shellRouteIntent(command), command).toMatchObject({ route: "hosting.pull_request" });
  }
});

test("unrelated or unparseable commands stay explicitly unenforced", () => {
  for (const command of [
    "git commit -m x",
    "git switch main",
    "git checkout main",
    "git branch --show-current",
    "gh pr view 5",
    "glab mr list",
    "npm test",
    "echo 'git switch -c fake'",
    "git switch -c `echo feature`",
    'git switch -c "unclosed',
    "",
  ]) {
    expect(shellRouteIntent(command), command).toBeNull();
  }
});
