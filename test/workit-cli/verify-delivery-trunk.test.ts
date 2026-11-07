import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeStackForge, type StackForge } from "@/test/shared/helpers/stack-forge";

// #752: PR 12 merged into feature/a after feature/a had squash-merged into
// main (PR 11), and `verify-delivery merge` said delivered because it only
// checked the merge commit against the PR's own base. A merge into a branch
// that already landed is delivered only when the change reaches that trunk.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-verify-trunk-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const forges: StackForge[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const forge of forges.splice(0)) forge.cleanup();
});

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const setup = (kind: "github" | "gitlab", branches = ["feature/a", "feature/b"]) => {
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
        },
      ],
    }),
  );
  Object.assign(forgeDeps, { runner: forge.runner, sleep: async () => {}, now: () => 0 });
  forge.git("switch", "-q", branches[1]);
  return forge;
};

/**
 * Squash-merge `pr` and keep reporting its head at the merge, as the forge
 * does for a merged PR (the fake reads the branch tip, which later merges
 * into the kept branch move).
 */
const mergeFrozen = (forge: StackForge, pr: number): string => {
  const head = forge.tip(forge.prs.get(pr)?.branch as string) as string;
  const merged = forge.mergeExternally(pr);
  const inner = forge.runner;
  forgeDeps.runner = (bin, args, options) => {
    const result = inner(bin, args, options);
    const github = bin === "gh" && args.includes(`number=${pr}`);
    const gitlab = bin === "glab" && args.some((arg) => arg.endsWith(`/merge_requests/${pr}`));
    if (!github && !gitlab) return result;
    const doc = JSON.parse(result.stdout);
    if (github) doc.data.repository.pullRequest.headRefOid = head;
    else doc.sha = head;
    return { ...result, stdout: JSON.stringify(doc) };
  };
  return merged;
};

/** The `pr.merged` row `pr merge` writes, with the merge commit it got back. */
const recordMerge = (forge: StackForge, pr: number, base: string, mergeSha: string) => {
  const row = appendObserved(forge.cwd, {
    type: "pr.merged",
    actor: actorFromEnv({ WORKIT_SESSION_ID: "author-1" }),
    branch: "feature/b",
    pr,
    base,
    mergeSha,
    what: `merged #${pr}`,
  });
  expect(row.ok).toBe(true);
};

for (const kind of ["github", "gitlab"] as const)
  test(`verify-delivery merge (${kind}, #752): given PR 12 merged into feature/a after feature/a squash-merged into main, then it is NOT delivered (exit 1) and names main`, async () => {
    const forge = setup(kind);
    mergeFrozen(forge, 11);
    recordMerge(forge, 12, "feature/a", forge.mergeExternally(12));

    const result = await run(["verify-delivery", "merge", "--pr", "12", "--json"], forge.cwd);
    expect(result.code, result.stdout).toBe(1);
    const envelope = result.json();
    expect(envelope.error).toContain(
      `feature/a already landed on main (${kind === "github" ? "PR #" : "MR !"}11)`,
    );
    expect(envelope.error).toContain("not reachable from main");
    expect(envelope.data).toMatchObject({ delivered: false, trunk: "main" });
    expect(envelope.data.observations).toContainEqual(
      expect.objectContaining({ kind: "merge_on_base", ok: true }),
    );
    expect(envelope.data.observations).toContainEqual(
      expect.objectContaining({ kind: "merge_on_trunk", ok: false }),
    );
    expect(envelope.unblock).toContain("main");

    const human = await run(["verify-delivery", "merge", "--pr", "12"], forge.cwd);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("merged: NOT delivered");
  });

test("verify-delivery merge (#752): given a PR merged externally into a landed branch (no recorded merge commit), then it is NOT delivered", async () => {
  const forge = setup("github");
  mergeFrozen(forge, 11);
  forge.mergeExternally(12);
  const result = await run(["verify-delivery", "merge", "--pr", "12", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(1);
  expect(result.json().data).toMatchObject({ delivered: false, trunk: "main" });
});

test("verify-delivery merge (#752): given PR 12 merged into feature/a before feature/a landed on main, then the change reached main with it and it is delivered", async () => {
  const forge = setup("github");
  recordMerge(forge, 12, "feature/a", forge.mergeExternally(12));
  mergeFrozen(forge, 11);
  const result = await run(["verify-delivery", "merge", "--pr", "12", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ delivered: true, trunk: "main" });
});

test("verify-delivery merge (#752): given PR 11 merged into main, then it is delivered and its trunk is its base", async () => {
  const forge = setup("github");
  recordMerge(forge, 11, "main", forge.mergeExternally(11));
  const result = await run(["verify-delivery", "merge", "--pr", "11", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.delivered).toBe(true);
});

test("verify-delivery merge (#752 review): given staging was promoted to main through PR 11, then a feature PR merged into the long-lived staging afterwards is delivered on staging", async () => {
  const forge = setup("github", ["staging", "feature/y"]);
  mergeFrozen(forge, 11);
  recordMerge(forge, 12, "staging", forge.mergeExternally(12));
  const result = await run(["verify-delivery", "merge", "--pr", "12", "--json"], forge.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ delivered: true, trunk: "staging" });
});
