// `workit pr status|create|merge` (design §2.1, S10/S11).
//
// status: PR/MR state, checks with failing job log tails, unresolved review
// threads, behind-base, and the next action.
// create: opens (or reuses) the PR for the pushed current branch, bound to and
// verified against the pushed SHA; records `pr.created`.
// merge: only when `pr status` reads READY, an accepted independent verdict
// covers the head (S13) and the merge grant allows it; head-SHA guarded.
import { readFileSync } from "node:fs";
import path from "node:path";
import { prBodyFor } from "@brainervirus/workit-core/src/forge/pr-body";
import {
  createPullRequest,
  fillFromCommits,
  mergePullRequest,
  type CreateOutcome,
  type MergeOutcome,
} from "@brainervirus/workit-core/src/forge/pr-ops";
import { prStatusReport } from "@brainervirus/workit-core/src/forge/report";
import type { MergeMethod } from "@brainervirus/workit-core/src/forge/types";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { vcsConfig } from "@brainervirus/workit-core/src/core/vcs-config";
import { emit, fail, ok, type Io } from "../output";
import {
  connect,
  forgeDeps,
  forgeFail,
  parseFlags,
  positiveInt,
  renderStatus,
  usage,
} from "./forge-common";

const STATUS_USAGE = "workit pr status [--pr <n> | --branch <b>] [--log-lines 60] [--json]";
const CREATE_USAGE =
  "workit pr create [--base <b>] (--title <t> [--body <text> | --body-file <f>] | --fill) [--draft] [--json]";
const MERGE_USAGE =
  "workit pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch] [--json]";
const USAGE = "workit pr status|create|merge ... (workit help pr)";

async function status(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value", branch: "value", "log-lines": "value" });
  if (typeof flags === "string") return usage(io, flags, STATUS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, STATUS_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, STATUS_USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", STATUS_USAGE);
  const logLines =
    flags.values["log-lines"] === "0" ? 0 : positiveInt(flags.values["log-lines"], "--log-lines");
  if (typeof logLines === "string") return usage(io, logLines, STATUS_USAGE);
  if (logLines !== null && logLines > 500)
    return usage(io, "--log-lines is capped at 500", STATUS_USAGE);

  const connected = connect(io, flags.values.branch);
  if (!connected.ok) return forgeFail(io, connected);
  const report = prStatusReport(io.cwd, connected.data, {
    pr,
    branch: flags.values.branch ?? null,
    logLines: logLines ?? 60,
    identity: connected.data.identity,
  });
  if (!report.ok) return forgeFail(io, report);
  return emit(io, ok(report.data.doc), renderStatus);
}

async function create(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    base: "value",
    title: "value",
    body: "value",
    "body-file": "value",
    fill: "boolean",
    draft: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, CREATE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, CREATE_USAGE);
  const fill = flags.booleans.has("fill");
  if (!fill && !flags.values.title) return usage(io, "pass --title <t> or --fill", CREATE_USAGE);
  if (flags.values.body !== undefined && flags.values["body-file"] !== undefined)
    return usage(io, "pass --body or --body-file, not both", CREATE_USAGE);
  let body = flags.values.body ?? null;
  if (flags.values["body-file"] !== undefined) {
    try {
      body = readFileSync(path.resolve(io.cwd, flags.values["body-file"]), "utf8");
    } catch {
      return usage(io, `cannot read --body-file ${flags.values["body-file"]}`, CREATE_USAGE);
    }
  }
  let base: string | null = flags.values.base ?? null;
  if (!base) {
    const resolved = vcsConfig("resolve", io.cwd);
    if (resolved.ok === false)
      return emit(
        io,
        fail("blocked", String(resolved.error), {
          unblock: "fix ~/.config/workit/vcs.json or pass --base <b>",
        }),
      );
    base = String(resolved.defaultTargetBranch ?? "") || null;
  }
  if (!base)
    return usage(io, "no default target branch is configured; pass --base <b>", CREATE_USAGE);

  const branch = currentBranch(io.cwd);
  const connected = connect(io, branch);
  if (!connected.ok) return forgeFail(io, connected);
  let title = flags.values.title ?? "";
  if (fill) {
    const filled = fillFromCommits(io.cwd, connected.data, base);
    if (!filled.ok) return forgeFail(io, filled);
    title ||= filled.data.title;
    body ??= filled.data.body;
  }
  const result = await createPullRequest(
    io.cwd,
    connected.data,
    {
      base,
      title,
      body: prBodyFor(io.cwd, {
        body: body ?? "",
        branch: branch ?? "",
        repo: connected.data.forge.kind === "github" ? connected.data.forge.repo : null,
      }),
      draft: flags.booleans.has("draft"),
      actor: actorFromEnv(io.env),
    },
    forgeDeps.sleep,
  );
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: CreateOutcome) => [
    `${data.created ? "opened" : "found open"} ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number}${data.draft && data.created ? " (draft)" : ""}: ${data.branch} -> ${data.base}  ${data.url}`,
    `head ${data.head.slice(0, 12)} verified on the forge`,
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
  ]);
}

const METHODS: ReadonlySet<string> = new Set<MergeMethod>(["squash", "merge", "rebase"]);

async function merge(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value", method: "value", "delete-branch": "boolean" });
  if (typeof flags === "string") return usage(io, flags, MERGE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, MERGE_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, MERGE_USAGE);
  const method = (flags.values.method ?? "squash") as MergeMethod;
  if (!METHODS.has(method))
    return usage(io, "--method must be squash, merge or rebase", MERGE_USAGE);

  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = await mergePullRequest(
    io.cwd,
    connected.data,
    { pr, method, deleteBranch: flags.booleans.has("delete-branch"), actor: actorFromEnv(io.env) },
    forgeDeps.sleep,
  );
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, {
        unblock: result.unblock,
        data: "refusal" in result && result.refusal ? result.refusal : {},
      }),
    );
  return emit(io, ok(result.data), (data: MergeOutcome) => [
    `merged ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number} (${data.method}) at head ${data.head.slice(0, 12)}${data.mergeSha ? ` -> ${data.mergeSha.slice(0, 12)}` : ""}`,
    data.verdict.required
      ? `verdict ${data.verdict.verdictId ?? "?"} accepted for that head`
      : "no verdict required (workspace grants merge: true)",
    ...(data.deletedBranch === true
      ? [`deleted ${data.branch}`]
      : typeof data.deletedBranch === "object"
        ? [`branch not deleted: ${data.deletedBranch.error}`]
        : []),
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return status(rest, io);
  if (sub === "create") return create(rest, io);
  if (sub === "merge") return merge(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown pr subcommand "${sub}"` : "missing pr subcommand",
    USAGE,
  );
}
