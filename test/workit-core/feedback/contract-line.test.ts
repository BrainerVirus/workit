import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEEDBACK_LINE, invariantBootstrap } from "@/packages/workit-core/src/core/methods";
import { workspaceFeedback } from "@/packages/workit-core/src/core/workspaces";
import { configSchemaIssues } from "@/packages/workit-core/src/core/config-schemas";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";

// The `workit feedback` contract line and the workspace `feedback` setting (#777).

let configHome: ConfigHome;
let repo: string;
beforeAll(() => {
  configHome = useConfigHome("wk-feedback-contract-");
  repo = path.join(configHome.home, "src", "work", "app");
  mkdirSync(repo, { recursive: true });
});
afterAll(() => configHome.restore());
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const workspaces = (document: Record<string, unknown>) =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify(document));

const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;

test("Given no feedback setting, Then every host's contract carries the feedback line once", () => {
  for (const host of ["claude-code", "codex", "cursor"])
    expect(invariantBootstrap({ cwd: repo, host }).split(FEEDBACK_LINE)).toHaveLength(2);
  // OpenCode and Pi render it without a session.
  expect(invariantBootstrap()).toContain(FEEDBACK_LINE);
});

test('Given `feedback: "off"` on an enclosing workspace, Then the contract line is absent and the setting reads off', () => {
  workspaces({
    workspaces: [
      { name: "work", glob: glob(path.join(configHome.home, "src", "work")), feedback: "off" },
      { name: "app", glob: glob(repo) },
    ],
  });
  for (const host of ["claude-code", "codex", "cursor"]) {
    const contract = invariantBootstrap({ cwd: repo, host });
    expect(contract).not.toContain("workit feedback");
    expect(contract).toContain("Mid-task: never silently drop");
  }
  expect(workspaceFeedback(repo)).toEqual({ off: true, account: null, workspace: "app" });
});

test("Given a feedback account at the top level and on the workspace, Then the workspace's wins and the top level is the default", () => {
  workspaces({
    feedback: { account: "me-personal" },
    workspaces: [{ name: "app", glob: glob(repo) }],
  });
  expect(workspaceFeedback(repo).account).toBe("me-personal");
  workspaces({
    feedback: { account: "me-personal" },
    workspaces: [{ name: "app", glob: glob(repo), feedback: { account: "me-other" } }],
  });
  expect(workspaceFeedback(repo)).toEqual({ off: false, account: "me-other", workspace: "app" });
});

test("Given the editor schema, Then feedback takes on, off or an account and nothing else", () => {
  const file = (feedback: unknown) => ({ workspaces: [{ name: "a", glob: "/a/**", feedback }] });
  expect(configSchemaIssues("workspaces.json", file("off"))).toEqual([]);
  expect(configSchemaIssues("workspaces.json", file({ account: "me" }))).toEqual([]);
  expect(configSchemaIssues("workspaces.json", file("maybe"))).not.toEqual([]);
  expect(
    configSchemaIssues("workspaces.json", { feedback: { account: "me" }, workspaces: [] }),
  ).toEqual([]);
});
