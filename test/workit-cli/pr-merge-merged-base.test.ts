import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { mergeGateDeps } from "@/packages/workit-core/src/forge/report";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeStackForge, type StackForge } from "@/test/shared/helpers/stack-forge";

// #752: PR B based on PR A's branch was merged into A's branch after A had
// squash-merged into main with its branch kept, so B's change never reached
// main. `pr merge` refuses a PR whose base already landed and prints the
// retarget command. Real git (a bare remote); the gh/glab fake squashes there.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const originalGate = { ...mergeGateDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-merged-base-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const forges: StackForge[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  Object.assign(mergeGateDeps, originalGate);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const forge of forges.splice(0)) forge.cleanup();
});

const run = async (argv: string[], cwd: string, session = "author-1") => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** PR 11 feature/a -> main and PR 12 feature/b -> feature/a (or `branches`); the child verified by another session. */
const setup = async (kind: "github" | "gitlab", branches = ["feature/a", "feature/b"]) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const forge = makeStackForge(kind, branches);
  forges.push(forge);
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${forge.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: kind, account: "octo" },
          autonomy: { push: true, pr: true, merge: "verified" },
          verification: "self",
        },
      ],
    }),
  );
  Object.assign(forgeDeps, { runner: forge.runner, sleep: async () => {}, now: () => 0 });
  Object.assign(mergeGateDeps, { sleep: () => {} });
  forge.git("switch", "-q", branches[1]);
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised the CLI", "--branch", branches[1]],
    forge.cwd,
    "reviewer-2",
  );
  expect(verdict.code, verdict.stderr + verdict.stdout).toBe(0);
  return forge;
};

for (const kind of ["github", "gitlab"] as const)
  test(`pr merge (${kind}, #752): given PR 11 squash-merged into main with feature/a kept and PR 12 still based on feature/a, then the merge is refused (exit != 0) with the retarget command and nothing merges`, async () => {
    const forge = await setup(kind);
    forge.mergeExternally(11);
    const before = forge.tip("feature/a");

    const result = await run(["pr", "merge", "--pr", "12", "--keep-branch", "--json"], forge.cwd);
    expect(result.code, result.stdout).not.toBe(0);
    const envelope = result.json();
    expect(envelope.code).toBe("blocked");
    expect(envelope.error).toContain(
      `base_landed: feature/a already landed on main (${kind === "github" ? "PR #" : "MR !"}11)`,
    );
    expect(envelope.unblock).toContain("workit pr edit --pr 12 --base main");
    expect(envelope.data).toMatchObject({
      reason: "base_landed",
      base: "feature/a",
      landedOn: "main",
      landedPr: 11,
    });
    expect(forge.writes).toEqual(["merge 11 (external)"]);
    expect(forge.prs.get(12)?.state).toBe("open");
    expect(forge.tip("feature/a")).toBe(before);

    const human = await run(["pr", "merge", "--pr", "12", "--keep-branch"], forge.cwd);
    expect(human.code).not.toBe(0);
    expect(human.stdout + human.stderr).toContain("workit pr edit --pr 12 --base main");
  });

test("pr merge (#752): given the parent PR is still open, then a PR based on its branch merges into it as before", async () => {
  const forge = await setup("github");
  const result = await run(["pr", "merge", "--pr", "12", "--keep-branch", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ number: 12, base: "feature/a" });
  expect(forge.writes).toEqual(["merge 12"]);
});

test("pr merge (#752 review): given staging was promoted to main through PR 11 and is untouched since, then a feature PR into the long-lived staging merges (not base_landed)", async () => {
  const forge = await setup("github", ["staging", "feature/y"]);
  forge.mergeExternally(11);
  const result = await run(["pr", "merge", "--pr", "12", "--keep-branch", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ number: 12, base: "staging" });
  expect(forge.writes).toEqual(["merge 11 (external)", "merge 12"]);
});
