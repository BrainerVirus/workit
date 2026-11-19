// `workit git rebase [--onto <base>]`: replay the current branch onto its
// freshly fetched base. A conflict aborts the rebase, so the branch is left
// exactly where it was; a rewrite is recorded and names the leased push. A
// conflict only in the workspace changelog that merges entry by entry (both
// sides appended under Unreleased) is settled and the rebase goes on (#791).
// The engine lives in core (forge/merge-rebase-onto.ts), shared with `pr merge`.
import { rebaseOnto, type RebaseOutcome } from "@workit-dev/core/src/forge/merge-rebase-onto";
import { emit, ok, type Io } from "../output";
import { forgeFail } from "./forge-common";

const short = (sha: string): string => sha.slice(0, 12);

/** `workit git rebase` once git.ts has parsed `--onto`. */
export function rebase(onto: string | null, io: Io): number {
  const result = rebaseOnto(io.cwd, io.env, onto);
  if (!result.ok) {
    const data =
      "conflicts" in result
        ? { reason: "rebase_conflict", conflicts: result.conflicts }
        : undefined;
    return forgeFail(io, result, data);
  }
  return emit(io, ok(result.data), (data: RebaseOutcome) =>
    data.rebased
      ? [
          `rebased ${data.branch} onto ${data.base} (${short(data.baseSha)}): ${short(data.previous)} -> ${short(data.head)}, ${data.commits} commit${data.commits === 1 ? "" : "s"}`,
          ...(data.changelogMerged.length
            ? [
                `changelog: kept both sides' Unreleased entries in ${data.changelogMerged.join(", ")}`,
              ]
            : []),
          ...(data.recorded && "error" in data.recorded
            ? [`ledger: not recorded (${data.recorded.error})`]
            : []),
          `next: ${data.next}`,
        ]
      : [`${data.branch} is already up to date with ${data.base} (${short(data.baseSha)})`],
  );
}
