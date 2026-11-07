// Write verbs (`ledger`, `git commit`) make sure the current branch has its
// implicit task (design §4.1, D3), so `workit task status` shows the work
// without an explicit start. Best effort: the verb's own result never
// depends on it.
import { checkRoot } from "@workit-dev/core/src/check-config";
import { currentBranch } from "@workit-dev/core/src/git/rev";
import type { Io } from "../output";
import { hostSessionFromEnv } from "@workit-dev/core/src/host-session";

export async function ensureImplicitTask(
  io: Io,
  branch: string | null = null,
): Promise<{ id: string; created: boolean } | null> {
  try {
    // Only the checked-out branch has an implicit task here.
    if (branch !== null && branch !== currentBranch(io.cwd)) return null;
    const { TaskStore } = await import("@workit-dev/core/src/core/task-store");
    const store = new TaskStore(io.env.WORKIT_WORKSPACE_ROOT || checkRoot(io.cwd));
    const actor = hostSessionFromEnv(io.env).session ?? "cli";
    const found = store.implicitTask({
      provenance: {
        kind: "host_observed",
        host: "workit_cli",
        session: { kind: "host", host: "workit_cli", handle: actor },
        workerId: null,
      },
    });
    return found.ok && found.data ? { id: found.data.task.id, created: found.data.created } : null;
  } catch {
    return null;
  }
}
