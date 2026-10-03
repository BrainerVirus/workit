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
import {
  buildStatusDoc,
  executeRerun,
  pollDelay,
  selectPr,
  waitVerdict,
  type PrStatusDoc,
  type WaitVerdict,
} from "@brainervirus/workit-core/src/forge/report";
import type { ForgePrStatus } from "@brainervirus/workit-core/src/forge/types";
import { emit, fail, ok, type Io } from "../output";
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
  const head = flags.values.head ?? null;
  if (head !== null && !/^[0-9a-f]{7,64}$/u.test(head))
    return usage(io, "--head must be a commit sha (7-64 hex chars)", WAIT_USAGE);

  const connected = connect(io, flags.values.branch);
  if (!connected.ok) return forgeFail(io, connected);
  const resolved = connected.data;
  const number = selectPr(io.cwd, resolved, { pr, branch: flags.values.branch ?? null });
  if (!number.ok) return forgeFail(io, number);

  const started = forgeDeps.now();
  let polls = 0;
  let errors = 0;
  let status: ForgePrStatus | null = null;
  let verdict: WaitVerdict = { state: "waiting", reason: "not_polled" };
  for (;;) {
    const read = resolved.forge.prStatus(number.data);
    polls += 1;
    const elapsedMs = forgeDeps.now() - started;
    if (read.ok) {
      errors = 0;
      status = read.data;
      const doc = buildStatusDoc(io.cwd, resolved, status, { logLines: 0, behind: false });
      verdict = waitVerdict(doc, { head, elapsedMs });
      if (verdict.state !== "waiting") break;
    } else {
      errors += 1;
      if (read.code !== "unavailable" && read.code !== "failed") return forgeFail(io, read);
      if (errors >= MAX_POLL_ERRORS) return forgeFail(io, read, { polls });
    }
    const remaining = timeoutMs - (forgeDeps.now() - started);
    if (remaining <= 0) break;
    await forgeDeps.sleep(Math.min(pollDelay(intervalMs, polls - 1), remaining));
  }
  const elapsedMs = forgeDeps.now() - started;
  if (!status)
    return emit(
      io,
      fail("unavailable", "no successful poll before the timeout", { data: { polls } }),
    );
  // The final payload is the full status: failing logs and behind-base included.
  const doc: PrStatusDoc = buildStatusDoc(io.cwd, resolved, status, {
    logLines: verdict.state === "failed" ? 60 : 0,
    behind: true,
  });
  const data = {
    state: verdict.state,
    reason: verdict.reason,
    polls,
    elapsedMs,
    timeoutMs,
    status: doc,
  };
  if (!io.json && verdict.state !== "ready")
    for (const value of renderStatus(doc)) io.stdout(`${value}\n`);
  if (verdict.state === "ready")
    return emit(io, ok(data), () => [
      `CI ready (${verdict.reason}) after ${polls} poll${polls === 1 ? "" : "s"}, ${seconds(elapsedMs)}`,
      ...renderStatus(doc),
    ]);
  if (verdict.state === "failed")
    return emit(
      io,
      fail("failed", `CI failed: ${doc.checks.failing.map((check) => check.name).join(", ")}`, {
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
  const number = selectPr(io.cwd, resolved, { pr, branch: flags.values.branch ?? null });
  if (!number.ok) return forgeFail(io, number);
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return forgeFail(io, status);
  const done = executeRerun(io.cwd, resolved, status.data, {
    failed: names.length === 0,
    names,
    reason,
    force: flags.booleans.has("force"),
  });
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

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "wait") return wait(rest, io);
  if (sub === "rerun") return rerun(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown ci subcommand "${sub}"` : "missing ci subcommand",
    `${WAIT_USAGE}\n       ${RERUN_USAGE}`,
  );
}
