// Replays recorded gh/glab API responses (test/fixtures/forge/{github,gitlab})
// in place of the real CLIs, so forge tests never touch the network. Routes
// match on the API endpoint (REST) or the GraphQL operation + variables, and
// `{{HEAD}}` / `{{BASE}}` in a fixture are replaced with real test-repo SHAs.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliBin, CliRun, ForgeRunner } from "@/packages/workit-core/src/forge/exec";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "forge",
);

export const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

export type Call = {
  bin: CliBin;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "CLI";
  endpoint: string;
  /** GraphQL variables (`-f`/`-F key=value`), query excluded. */
  vars: Record<string, string>;
  /** Every `-f`/`-F` pair in order, so repeated array keys (`labels[]`) stay visible. */
  pairs: Array<[string, string]>;
  /** "status" | "find" | "node", or the mutation's field name, for GraphQL calls. */
  op: string | null;
  /** The per-call credential the runner was handed (tests assert on it). */
  token: string | undefined;
};

export type Reply = string | CliRun | ((call: Call) => string | CliRun);

export const replyError = (stderr: string, status = 1): CliRun => ({
  status,
  stdout: "",
  stderr,
  timedOut: false,
  missing: false,
});

const parseCall = (bin: CliBin, args: readonly string[], token?: string): Call => {
  if (args[0] !== "api")
    return { bin, method: "CLI", endpoint: args.join(" "), vars: {}, pairs: [], op: null, token };
  const rest = args.slice(1);
  let method: Call["method"] = "GET";
  const vars: Record<string, string> = {};
  const pairs: Array<[string, string]> = [];
  let endpoint = "";
  let op: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "-X") {
      method = rest[++index] as Call["method"];
      continue;
    }
    if (arg === "-f" || arg === "-F") {
      const pair = rest[++index];
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key === "query")
        op = value.startsWith("mutation")
          ? (/\{\s*(\w+)\(/u.exec(value)?.[1] ?? "mutation")
          : value.includes("pullRequests(headRefName")
            ? "find"
            : value.includes("node(id:")
              ? "node"
              : "status";
      else {
        vars[key] = value;
        pairs.push([key, value]);
      }
      continue;
    }
    if (!endpoint) endpoint = arg;
  }
  return { bin, method, endpoint, vars, pairs, op, token };
};

/**
 * A runner over `routes`: keys are `GET <endpoint>`, `POST <endpoint>`,
 * `CLI <args>` (non-api commands such as `auth token …`), or
 * `graphql <op> <json vars>` (exact) — the first exact key wins, then a
 * `graphql <op>` catch-all. An unmatched call fails the test loudly.
 */
export function replayRunner(
  routes: Record<string, Reply>,
  substitutions: Record<string, string> = {},
): ForgeRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = (
    bin: CliBin,
    args: readonly string[],
    options: { timeoutMs: number; token?: string },
  ): CliRun => {
    const call = parseCall(bin, args, options.token);
    calls.push(call);
    // Like real glab: `key[]=` array fields are refused in a JSON body.
    if (bin === "glab" && call.pairs.some(([key]) => key.endsWith("[]")))
      return replyError(`glab: invalid key ${call.pairs.find(([key]) => key.endsWith("[]"))?.[0]}`);
    const keys =
      call.endpoint === "graphql"
        ? [`graphql ${call.op} ${JSON.stringify(call.vars)}`, `graphql ${call.op}`]
        : [`${call.method} ${call.endpoint}`];
    const key = keys.find((candidate) => candidate in routes);
    if (!key) throw new Error(`unrecorded ${bin} call: ${keys[0]}`);
    const route = routes[key];
    const reply = typeof route === "function" ? route(call) : route;
    if (typeof reply !== "string") return reply;
    let stdout = reply;
    for (const [from, to] of Object.entries(substitutions)) stdout = stdout.replaceAll(from, to);
    return { status: 0, stdout, stderr: "", timedOut: false, missing: false };
  };
  return Object.assign(runner, { calls });
}

// Pinned so fixture repos behave the same on every runner: no CRLF rewriting
// (Windows git defaults core.autocrlf=true) and no background auto-gc racing
// the next command.
const GIT_CONFIG = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "gc.auto=0",
];

const runGit = (cwd: string, args: string[]): SpawnSyncReturns<string> =>
  spawnSync("git", [...GIT_CONFIG, ...args], { cwd, encoding: "utf8" });

// A Windows CI fixture `git commit` once failed with an empty stderr; the
// status, signal and spawn error are what identify such a failure.
const describeFailure = (args: string[], result: SpawnSyncReturns<string>): string =>
  [
    `git ${args.join(" ")} failed`,
    `status=${result.status} signal=${result.signal ?? "none"}`,
    result.error ? `error=${result.error.message}` : "",
    `stderr=${result.stderr || "(empty)"}`,
    `stdout=${result.stdout || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");

const git = (cwd: string, ...args: string[]): string => {
  let result = runGit(cwd, args);
  // Retry once only when git never ran to an exit code (spawn error or
  // killed by a signal); a real non-zero exit fails immediately.
  if (result.error || result.status === null) result = runGit(cwd, args);
  if (result.status !== 0) throw new Error(describeFailure(args, result));
  return result.stdout.trim();
};

export type ForgeRepo = {
  root: string;
  /** Checkout of feature/x: 1 commit ahead of and 3 behind origin/main. */
  cwd: string;
  head: string;
  base: string;
  /** HEAD/BASE substitutions for the fixtures. */
  subs: Record<string, string>;
  git: (...args: string[]) => string;
  cleanup: () => void;
};

/**
 * A checkout whose fetch URL is a local bare repo and whose push URL is the
 * forge (https, so no ~/.ssh/config alias lookup): the forge is derived from
 * the push URL while `git fetch` stays offline.
 */
export function makeForgeRepo(kind: "github" | "gitlab"): ForgeRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-forge-"));
  const bare = path.join(root, "remote.git");
  const cwd = path.join(root, "work");
  mkdirSync(cwd);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(cwd, "init", "-q", "-b", "main");
  // Persist the same settings so git run by the code under test matches.
  for (const dir of [bare, cwd]) {
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "gc.auto", "0");
  }
  writeFileSync(path.join(cwd, "a.txt"), "a\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "feature/x");
  writeFileSync(path.join(cwd, "feature.txt"), "x\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "feature");
  git(cwd, "switch", "-q", "main");
  for (const n of [1, 2, 3]) {
    writeFileSync(path.join(cwd, `main-${n}.txt`), `${n}\n`);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `main ${n}`);
  }
  git(cwd, "remote", "add", "origin", bare);
  git(cwd, "push", "-q", "origin", "main", "feature/x");
  const base = git(cwd, "rev-parse", "main");
  // Local main falls back to the shared base, so only the fetch can see 3.
  git(cwd, "switch", "-q", "feature/x");
  git(cwd, "branch", "-q", "-f", "main", "HEAD~1");
  git(cwd, "update-ref", "-d", "refs/remotes/origin/main");
  git(
    cwd,
    "remote",
    "set-url",
    "--push",
    "origin",
    kind === "github" ? "https://github.com/o/r.git" : "https://gitlab.com/group/project.git",
  );
  const head = git(cwd, "rev-parse", "HEAD");
  return {
    root,
    cwd,
    head,
    base,
    subs: { "{{HEAD}}": head, "{{BASE}}": base },
    git: (...args) => git(cwd, ...args),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
