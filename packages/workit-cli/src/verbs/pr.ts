// `workit pr status` (design §2.1, S10): PR/MR state, checks with failing job
// log tails, unresolved review threads, behind-base, and the next action.
// `create` and `merge` land in S11.
import { prStatusReport } from "@brainervirus/workit-core/src/forge/report";
import { emit, ok, type Io } from "../output";
import { connect, forgeFail, parseFlags, positiveInt, renderStatus, usage } from "./forge-common";
import { notImplemented } from "./stub";

const STATUS_USAGE = "workit pr status [--pr <n> | --branch <b>] [--log-lines 60] [--json]";

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

const later = notImplemented("pr", "S11");

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return status(rest, io);
  if (sub === "create" || sub === "merge") return later(argv, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown pr subcommand "${sub}"` : "missing pr subcommand",
    STATUS_USAGE,
  );
}
