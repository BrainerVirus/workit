// The check rollup a PR status may trust (#646 root): GitHub's
// `commits(last: 1)` can still describe an older commit for a moment after a
// push, so its rollup is that commit's result, not the head's. Read for the
// current head, a stale rollup would report the old run's success or pending.

/** The commit's rollup when that commit is the PR head, else null (no checks reported yet). */
export const rollupForHead = <R>(
  commit: { oid: string; statusCheckRollup: R | null } | undefined,
  headSha: string,
): R | null => (commit && commit.oid === headSha ? commit.statusCheckRollup : null);
