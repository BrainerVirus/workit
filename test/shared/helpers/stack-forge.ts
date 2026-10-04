// A stateful fake GitHub/GitLab (gh/glab runner) over a real local bare
// remote, for the S12 stack verbs: PR heads are read from the bare repo, a
// merge really squashes into the base branch there (`git merge-tree` +
// `commit-tree`, with the head-SHA guard), retargeting moves the PR base,
// and CI reports per head (a head pushed after setup is pending for its
// first poll). Nothing reaches the network.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliBin, CliRun, ForgeRunner } from "@/packages/workit-core/src/forge/exec";

const runGit = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const tryGit = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

const configure = (cwd: string, hooks: string) => {
  runGit(cwd, "config", "user.name", "t");
  runGit(cwd, "config", "user.email", "t@t");
  runGit(cwd, "config", "commit.gpgsign", "false");
  runGit(cwd, "config", "core.hooksPath", hooks);
};

type FakePr = {
  number: number;
  branch: string;
  base: string;
  state: "open" | "closed" | "merged";
};

type ForgeCall = {
  bin: CliBin;
  method: string;
  endpoint: string;
  vars: Record<string, string>;
};

export type StackForge = {
  kind: "github" | "gitlab";
  root: string;
  /** The working checkout (fetch from the bare remote, push URL = the forge). */
  cwd: string;
  bare: string;
  hooks: string;
  prs: Map<number, FakePr>;
  calls: ForgeCall[];
  /** Forge writes, in order: `merge <n>`, `retarget <n> <base>`. */
  writes: string[];
  runner: ForgeRunner;
  /** Heads whose CI fails. */
  failing: Set<string>;
  git: (...args: string[]) => string;
  tip: (branch: string) => string | null;
  /** Squash-merge a PR on the "forge" outside workit (someone pressed the button). */
  mergeExternally: (pr: number) => string;
  /** A commit on the remote `branch` from another clone. */
  commitElsewhere: (branch: string, file: string, text: string) => string;
  cleanup: () => void;
};

const GL_PROJECT = "projects/group%2Fproject";
const GL_ID = 34675721;

/**
 * Trunk `main` with one commit; `branches` stacked in order, each adding
 * `<slug>.txt`; all pushed. PRs are numbered from 11 with the chain as bases.
 */
export function makeStackForge(
  kind: "github" | "gitlab",
  branches: readonly string[] = ["feature/a", "feature/b", "feature/c", "feature/d"],
): StackForge {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-stack-"));
  const bare = path.join(root, "remote.git");
  const cwd = path.join(root, "work");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  runGit(root, "init", "-q", "--bare", "-b", "main", bare);
  runGit(cwd, "init", "-q", "-b", "main");
  configure(cwd, hooks);
  writeFileSync(path.join(cwd, "README.md"), "base\n");
  runGit(cwd, "add", "-A");
  runGit(cwd, "commit", "-q", "-m", "chore: base");
  runGit(cwd, "remote", "add", "origin", bare);
  runGit(cwd, "push", "-q", "-u", "origin", "main");
  for (const branch of branches) {
    runGit(cwd, "switch", "-q", "-c", branch);
    const slug = branch.split("/").pop() as string;
    // Two commits per branch: a squash of them is not patch-equal to either,
    // so replaying a merged parent's commits onto the trunk would conflict.
    for (const [text, subject] of [
      [`${slug} draft\n`, `feat: ${slug} draft`],
      [`${slug}\n`, `feat: ${slug}`],
    ]) {
      writeFileSync(path.join(cwd, `${slug}.txt`), text);
      runGit(cwd, "add", "-A");
      runGit(cwd, "commit", "-q", "-m", subject);
    }
    runGit(cwd, "push", "-q", "origin", branch);
  }
  runGit(
    cwd,
    "remote",
    "set-url",
    "--push",
    "origin",
    kind === "github" ? "https://github.com/o/r.git" : "https://gitlab.com/group/project.git",
  );

  const prs = new Map<number, FakePr>();
  branches.forEach((branch, index) =>
    prs.set(11 + index, {
      number: 11 + index,
      branch,
      base: index === 0 ? "main" : branches[index - 1],
      state: "open",
    }),
  );
  const tip = (branch: string): string | null => {
    const result = tryGit(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const initialHeads = new Set(branches.map((branch) => tip(branch) as string));
  const polls = new Map<string, number>();
  const failing = new Set<string>();
  const pipelineIds = new Map<string, number>();
  const calls: ForgeCall[] = [];
  const writes: string[] = [];

  /** passing | pending | failing for a head (a new head is pending on its first poll). */
  const ci = (sha: string): "passing" | "pending" | "failing" => {
    if (failing.has(sha)) return "failing";
    if (initialHeads.has(sha)) return "passing";
    const seen = polls.get(sha) ?? 0;
    polls.set(sha, seen + 1);
    return seen === 0 ? "pending" : "passing";
  };
  const conflicts = (base: string, head: string): boolean =>
    tryGit(bare, "merge-tree", "--write-tree", base, head).status !== 0;
  const squash = (pr: FakePr): string => {
    const head = tip(pr.branch) as string;
    const base = tip(pr.base) as string;
    const tree = runGit(bare, "merge-tree", "--write-tree", base, head).split("\n")[0];
    const commit = runGit(
      bare,
      "-c",
      "user.name=forge",
      "-c",
      "user.email=forge@x",
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      `squash: ${pr.branch} (#${pr.number})`,
    );
    runGit(bare, "update-ref", `refs/heads/${pr.base}`, commit, base);
    pr.state = "merged";
    return commit;
  };

  const out = (value: unknown): CliRun => ({
    status: 0,
    stdout: JSON.stringify(value),
    stderr: "",
    timedOut: false,
    missing: false,
  });
  const error = (stderr: string): CliRun => ({
    status: 1,
    stdout: "",
    stderr,
    timedOut: false,
    missing: false,
  });

  const parse = (args: readonly string[]): ForgeCall & { query: string | null } => {
    let method = "GET";
    let endpoint = "";
    let query: string | null = null;
    const vars: Record<string, string> = {};
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "-X") method = args[++index];
      else if (arg === "-f" || arg === "-F") {
        const pair = args[++index];
        const eq = pair.indexOf("=");
        if (pair.slice(0, eq) === "query") query = pair.slice(eq + 1);
        else vars[pair.slice(0, eq)] = pair.slice(eq + 1);
      } else if (!endpoint) endpoint = arg;
    }
    return { bin: "gh", method, endpoint, vars, query };
  };

  const githubPr = (pr: FakePr) => {
    const head = tip(pr.branch) as string;
    const baseTip = tip(pr.base);
    const state = pr.state === "open" ? ci(head) : "passing";
    const dirty = pr.state === "open" && baseTip !== null && conflicts(baseTip, head);
    return {
      number: pr.number,
      url: `https://github.com/o/r/pull/${pr.number}`,
      state: pr.state.toUpperCase(),
      isDraft: false,
      isInMergeQueue: false,
      mergeable: dirty ? "CONFLICTING" : "MERGEABLE",
      mergeStateStatus: dirty ? "DIRTY" : state === "passing" ? "CLEAN" : "BLOCKED",
      baseRefName: pr.base,
      baseRefOid: baseTip,
      baseRef: baseTip ? { target: { oid: baseTip } } : null,
      headRefName: pr.branch,
      headRefOid: head,
      reviewDecision: null,
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                state:
                  state === "passing" ? "SUCCESS" : state === "failing" ? "FAILURE" : "PENDING",
                contexts: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "test",
                      status: state === "pending" ? "IN_PROGRESS" : "COMPLETED",
                      conclusion:
                        state === "pending" ? null : state === "passing" ? "SUCCESS" : "FAILURE",
                      detailsUrl: null,
                      databaseId: 1,
                      checkSuite: null,
                      isRequired: false,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };
  };

  const github = (args: readonly string[]): CliRun => {
    if (args[0] === "auth") return { ...out(""), stdout: "gho_faketoken\n" };
    const call = parse(args);
    calls.push({ bin: "gh", method: call.method, endpoint: call.endpoint, vars: call.vars });
    if (call.endpoint === "user") return out({ login: "octo" });
    if (call.endpoint === "repos/o/r") return out({ id: 1, full_name: "o/r", fork: false });
    if (call.endpoint.startsWith("repos/o/r/branches/")) return out({ protected: false });
    if (call.endpoint.startsWith("repos/o/r/rules/branches/")) return out([]);
    if (call.endpoint === "graphql" && call.query?.includes("pullRequests(headRefName")) {
      // Newest first, like orderBy CREATED_AT DESC.
      const nodes = [...prs.values()]
        .filter((pr) => pr.branch === call.vars.head)
        .toSorted((a, b) => b.number - a.number)
        .map((pr) => ({
          number: pr.number,
          url: `https://github.com/o/r/pull/${pr.number}`,
          state: pr.state.toUpperCase(),
          headRefName: pr.branch,
          headRefOid: tip(pr.branch),
          headRepositoryOwner: { login: "o" },
        }));
      return out({ data: { repository: { pullRequests: { nodes } } } });
    }
    if (call.endpoint === "graphql") {
      const pr = prs.get(Number(call.vars.number));
      return out({ data: { repository: { pullRequest: pr ? githubPr(pr) : null } } });
    }
    const patch = /^repos\/o\/r\/pulls\/(\d+)$/u.exec(call.endpoint);
    if (call.method === "PATCH" && patch) {
      const pr = prs.get(Number(patch[1]));
      if (!pr) return error("HTTP 404");
      pr.base = call.vars.base;
      writes.push(`retarget ${pr.number} ${pr.base}`);
      return out({ number: pr.number, base: { ref: pr.base } });
    }
    const merge = /^repos\/o\/r\/pulls\/(\d+)\/merge$/u.exec(call.endpoint);
    if (call.method === "PUT" && merge) {
      const pr = prs.get(Number(merge[1]));
      if (!pr || pr.state !== "open") return error("HTTP 405: not mergeable");
      if (tip(pr.branch) !== call.vars.sha) return error("HTTP 409: Head branch was modified");
      writes.push(`merge ${pr.number}`);
      return out({ sha: squash(pr), merged: true, message: "merged" });
    }
    throw new Error(`unrecorded gh call: ${call.method} ${call.endpoint}`);
  };

  const gitlabMr = (pr: FakePr) => {
    const head = tip(pr.branch) as string;
    const baseTip = tip(pr.base);
    const state = pr.state === "open" ? ci(head) : "passing";
    const dirty = pr.state === "open" && baseTip !== null && conflicts(baseTip, head);
    if (!pipelineIds.has(head)) pipelineIds.set(head, 500 + pipelineIds.size);
    return {
      iid: pr.number,
      web_url: `https://gitlab.com/group/project/-/merge_requests/${pr.number}`,
      state: pr.state === "open" ? "opened" : pr.state,
      draft: false,
      detailed_merge_status: dirty
        ? "conflict"
        : state === "passing"
          ? "mergeable"
          : state === "pending"
            ? "ci_still_running"
            : "ci_must_pass",
      has_conflicts: dirty,
      target_branch: pr.base,
      source_branch: pr.branch,
      sha: head,
      source_project_id: GL_ID,
      head_pipeline: {
        id: pipelineIds.get(head),
        sha: head,
        project_id: GL_ID,
        status: state === "passing" ? "success" : state === "pending" ? "running" : "failed",
      },
    };
  };
  const pipelineState = new Map<number, string>();

  const gitlab = (args: readonly string[]): CliRun => {
    const call = parse(args);
    calls.push({ bin: "glab", method: call.method, endpoint: call.endpoint, vars: call.vars });
    const endpoint = call.endpoint;
    if (endpoint === "user") return out({ id: 5, username: "octo" });
    if (endpoint === GL_PROJECT) return out({ id: GL_ID, path_with_namespace: "group/project" });
    const branch = new RegExp(`^${GL_PROJECT}/repository/branches/(.+)$`, "u").exec(endpoint);
    if (branch) {
      const sha = tip(decodeURIComponent(branch[1]));
      return sha ? out({ commit: { id: sha } }) : error("HTTP 404");
    }
    const find = new RegExp(`^${GL_PROJECT}/merge_requests\\?source_branch=([^&]+)&`, "u").exec(
      endpoint,
    );
    if (find) {
      const name = decodeURIComponent(find[1]);
      return out(
        [...prs.values()]
          .filter((pr) => pr.branch === name)
          .toSorted((a, b) => b.number - a.number)
          .map((pr) => ({
            iid: pr.number,
            web_url: `https://gitlab.com/group/project/-/merge_requests/${pr.number}`,
            state: pr.state === "open" ? "opened" : pr.state,
            source_branch: pr.branch,
            target_branch: pr.base,
            sha: tip(pr.branch),
            source_project_id: GL_ID,
          })),
      );
    }
    if (new RegExp(`^${GL_PROJECT}/merge_requests/\\d+/discussions\\?`, "u").test(endpoint))
      return out([]);
    const jobs = /^projects\/\d+\/pipelines\/(\d+)\/(jobs|bridges)\?/u.exec(endpoint);
    if (jobs) {
      if (jobs[2] === "bridges") return out([]);
      const status = pipelineState.get(Number(jobs[1])) ?? "success";
      return out([{ id: Number(jobs[1]) * 10, name: "test", stage: "test", status }]);
    }
    const mergeMr = new RegExp(`^${GL_PROJECT}/merge_requests/(\\d+)/merge$`, "u").exec(endpoint);
    if (call.method === "PUT" && mergeMr) {
      const pr = prs.get(Number(mergeMr[1]));
      if (!pr || pr.state !== "open") return error("HTTP 405: Method Not Allowed");
      if (tip(pr.branch) !== call.vars.sha)
        return error("HTTP 409: SHA does not match HEAD of source branch");
      writes.push(`merge ${pr.number}`);
      const sha = squash(pr);
      return out({ iid: pr.number, state: "merged", merge_commit_sha: sha });
    }
    const mr = new RegExp(`^${GL_PROJECT}/merge_requests/(\\d+)$`, "u").exec(endpoint);
    if (mr && call.method === "PUT") {
      const pr = prs.get(Number(mr[1]));
      if (!pr) return error("HTTP 404");
      pr.base = call.vars.target_branch;
      writes.push(`retarget ${pr.number} ${pr.base}`);
      return out({ iid: pr.number, target_branch: pr.base });
    }
    if (mr) {
      const pr = prs.get(Number(mr[1]));
      if (!pr) return error("HTTP 404 Not Found");
      const doc = gitlabMr(pr);
      pipelineState.set(doc.head_pipeline.id as number, doc.head_pipeline.status);
      return out(doc);
    }
    throw new Error(`unrecorded glab call: ${call.method} ${endpoint}`);
  };

  const runner: ForgeRunner = (bin, args) => (bin === "gh" ? github(args) : gitlab(args));
  let others = 0;
  return {
    kind,
    root,
    cwd,
    bare,
    hooks,
    prs,
    calls,
    writes,
    runner,
    failing,
    git: (...args) => runGit(cwd, ...args),
    tip,
    mergeExternally: (number) => {
      const pr = prs.get(number);
      if (!pr) throw new Error(`no PR ${number}`);
      writes.push(`merge ${number} (external)`);
      return squash(pr);
    },
    commitElsewhere: (branch, file, text) => {
      others += 1;
      const other = path.join(root, `other-${others}`);
      runGit(root, "clone", "-q", bare, other);
      configure(other, hooks);
      runGit(other, "switch", "-q", branch);
      writeFileSync(path.join(other, file), text);
      runGit(other, "add", "-A");
      runGit(other, "commit", "-q", "-m", `chore: elsewhere ${others}`);
      runGit(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      return runGit(other, "rev-parse", "HEAD");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
