import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #333: under `verification: proportional` (the default) the merge gate reads
// the PR's review lane: none merges without a verdict, self takes the
// author's own `--self` verdict, focused and full need a non-author one.
// `self` and `independent` keep the non-author gate.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-lane-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
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

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

/**
 * A READY PR whose feature/x commit holds exactly `files` (the fixture's
 * feature.txt replaced), under a workspace granting `merge: verified`.
 */
const setup = (
  files: Record<string, string>,
  entry: Record<string, unknown> = {},
  openStatus = "github/pr-passing.json",
  options: { stayOpen?: boolean } = {},
) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("rm", "-q", "feature.txt");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, file), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "--amend", "-m", "feature");
  const head = repo.git("rev-parse", "HEAD");
  repo.subs["{{HEAD}}"] = head;
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () => fixture(merged ? "github/pr-merged.json" : openStatus),
    "PUT repos/o/r/pulls/12/merge": () => {
      // stayOpen: the forge accepts the merge but the PR stays open (a merge queue).
      merged = !options.stayOpen;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: "verified" },
          deleteBranch: false,
          ...entry,
        },
      ],
    }),
  );
  return { repo, runner, head };
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

const DOCS = { "README.md": "# Feature\n\nHow to use it.\n" };
const SMALL = { "src/feature.ts": "export const feature = 1;\n" };
const RISKY = { "src/hooks/guard.ts": "export const guard = true;\n" };

const selfVerdict = async (repo: ForgeRepo) =>
  expect(
    (await run(["ledger", "verdict", "tests-verified", "--self", "--how", "bun test"], repo.cwd))
      .code,
  ).toBe(0);
const independentVerdict = async (repo: ForgeRepo) =>
  expect(
    (await run(["ledger", "verdict", "verified", "--how", "exercised it"], repo.cwd, "reviewer-2"))
      .code,
  ).toBe(0);

test("proportional default: given a docs-only PR, when merging, then no verdict is required (lane none)", async () => {
  const { repo, runner, head } = setup(DOCS);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    head,
    verdict: { required: false, lane: "none", need: "none", verification: "proportional" },
  });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("proportional default: given a small low-risk behavior change, then the author's --self verdict satisfies the gate (lane self)", async () => {
  const { repo, runner } = setup(SMALL);
  const none = await run(["pr", "merge", "--json"], repo.cwd);
  expect(none.code).toBe(3);
  expect(none.json()).toMatchObject({
    data: { reason: "needs_verdict", verdict: { lane: "self" } },
  });
  expect(none.json().error).toContain("the author's own --self verdict is enough");
  expect(none.json().unblock).toContain("workit ledger verdict tests-verified --self");
  await selfVerdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.verdict).toMatchObject({
    required: true,
    accepted: false,
    review: "self-reviewed",
    lane: "self",
    need: "self",
  });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("proportional default: given a change touching a risk path, then the lane is full and only a non-author verdict merges", async () => {
  const { repo, runner } = setup(RISKY);
  await selfVerdict(repo);
  const self = await run(["pr", "merge", "--json"], repo.cwd);
  expect(self.code).toBe(3);
  expect(self.json().error).toContain("NEEDS_VERDICT");
  expect(self.json().error).toContain("lane full (touches a risk path: src/hooks/guard.ts)");
  expect(merges(runner.calls)).toEqual([]);
  await independentVerdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.verdict).toMatchObject({
    required: true,
    accepted: true,
    review: "verified",
    lane: "full",
  });
});

test("verification: self keeps the non-author merge gate: a docs-only PR or a --self verdict does not merge", async () => {
  const docs = setup(DOCS, { verification: "self" });
  const none = await run(["pr", "merge", "--json"], docs.repo.cwd);
  expect(none.code).toBe(3);
  expect(none.json().error).toStartWith(
    `NEEDS_VERDICT: PR #12 has no accepted independent verdict for ${docs.head.slice(0, 12)} (`,
  );
  const small = setup(SMALL, { verification: "self" });
  await selfVerdict(small.repo);
  const self = await run(["pr", "merge", "--json"], small.repo.cwd);
  expect(self.code).toBe(3);
  expect(self.json().error).toContain("NEEDS_VERDICT");
  expect(merges(small.runner.calls)).toEqual([]);
});

test("verification: independent keeps the non-author merge gate for a docs-only PR", async () => {
  const { repo, runner } = setup(DOCS, { verification: "independent" });
  const none = await run(["pr", "merge", "--json"], repo.cwd);
  expect(none.code).toBe(3);
  expect(none.json()).toMatchObject({ data: { reason: "needs_verdict" } });
  expect(merges(runner.calls)).toEqual([]);
  await independentVerdict(repo);
  expect((await run(["pr", "merge", "--json"], repo.cwd)).code).toBe(0);
});

test("pr status --json shows the lane, why, and what the merge gate needs", async () => {
  const { repo } = setup(RISKY);
  const result = await run(["pr", "status", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.verdict.lane).toMatchObject({
    lane: "full",
    riskFiles: ["src/hooks/guard.ts"],
    verification: "proportional",
    need: "non-author",
    satisfied: false,
  });
  const human = await run(["pr", "status"], repo.cwd);
  expect(human.stdout).toContain(
    "lane: full (touches a risk path: src/hooks/guard.ts); merge needs an accepted non-author verdict",
  );
});

test("pr status warns when .workit/risk-paths is untracked in the working tree", async () => {
  const { repo } = setup(SMALL);
  const clean = await run(["pr", "status", "--json"], repo.cwd);
  expect(clean.json().data.verdict.lane.warnings).toEqual([]);
  mkdirSync(path.join(repo.cwd, ".workit"), { recursive: true });
  writeFileSync(path.join(repo.cwd, ".workit/risk-paths"), "src/**\n");
  const warned = await run(["pr", "status", "--json"], repo.cwd);
  expect(warned.json().data.verdict.lane.warnings).toEqual([
    expect.stringContaining(".workit/risk-paths is not committed"),
  ]);
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    "warning: .workit/risk-paths is not committed",
  );
});

// Review finding mvkcoxgb: each of these merged with no verdict at lane none.
for (const [name, files, attributes] of [
  [
    "code after a block comment",
    { "src/auth/login.ts": "/* audited */ export const allow = () => true;\n" },
    null,
  ],
  [
    "a risk path with a space in its name",
    { "src/auth/check token.ts": "export const allow = () => true;\n" },
    null,
  ],
  [
    ".git/info/attributes marking everything generated",
    { "src/hooks/guard.ts": "export const guard = false;\n" },
    "* linguist-generated\n",
  ],
] as const)
  test(`fails closed end to end: ${name} is lane full, and neither no verdict nor --self merges`, async () => {
    const { repo, runner } = setup(files);
    if (attributes) {
      const gitDir = repo.git("rev-parse", "--git-common-dir");
      writeFileSync(path.resolve(repo.cwd, gitDir, "info/attributes"), attributes);
    }
    const none = await run(["pr", "merge", "--json"], repo.cwd);
    expect(none.code).toBe(3);
    expect(none.json().data).toMatchObject({
      reason: "needs_verdict",
      verdict: { lane: "full" },
    });
    await selfVerdict(repo);
    expect((await run(["pr", "merge", "--json"], repo.cwd)).code).toBe(3);
    expect(merges(runner.calls)).toEqual([]);
  });

test("a merged lane-none PR reads as merged with no verdict in pr status", async () => {
  const { repo } = setup(DOCS);
  expect((await run(["pr", "merge", "--json"], repo.cwd)).code).toBe(0);
  const human = await run(["pr", "status"], repo.cwd);
  expect(human.stdout).toContain("with no verdict (lane none)");
});

// #334: a verdict carries over a follow-up commit whose own change is lane
// none; a code change makes it stale and asks a focused re-verify.
const followUp = (repo: ForgeRepo, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, file), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "follow-up");
  const head = repo.git("rev-parse", "HEAD");
  repo.subs["{{HEAD}}"] = head;
  return head;
};

test("given a verified head and a follow-up touching only README.md, when merging, then the verdict carries and pr status names the carry", async () => {
  const { repo, runner, head: judged } = setup(RISKY);
  await independentVerdict(repo);
  followUp(repo, DOCS);
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict).toMatchObject({
    accepted: true,
    basis: "carried",
    carry: { rule: "lane-none", since: judged, files: ["README.md"] },
    reverify: null,
  });
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    `verdict: accepted (carried (lane none since ${judged.slice(0, 12)}))`,
  );
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code, merged.stdout + merged.stderr).toBe(0);
  expect(merged.json().data.verdict).toMatchObject({
    accepted: true,
    review: "verified",
    carry: { rule: "lane-none", since: judged },
  });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given a verified head and a follow-up changing src code, then the verdict is stale and pr status asks a focused re-verify", async () => {
  const { repo, runner, head: judged } = setup(RISKY);
  await independentVerdict(repo);
  followUp(repo, SMALL);
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict).toMatchObject({
    accepted: false,
    basis: "stale",
    carry: null,
    reverify: { scope: "focused", since: judged, files: ["src/feature.ts"] },
  });
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    "reverify: focused (src/feature.ts)",
  );
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code).toBe(3);
  expect(merged.json().error).toContain("stale");
  expect(merges(runner.calls)).toEqual([]);
});

// A clean rebase onto a base that also edited another part of a branch file
// keeps the PR's patch: the verdict carries, labelled as such. Only the
// verdict carries: red CI on the new head still refuses the merge.
const NUMBERED = (edits: Record<number, string> = {}) =>
  Array.from({ length: 40 }, (_, index) => edits[index] ?? `line ${index}`).join("\n") + "\n";

const rebasedOverSharedFile = async (openStatus?: string) => {
  const { repo, runner } = setup(RISKY, {}, openStatus);
  const onMain = (files: Record<string, string>) => {
    repo.git("switch", "-q", "main");
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
      writeFileSync(path.join(repo.cwd, file), text);
    }
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "main moves");
    repo.git("switch", "-q", "feature/x");
    repo.git("rebase", "-q", "main");
    repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  };
  onMain({ "src/shared.ts": NUMBERED() });
  const judged = followUp(repo, { "src/shared.ts": NUMBERED({ 2: "line 2 branch" }) });
  await independentVerdict(repo);
  onMain({ "src/shared.ts": NUMBERED({ 35: "line 35 main" }) });
  expect(repo.git("rev-parse", "HEAD")).not.toBe(judged);
  return { repo, runner, judged };
};

test("given a verified head, when the branch is rebased cleanly over a base edit in a branch file, then the verdict carries as a rebase and the PR merges", async () => {
  const { repo, runner, judged } = await rebasedOverSharedFile();
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict).toMatchObject({
    accepted: true,
    basis: "carried",
    carry: { rule: "rebase", since: judged, files: [] },
  });
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    "verdict: accepted (carried (rebase: patch unchanged))",
  );
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code, merged.stdout + merged.stderr).toBe(0);
  expect(merged.json().data.verdict).toMatchObject({ accepted: true, review: "verified" });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given a verdict carried over a clean rebase, when CI on the new head is red, then the merge is still refused", async () => {
  const { repo, runner } = await rebasedOverSharedFile("github/pr-failing-thread.json");
  const status = await run(["pr", "status", "--log-lines", "0", "--json"], repo.cwd);
  expect(status.json().data.verdict).toMatchObject({ accepted: true, carry: { rule: "rebase" } });
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code).toBe(3);
  expect(merged.json().data.blockers).toContain("required_checks_failing");
  expect(merges(runner.calls)).toEqual([]);
});

// #505: the human merge line says "accepted" only when the gate accepted a verdict.
test("given a merge on a self verdict, no verdict (lane none) or an accepted independent one, when it prints, then it says accepted only for the accepted one", async () => {
  const self = setup(SMALL);
  await selfVerdict(self.repo);
  const selfMerge = await run(["pr", "merge"], self.repo.cwd);
  expect(selfMerge.code).toBe(0);
  expect(selfMerge.stdout).not.toMatch(/verdict \S+ accepted for that head/u);
  expect(selfMerge.stdout).toContain("self-reviewed (lane self): the author's verdict");
  expect(selfMerge.stdout).toContain("no independent verdict accepted for that head");

  const docs = setup(DOCS);
  const docsMerge = await run(["pr", "merge"], docs.repo.cwd);
  expect(docsMerge.code).toBe(0);
  expect(docsMerge.stdout).not.toMatch(/verdict \S+ accepted for that head/u);
  expect(docsMerge.stdout).toContain("no verdict required (lane none)");

  const risky = setup(RISKY);
  await independentVerdict(risky.repo);
  const verified = await run(["pr", "merge"], risky.repo.cwd);
  expect(verified.code).toBe(0);
  expect(verified.stdout).toMatch(/verdict \S+ accepted for that head/u);
});

// #533: a refused merge was read as silence because the agent filtered the
// output with `2>&1 | grep -E '^merged|rror'`, and no refusal line said
// "error". Every outcome now ends in a line such a filter keeps.
const kept = (out: string) =>
  out.split("\n").filter((line) => /^merged|rror|not merged/u.test(line));

test("given checks still pending, when pr merge is refused, then a line naming the error and 'not merged' survives a grep for errors", async () => {
  const { repo, runner } = setup(DOCS, {}, "github/pr-pending.json");
  const result = await run(["pr", "merge"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(kept(result.stderr)).toEqual([
    expect.stringMatching(/^workit: error: PR not merged \(not_ready, exit \d\)/u),
  ]);
  expect(merges(runner.calls)).toEqual([]);
});

test("given a merge that lands, when it prints, then its first line is the merged line on stdout and stderr is empty", async () => {
  const { repo } = setup(DOCS);
  const result = await run(["pr", "merge"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.stdout.split("\n")[0]).toMatch(/^merged PR #12 \(squash\) at head [0-9a-f]{12}/u);
  expect(result.stderr).toBe("");
});

test("given the forge accepts the merge but the PR stays open (merge queue, auto-merge), then pr merge says it is not merged and exits non-zero", async () => {
  const { repo, runner } = setup(DOCS, {}, "github/pr-passing.json", { stayOpen: true });
  const result = await run(["pr", "merge"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.stdout).not.toMatch(/^merged/mu);
  expect(result.stderr).toContain("not merged yet");
  expect(result.stderr).toContain("merge queue or auto-merge");
  expect(kept(result.stderr)).toContainEqual(
    expect.stringMatching(/^workit: error: PR not merged \(merge_unverified, exit 1\)/u),
  );
  expect(merges(runner.calls)).toHaveLength(1);
});
