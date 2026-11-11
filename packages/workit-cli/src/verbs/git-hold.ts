// `workit git hold --why "<the user's words>" | --clear`: record the user's
// "not yet" for the current branch, so the Stop hook stops asking to push or
// open a PR for it (#769). The next push that moves the branch, or `--clear`,
// ends it. A hold grants nothing and never changes the endpoint.
import { git } from "@workit-dev/core/src/git/ops";
import { currentBranch } from "@workit-dev/core/src/git/rev";
import { actorFromEnv, appendObserved, branchHold, readLedger } from "@workit-dev/core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { usage } from "./forge-common";

/** Hold the current branch (`why`, the user's words) or end its hold (`why` null). */
export function hold(why: string | null, io: Io, line: string): number {
  const clear = why === null;
  const branch = currentBranch(io.cwd);
  if (!branch) return usage(io, "no branch is checked out", line);
  const ledger = readLedger(io.cwd);
  if (!ledger.ok) return emit(io, fail(ledger.code, ledger.error));
  const held = branchHold(ledger.value.rows, branch);
  if (clear && !held)
    return emit(io, ok({ branch, held: false, cleared: false }), () => `no hold on ${branch}`);
  const head = git(io.cwd, ["rev-parse", "HEAD"]);
  const row = appendObserved(io.cwd, {
    type: clear ? "branch.hold.cleared" : "branch.hold",
    actor: actorFromEnv(io.env),
    branch,
    head: head.ok ? head.stdout.trim() : null,
    ...(clear ? {} : { why }),
  });
  if (!row.ok) return emit(io, fail(row.code, row.error));
  if (clear)
    return emit(
      io,
      ok({ branch, held: false, cleared: true }),
      () => `cleared the hold on ${branch}`,
    );
  return emit(io, ok({ branch, held: true, why }), () => [
    `held ${branch}: the Stop hook no longer asks to push or open a PR for it`,
    "it ends at the next `workit git push` or `workit git hold --clear`; grants and the endpoint are unchanged",
  ]);
}
