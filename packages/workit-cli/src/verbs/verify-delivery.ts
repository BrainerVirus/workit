// `workit verify-delivery` (design §2.1 S11): a deterministic answer to "did
// it really land?". A local commit does not prove a push; this observes the
// remote (ls-remote), the forge (PR head, merged state) and the registry.
//
//   workit verify-delivery [push|pr|merge|release] [--expect pushed|pr|merged|released]
//                          [--branch <b>] [--pr <n>] [--sha <sha>]
//                          [--tag <tag>] [--package <name>[@<version>]] [--json]
//
// Exit 0 when every observation holds (delivered), 1 when one does not, with
// the observations in `data` either way.
import {
  verifyMerged,
  verifyPr,
  verifyPushed,
  verifyReleased,
  type DeliveryEndpoint,
  type DeliveryReport,
} from "@brainervirus/workit-core/src/forge/verify";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { connect, forgeDeps, forgeFail, parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit verify-delivery [push|pr|merge|release] [--expect pushed|pr|merged|released] [--branch <b>] [--pr <n>] [--sha <sha>] [--tag <t>] [--package <name[@version]>] [--json]";

const ENDPOINTS: Record<string, DeliveryEndpoint> = {
  push: "pushed",
  pushed: "pushed",
  pr: "pr",
  merge: "merged",
  merged: "merged",
  release: "released",
  released: "released",
};

const render = (report: DeliveryReport): string[] => [
  `${report.expect}: ${report.delivered ? "delivered" : "NOT delivered"}${report.branch ? ` (${report.branch}${report.sha ? ` @ ${report.sha.slice(0, 12)}` : ""})` : ""}${report.pr ? ` #${report.pr}` : ""}`,
  ...report.observations.map(
    (entry) =>
      `  ${entry.ok ? "ok" : "x "} ${entry.kind}: expected ${entry.expected ?? "-"}, observed ${entry.observed ?? "(none)"}${entry.note ? ` — ${entry.note}` : ""}`,
  ),
];

export async function run(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    expect: "value",
    branch: "value",
    pr: "value",
    sha: "value",
    tag: "value",
    package: "value",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, USAGE);
  const named = flags.positionals[0];
  if (named !== undefined && !ENDPOINTS[named])
    return usage(io, `unknown endpoint "${named}"`, USAGE);
  if (flags.values.expect !== undefined && !ENDPOINTS[flags.values.expect])
    return usage(io, "--expect must be pushed, pr, merged or released", USAGE);
  if (named && flags.values.expect && ENDPOINTS[named] !== ENDPOINTS[flags.values.expect])
    return usage(io, `${named} and --expect ${flags.values.expect} disagree`, USAGE);
  const expect =
    ENDPOINTS[named ?? ""] ??
    ENDPOINTS[flags.values.expect ?? ""] ??
    (flags.values.tag || flags.values.package ? "released" : flags.values.pr ? "pr" : "pushed");
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", USAGE);
  const sha = flags.values.sha ?? null;
  if (sha !== null && !/^[0-9a-f]{7,64}$/u.test(sha))
    return usage(io, "--sha must be a commit sha (7-64 hex chars)", USAGE);
  const actor = actorFromEnv(io.env);
  const branch = flags.values.branch ?? null;

  let result;
  if (expect === "pushed") {
    if (pr) return usage(io, "push is checked by --branch, not --pr", USAGE);
    result = verifyPushed(io.cwd, { branch, sha, actor });
  } else if (expect === "released") {
    result = verifyReleased(
      io.cwd,
      { tag: flags.values.tag ?? null, pkg: flags.values.package ?? null, sha, actor },
      forgeDeps.npm,
    );
  } else {
    const connected = connect(io, branch);
    if (!connected.ok) return forgeFail(io, connected);
    result =
      expect === "pr"
        ? verifyPr(io.cwd, connected.data, { pr, branch, sha, actor })
        : verifyMerged(io.cwd, connected.data, { pr, branch, actor });
  }
  if (!result.ok) return forgeFail(io, result);
  const report = result.data;
  if (report.delivered) return emit(io, ok(report), render);
  const failed = report.observations.filter((entry) => !entry.ok);
  // Human mode: the observations too, not just the error line.
  if (!io.json) for (const line of render(report)) io.stdout(`${line}\n`);
  return emit(
    io,
    fail(
      "failed",
      `not_delivered: ${failed.map((entry) => entry.note ?? `${entry.kind} is ${entry.observed ?? "absent"}, expected ${entry.expected ?? "-"}`).join("; ")}`,
      {
        data: report,
        unblock:
          expect === "pushed"
            ? "workit git push"
            : expect === "pr"
              ? "workit git push && workit pr create --fill"
              : expect === "merged"
                ? "workit pr status  # then workit pr merge when READY and granted"
                : "check the release workflow; the tag/package is not published",
      },
    ),
  );
}
