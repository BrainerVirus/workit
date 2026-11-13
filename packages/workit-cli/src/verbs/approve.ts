// `workit approve [<id>…]` (docs/workit-next/host-approval.md): the prompted
// verb of the host-approval channel. It prints each request as Workit stored
// it, in full. In an agent shell it records nothing: the host records the
// user's answer to its own prompt on this call (Claude Code's hook, Pi's
// dialog). The fallback on every host is the user running it in a real
// terminal: a TTY, no agent marker, then y at the confirm, as `grant set`
// does (#615). With no id it takes the one pending request (#864); with
// several pending it lists them and asks for an id.
//
// Limit (D18, verbs/grant.ts): an agent that allocates a pseudo-terminal and
// scrubs the markers passes the terminal check; the host's prompt on the call
// is the hard boundary.
import {
  isApprovalId,
  liveApprovalRequest,
  pendingApprovalRequests,
  recordApprovalGrant,
  renderApprovalRequest,
  type ApprovalGrant,
  type ApprovalRequest,
} from "@workit-dev/core/src/approvals/store";
import { emit, fail, ok, type Io } from "../output";
import { askOrCancel, cancelled, confirmKey } from "../prompt";
import { agentMarker } from "./grant";

const USAGE = "workit approve [<id>…]";

export type ApproveDeps = {
  /** True only for a person at a terminal: stdin and stdout are TTYs. */
  interactive: () => boolean;
  /** A y/N on the terminal: true only for y. */
  confirm: (question: string) => Promise<boolean>;
};

const defaultDeps: ApproveDeps = {
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm: (question) => confirmKey(question),
};

type Shown = { recorded: false; requests: ApprovalRequest[]; reason: string };
type Recorded = {
  recorded: true;
  requests: ApprovalRequest[];
  grants: ApprovalGrant[];
};

export async function runApprove(
  argv: string[],
  io: Io,
  deps: ApproveDeps = defaultDeps,
): Promise<number> {
  const ids = argv.filter((arg) => arg !== "--json" && arg !== "--");
  const wrong = ids.filter((id) => !isApprovalId(id));
  if (wrong.length > 0)
    return emit(
      io,
      fail(
        "invalid_input",
        `not a request id: ${wrong.join(", ")} (ids look like ap_xxxxxxxx)\nusage: ${USAGE}`,
      ),
    );
  const requests: ApprovalRequest[] = [];
  const missing: string[] = [];
  if (ids.length === 0) {
    const pending = pendingApprovalRequests();
    if (pending.length === 0)
      return emit(
        io,
        fail("not_found", "no request is waiting for a yes", {
          unblock: "run the refused verb again: it records the request to approve",
        }),
      );
    if (pending.length > 1)
      return emit(
        io,
        fail(
          "invalid_input",
          `${pending.length} requests are waiting: name the one to approve\n${pending.map(renderApprovalRequest).join("\n")}`,
          { unblock: `workit approve ${pending[0]?.id ?? "<id>"}` },
        ),
      );
    requests.push(...pending);
  }
  for (const id of ids) {
    const found = liveApprovalRequest(id);
    if (found.ok) requests.push(found.request);
    else missing.push(found.reason);
  }
  if (missing.length > 0)
    return emit(
      io,
      fail("not_found", missing.join("; "), {
        unblock: "run the refused verb again: it records the request to approve",
      }),
    );
  const command = ids.length ? `workit approve ${ids.join(" ")}` : "workit approve";
  const rendered = requests.map(renderApprovalRequest);
  const agent = agentMarker(io.env);
  if (agent || !deps.interactive()) {
    const reason = agent
      ? `this shell belongs to an agent (${agent} is set)`
      : "no interactive terminal";
    return emit(io, ok<Shown>({ recorded: false, requests, reason }), () => [
      ...rendered,
      `Not recorded by this shell: ${reason}. On Claude Code and Pi the host records the user's answer to its prompt on this call; on other hosts the user runs \`${command}\` in a terminal.`,
    ]);
  }
  for (const text of rendered) io.stdout(`${text}\n`);
  const answer = await askOrCancel(io, () =>
    deps.confirm(
      `Approve ${requests.length === 1 ? "this request" : `these ${requests.length} requests`}? Each yes is used once and lasts 15 minutes.`,
    ),
  );
  if (answer === null) return cancelled(io);
  if (!answer) return emit(io, fail("blocked", "not approved; nothing was written"));
  const grants: ApprovalGrant[] = [];
  for (const request of requests) {
    const recorded = recordApprovalGrant({
      id: request.id,
      host: "terminal",
      session: io.env.WORKIT_SESSION_ID || null,
      toolUseId: null,
      via: "terminal",
    });
    if (!recorded.ok) return emit(io, fail("failed", recorded.reason));
    grants.push(recorded.grant);
  }
  return emit(io, ok<Recorded>({ recorded: true, requests, grants }), (data) =>
    data.grants.map(
      (grant) => `approved ${grant.id} (${grant.hash.slice(0, 12)}) until ${grant.expires}`,
    ),
  );
}

export const run = (argv: string[], io: Io): Promise<number> => runApprove(argv, io);
