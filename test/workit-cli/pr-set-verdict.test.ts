import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #891 part 3: a non-author verifier reviews one diff once, records it with
// `--set <name>`, and the merge gate of a PR in another repository whose own
// diff is the same accepts it. A diff that differs by one byte, an author's
// session, or a PR its verifier authored never rides on it.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-set-verdict-");
});
afterAll(() => configHome.restore());

// Each test gets its own state dir: the set store and the issued ids live there.
const runState = process.env.WORKIT_STATE_DIR;
let ownState = "";
beforeEach(() => {
  ownState = mkdtempSync(path.join(runState ?? "", "set-"));
  process.env.WORKIT_STATE_DIR = ownState;
});

const repos: ForgeRepo[] = [];
afterEach(() => {
  process.env.WORKIT_STATE_DIR = runState;
  rmSync(ownState, { recursive: true, force: true });
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const SESSION_KEYS = [
  "WORKIT_SESSION_ID",
  "WORKIT_SESSION_TOKEN",
  "WORKIT_HOST",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
];

/** The CLI in-process as a Claude Code session (`lead`), or the author by default. */
const run = async (argv: string[], cwd: string, lead = "author-1") => {
  let stdout = "";
  let stderr = "";
  const base = { ...process.env };
  for (const key of SESSION_KEYS) delete base[key];
  const io: Partial<Io> = {
    cwd,
    env: { ...base, WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: lead },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

/** A repository whose feature/x holds exactly `files`; `trailer` adds a Workit-Session trailer. */
const repoWith = (files: Record<string, string>, trailer?: string): ForgeRepo => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("rm", "-q", "feature.txt");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, file), text);
  }
  repo.git("add", "-A");
  repo.git(
    "commit",
    "-q",
    "--amend",
    "-m",
    trailer ? `feature\n\nWorkit-Session: ${trailer}` : "feature",
  );
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  return repo;
};

/** One workspace over every repository, granting `merge: verified`. */
const workspace = () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: repos.map((repo, index) => ({
        name: `w${index}`,
        glob: `${repo.root.replaceAll("\\", "/")}/**`,
        vcs: { provider: "github", account: "octo" },
        autonomy: { merge: "verified" },
        deleteBranch: false,
      })),
    }),
  );
};

/** Point the forge at `repo`'s READY PR #12; status reads `open` until merged. */
const forgeFor = (repo: ForgeRepo, open = "github/pr-passing.json") => {
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () => fixture(merged ? "github/pr-merged.json" : open),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return runner;
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

// A risk path, so every PR is on the full lane and needs a non-author verdict.
const CHANGE = {
  "src/hooks/guard.ts": "export const guard = true;\n",
  "package.json": '{\n  "name": "app"\n}\n',
};

/** The verifier subagent the lead spawned: its issued id and token, as SubagentStart gives them. */
const verifier = (repo: ForgeRepo, id = "lead-A:ver-1") => {
  const token = recordIssuedSession(repo.cwd, "lead-A", id) ?? "";
  return ["--session", id, "--token", token];
};

const recordSet = async (repo: ForgeRepo, extra: string[] = []) =>
  run(
    [
      "ledger",
      "verdict",
      "verified",
      "--how",
      "read the bump and ran the suite",
      "--set",
      "deps-1",
      ...verifier(repo),
      ...extra,
      "--json",
    ],
    repo.cwd,
    "lead-A",
  );

test("Given a non-author set verdict on diff H, When PR B in another repository has diff H, Then its merge gate accepts it and pr status names the set verdict", async () => {
  const a = repoWith(CHANGE);
  const b = repoWith(CHANGE);
  workspace();
  forgeFor(a);
  const recorded = await recordSet(a);
  expect(recorded.code, recorded.stdout).toBe(0);
  const set = recorded.json().data.set;
  expect(set).toMatchObject({ name: "deps-1" });
  expect(set.hash).toStartWith("sha256:");
  expect(recorded.json().data.diffHash).toBe(set.hash);

  forgeFor(b);
  const status = await run(["pr", "status", "--json"], b.cwd);
  expect(status.code, status.stdout).toBe(0);
  const verdict = status.json().data.verdict;
  expect(verdict).toMatchObject({ accepted: true, review: "verified" });
  expect(verdict.lane).toMatchObject({ lane: "full", satisfied: true });
  expect(verdict.set).toMatchObject({
    set: "deps-1",
    verdictId: recorded.json().data.id,
    hash: set.hash,
    head: a.subs["{{HEAD}}"],
  });
  const text = await run(["pr", "status"], b.cwd);
  expect(text.stdout).toContain(
    `verdict: accepted (set verdict ${recorded.json().data.id} (deps-1)`,
  );

  const runner = forgeFor(b);
  const merged = await run(["pr", "merge", "--json"], b.cwd);
  expect(merged.code, merged.stdout).toBe(0);
  expect(merged.json().data.verdict).toMatchObject({
    accepted: true,
    review: "verified",
    lane: "full",
    set: { set: "deps-1" },
  });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("Given a set verdict on diff H, When PR C's diff differs by one byte, Then the set verdict does not apply and the merge is refused", async () => {
  const a = repoWith(CHANGE);
  const c = repoWith({ ...CHANGE, "src/hooks/guard.ts": "export const guard = true; \n" });
  workspace();
  forgeFor(a);
  expect((await recordSet(a)).code).toBe(0);
  const runner = forgeFor(c);
  const status = await run(["pr", "status", "--json"], c.cwd);
  expect(status.json().data.verdict).toMatchObject({ accepted: false, set: null });
  const merge = await run(["pr", "merge", "--json"], c.cwd);
  expect(merge.code).toBe(3);
  expect(merge.json().error).toContain("NEEDS_VERDICT");
  expect(merges(runner.calls)).toEqual([]);
});

test("Given an author session, Then it cannot record a set verdict: its own session, --as and --self are refused", async () => {
  const a = repoWith(CHANGE);
  workspace();
  forgeFor(a);
  const own = await run(
    ["ledger", "verdict", "verified", "--how", "mine", "--set", "deps-1", "--json"],
    a.cwd,
    "lead-A",
  );
  expect(own.code).toBe(3);
  expect(own.json().error).toContain("set_session");
  for (const flag of [["--as", "verifier"], ["--self"]]) {
    const refused = await run(
      ["ledger", "verdict", "verified", "--how", "mine", "--set", "deps-1", ...flag, "--json"],
      a.cwd,
    );
    expect(refused.code, flag.join(" ")).toBe(2);
  }
  // The author's own bare session never recorded a set row for B to accept.
  const b = repoWith(CHANGE);
  workspace();
  forgeFor(b);
  const status = await run(["pr", "status", "--json"], b.cwd);
  expect(status.json().data.verdict.accepted).toBe(false);
});

test("Given a set verdict whose session authored PR B, Then B's gate does not accept it", async () => {
  const a = repoWith(CHANGE);
  const b = repoWith(CHANGE, "lead-A:ver-1");
  workspace();
  forgeFor(a);
  expect((await recordSet(a)).code).toBe(0);
  forgeFor(b);
  const status = await run(["pr", "status", "--json"], b.cwd);
  const verdict = status.json().data.verdict;
  expect(verdict.accepted).toBe(false);
  expect(verdict.setNote).toContain("none from a trusted non-author session");
});

test("Given PR D whose only difference is its lockfile, Then the set verdict covers it only with green CI on its head", async () => {
  const a = repoWith({ ...CHANGE, "package-lock.json": '{"lockfileVersion":3,"a":1}\n' });
  const d = repoWith({ ...CHANGE, "package-lock.json": '{"lockfileVersion":3,"d":2}\n' });
  workspace();
  forgeFor(a);
  const recorded = await recordSet(a);
  expect(recorded.code, recorded.stdout).toBe(0);
  forgeFor(d, "github/pr-pending.json");
  const pending = await run(["pr", "status", "--json"], d.cwd);
  expect(pending.json().data.verdict.accepted).toBe(false);
  expect(pending.json().data.verdict.setNote).toContain(
    "package-lock.json is outside the set hash and needs green CI on the head",
  );
  forgeFor(d);
  const green = await run(["pr", "status", "--json"], d.cwd);
  expect(green.json().data.verdict).toMatchObject({
    accepted: true,
    set: { set: "deps-1", lockfiles: ["package-lock.json"] },
  });
});

test("Given a set verdict older than its time to live, Then it no longer covers a matching PR", async () => {
  const a = repoWith(CHANGE);
  const b = repoWith(CHANGE);
  workspace();
  forgeFor(a);
  expect((await recordSet(a)).code).toBe(0);
  const now = Date.now;
  Date.now = () => now() + 8 * 86_400_000;
  try {
    forgeFor(b);
    const status = await run(["pr", "status", "--json"], b.cwd);
    expect(status.json().data.verdict.accepted).toBe(false);
    expect(status.json().data.verdict.setNote).toContain("expired at");
  } finally {
    Date.now = now;
  }
});
