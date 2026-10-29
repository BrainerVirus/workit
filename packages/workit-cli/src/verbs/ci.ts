// `workit ci wait` and `workit ci rerun` (design §2.1, S10).
//
// wait: polls the PR's checks with a deterministic backoff until they pass
// (exit 0), fail (exit 1), the PR is blocked (exit 3), or the timeout passes
// with checks still pending (exit 4). The final payload carries the full
// `pr status` document. On Claude, run it with `run_in_background: true`
// instead of a sleep loop.
//
// rerun: reruns failed jobs (or named checks) once per (PR, head, check);
// a second rerun on the same head is `blocked` unless `--force`.
//
// logs --failed: the failing checks of the PR head, each with only the tail
// of its job log (LOG_LINES lines, at most the status document's few tails),
// so an agent never pulls a whole CI log into its context (#426).
import {
  buildStatusDoc,
  executeRerun,
  pollDelay,
  recordPrStatus,
  selectPr,
  waitVerdict,
  type PrStatusDoc,
  type WaitVerdict,
} from "@brainervirus/workit-core/src/forge/report";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import type { ForgePrStatus } from "@brainervirus/workit-core/src/forge/types";
import { requireGrant } from "@brainervirus/workit-core/src/autonomy";
import { forgeTarget } from "@brainervirus/workit-core/src/core/remotes";
import { emit, fail, ok, type Io } from "../output";
import { progressFor } from "../progress";
import {
  connect,
  forgeDeps,
  forgeFail,
  parseDuration,
  parseFlags,
  positiveInt,
  renderStatus,
  usage,
} from "./forge-common";

const WAIT_USAGE =
  "workit ci wait [--pr <n> | --branch <b>] [--head <sha>] [--timeout 20m] [--interval 30s] [--json]";
const RERUN_USAGE =
  "workit ci rerun [--pr <n> | --branch <b>] [--check <name>… | --failed] --reason flake|infra [--force] [--json]";

const LOGS_USAGE = "workit ci logs --failed [--pr <n> | --branch <b>] [--json]";

/** Log lines per failing job, as `workit check` prints by default. */
const LOG_LINES = 60;

/** Budget for a single poll when --timeout is shorter (e.g. --timeout 0). */
const ONE_POLL_MS = 20_000;

/** Consecutive failed polls tolerated before ci wait gives up. */
const MAX_POLL_ERRORS = 3;

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

async function wait(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    branch: "value",
    head: "value",
    timeout: "value",
    interval: "value",
  });
  if (typeof flags === "string") return usage(io, flags, WAIT_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, WAIT_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, WAIT_USAGE);
  const timeoutMs = parseDuration(flags.values.timeout ?? "20m");
  const intervalMs = parseDuration(flags.values.interval ?? "30s");
  if (timeoutMs === null || timeoutMs > 6 * 3_600_000)
    return usage(io, "--timeout must be a duration up to 6h (20m, 90s)", WAIT_USAGE);
  if (intervalMs === null || intervalMs < 1000 || intervalMs > 600_000)
    return usage(io, "--interval must be between 1s and 10m", WAIT_USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", WAIT_USAGE);
  const head = flags.values.head ?? null;
  if (head !== null && !/^[0-9a-f]{7,64}$/u.test(head))
    return usage(io, "--head must be a commit sha (7-64 hex chars)", WAIT_USAGE);

  // One hard deadline for every API call, from resolving the forge and the
  // identity check to the final status build (M2). A zero or tiny --timeout
  // still gets one complete poll.
  const started = forgeDeps.now();
  const deadline = started + timeoutMs;
  const connected = connect(io, flags.values.branch, {
    deadline: started + Math.max(timeoutMs, ONE_POLL_MS),
  });
  if (!connected.ok) return forgeFail(io, connected);
  const resolved = connected.data;
  const number = selectPr(io.cwd, resolved, { pr, branch: flags.values.branch ?? null });
  if (!number.ok) return forgeFail(io, number);

  const actor = actorFromEnv(io.env);
  let polls = 0;
  let errors = 0;
  let status: ForgePrStatus | null = null;
  let verdict: WaitVerdict = { state: "waiting", reason: "not_polled" };
  // Unreadable branch protection: the base branch's check names stand in for
  // the required ones. Read once; a failed read means no expectation (#510).
  let baseContexts: string[] | null = null;
  let expectedMissing: string[] = [];
  const waiting = progressFor(io).start("Waiting for CI");
  const abort = (...args: [Parameters<typeof forgeFail>[1], Record<string, unknown>?]) => {
    waiting.end("failed");
    return forgeFail(io, ...args);
  };
  for (;;) {
    const read = resolved.forge.prStatus(number.data);
    polls += 1;
    const elapsedMs = forgeDeps.now() - started;
    if (read.ok) {
      errors = 0;
      status = read.data;
      const doc = buildStatusDoc(io.cwd, resolved, status, { logLines: 0, behind: false });
      if (!doc.ok) return abort(doc);
      recordPrStatus(io.cwd, doc.data, actor);
      if (status.requiredContexts === null && baseContexts === null) {
        const base = resolved.forge.branchChecks(status.base);
        baseContexts = base.ok ? [...new Set(base.data.checks.map((check) => check.context))] : [];
      }
      const seen = new Set(status.checks.map((check) => check.context));
      expectedMissing = (baseContexts ?? []).filter((context) => !seen.has(context));
      verdict = waitVerdict(doc.data, { head, elapsedMs, expectedMissing });
      if (verdict.state !== "waiting") break;
      const pending = doc.data.checks.pending;
      waiting.label(
        `Waiting for CI: ${pending.length} check${pending.length === 1 ? "" : "s"} pending${pending.length ? ` (${pending.slice(0, 3).join(", ")}${pending.length > 3 ? ", …" : ""})` : ""}`,
      );
    } else {
      errors += 1;
      if (read.code !== "unavailable" && read.code !== "failed") return abort(read);
      if (errors >= MAX_POLL_ERRORS) return abort(read, { polls });
    }
    const remaining = deadline - forgeDeps.now();
    if (remaining <= 0) break;
    await forgeDeps.sleep(Math.min(pollDelay(intervalMs, polls - 1), remaining));
  }
  const elapsedMs = forgeDeps.now() - started;
  waiting.end(
    verdict.state === "ready" ? "done" : verdict.state === "waiting" ? "skipped" : "failed",
  );
  if (!status)
    return emit(
      io,
      fail("unavailable", "no successful poll before the timeout", { data: { polls } }),
    );
  // The final payload is the full status, built inside what is left of the
  // deadline: log tails and the behind-base fetch are clamped (or skipped).
  const left = deadline - forgeDeps.now();
  const built = buildStatusDoc(io.cwd, resolved, status, {
    logLines: verdict.state === "failed" && left > 0 ? 60 : 0,
    behind: left >= 1000,
    behindTimeoutMs: Math.max(1000, Math.min(15_000, left)),
    identity: resolved.identity,
  });
  if (!built.ok) return forgeFail(io, built);
  const doc: PrStatusDoc = built.data;
  const data = {
    // A wait that ends with runs still going says so: `in_progress`.
    state: verdict.state === "waiting" ? "in_progress" : verdict.state,
    ...(verdict.state === "failed" && doc.checks.pending.length > 0
      ? { failFast: true, stillRunning: doc.checks.pending }
      : {}),
    reason: verdict.reason,
    ...(expectedMissing.length > 0 ? { expectedMissing } : {}),
    polls,
    elapsedMs,
    timeoutMs,
    status: doc,
  };
  if (!io.json && verdict.state !== "ready")
    for (const value of renderStatus(doc)) io.stdout(`${value}\n`);
  const never =
    expectedMissing.length > 0
      ? `; checks the base ran never registered: ${expectedMissing.join(", ")}`
      : "";
  if (verdict.state === "ready")
    return emit(io, ok(data), () => [
      (verdict.reason === "no_checks"
        ? `CI none: no CI configured for this head (no checks registered within the grace) after ${polls} poll${polls === 1 ? "" : "s"}, ${seconds(elapsedMs)}`
        : `CI pass (${verdict.reason}) after ${polls} poll${polls === 1 ? "" : "s"}, ${seconds(elapsedMs)}`) +
        never,
      ...renderStatus(doc),
    ]);
  if (verdict.state === "failed")
    return emit(
      io,
      fail("failed", `CI fail: ${doc.checks.failing.map((check) => check.name).join(", ")}`, {
        data,
        unblock: "fix the failure, or if it is a flake: workit ci rerun --failed --reason flake",
      }),
    );
  if (verdict.state === "blocked")
    return emit(
      io,
      fail("blocked", `CI wait blocked: ${verdict.reason}`, { data, unblock: verdict.unblock }),
    );
  return emit(
    io,
    fail("pending", `CI still ${verdict.reason.replaceAll("_", " ")} after ${seconds(elapsedMs)}`, {
      data,
      unblock: `workit ci wait --pr ${doc.number}${head ? ` --head ${head}` : ""}`,
    }),
  );
}

async function rerun(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    branch: "value",
    check: "list",
    failed: "boolean",
    reason: "value",
    force: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, RERUN_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, RERUN_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, RERUN_USAGE);
  const names = flags.lists.check ?? [];
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", RERUN_USAGE);
  if (names.length && flags.booleans.has("failed"))
    return usage(io, "pass --check or --failed, not both", RERUN_USAGE);
  const reason = flags.values.reason;
  if (reason !== "flake" && reason !== "infra")
    return usage(
      io,
      "--reason flake|infra is required: rerun only what you judged a flake or an infrastructure failure",
      RERUN_USAGE,
    );

  const connected = connect(io, flags.values.branch);
  if (!connected.ok) return forgeFail(io, connected);
  const resolved = connected.data;
  // A mutation needs a verified account: a credential that cannot read /user
  // passes reads with a note, but never a rerun when an account is configured.
  if (resolved.expectedAccount && resolved.identity.login === null)
    return emit(
      io,
      fail(
        "blocked",
        `identity_unverified: the credential cannot prove it is ${resolved.expectedAccount} (${resolved.identity.note ?? "no /user access"})`,
        {
          unblock: `use a credential for ${resolved.expectedAccount} that can read /user (vcs.tokenFile or ${resolved.forge.kind === "github" ? "gh" : "glab"} auth login --hostname ${resolved.forge.apiHost})`,
        },
      ),
    );
  const grant = requireGrant(io.cwd, "rerun", {
    target: forgeTarget(resolved.forge.apiHost, resolved.forge.repo),
  });
  if (!grant.allowed)
    return emit(
      io,
      fail("blocked", grant.error, { unblock: grant.unblock, data: { reason: grant.reason } }),
    );
  const number = selectPr(io.cwd, resolved, { pr, branch: flags.values.branch ?? null });
  if (!number.ok) return forgeFail(io, number);
  const status = progressFor(io).runSync(
    `Reading PR #${number.data} checks`,
    () => resolved.forge.prStatus(number.data),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!status.ok) return forgeFail(io, status);
  const done = progressFor(io).runSync(
    "Rerunning the checks",
    () =>
      executeRerun(io.cwd, resolved, status.data, {
        failed: names.length === 0,
        names,
        reason,
        force: flags.booleans.has("force"),
      }),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!done.ok) return forgeFail(io, done);
  const outcome = done.data;
  return emit(io, ok(outcome), () => [
    `rerun requested on #${outcome.pr} head ${outcome.head.slice(0, 7)} (${outcome.reason}${outcome.forced ? ", forced" : ""}): ${outcome.rerun.map((check) => check.name).join(", ")}`,
    ...(outcome.skipped.length ? [`not rerunnable here: ${outcome.skipped.join(", ")}`] : []),
    ...(outcome.recorded
      ? []
      : ["warning: the rerun could not be recorded; the once-per-head guard will not see it"]),
    "next: workit ci wait",
  ]);
}

async function logs(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value", branch: "value", failed: "boolean" });
  if (typeof flags === "string") return usage(io, flags, LOGS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, LOGS_USAGE);
  if (!flags.booleans.has("failed"))
    return usage(io, "pass --failed: only the failing steps' tails are printed", LOGS_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, LOGS_USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", LOGS_USAGE);
  const connected = connect(io, flags.values.branch);
  if (!connected.ok) return forgeFail(io, connected);
  const resolved = connected.data;
  const number = selectPr(io.cwd, resolved, { pr, branch: flags.values.branch ?? null });
  if (!number.ok) return forgeFail(io, number);
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return forgeFail(io, status);
  const doc = buildStatusDoc(io.cwd, resolved, status.data, { logLines: LOG_LINES, behind: false });
  if (!doc.ok) return forgeFail(io, doc);
  const data = {
    pr: doc.data.number,
    head: status.data.head.sha,
    failing: doc.data.checks.failing.map((check) => ({
      name: check.name,
      url: check.url,
      conclusion: check.conclusion,
      logTail: check.logTail,
      ...(check.logError ? { logError: check.logError } : {}),
    })),
  };
  return emit(io, ok(data), () =>
    data.failing.length
      ? [
          `PR #${data.pr} head ${data.head.slice(0, 7)}: ${data.failing.length} failing check${data.failing.length === 1 ? "" : "s"} (last ${LOG_LINES} log lines each)`,
          ...data.failing.flatMap((check) => [
            `x ${check.name}${check.conclusion ? ` (${check.conclusion})` : ""}${check.url ? ` ${check.url}` : ""}`,
            ...(check.logTail.length
              ? check.logTail.map((line) => `  ${line}`)
              : [
                  `  (no log: ${check.logError ?? "not an Actions job, or beyond the tails fetched"})`,
                ]),
          ]),
        ]
      : [`PR #${data.pr} head ${data.head.slice(0, 7)}: no failing checks`],
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "wait") return wait(rest, io);
  if (sub === "rerun") return rerun(rest, io);
  if (sub === "logs") return logs(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown ci subcommand "${sub}"` : "missing ci subcommand",
    `${WAIT_USAGE}\n       ${RERUN_USAGE}\n       ${LOGS_USAGE}`,
  );
}
