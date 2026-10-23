import {
  heavyGate,
  isAllowedWorkitCommand,
  liveOwner,
  rawGitPre,
  shellGate,
  shellPolicy,
  writeGate,
} from "@brainervirus/workit-core/hooks";

export type PermissionEvaluationEvent = {
  sessionID?: string;
  action: string;
  resources: ReadonlyArray<string>;
  effect: string;
  message?: string;
};

const WRITE_ACTIONS = new Set(["edit", "write", "patch"]);

/**
 * Branch policy on direct literal branch-creation commands, raw git/forge
 * gate bypasses (`gh pr merge`, a push onto a protected branch), and the
 * before-write gate (S17) on edits and recognizable shell writes, and the
 * live-session guard (#274) on edits, shell writes and mutating git. Every
 * other permission keeps the host's own decision.
 */
export const evaluateShellPermission = (
  root: string,
  event: PermissionEvaluationEvent,
  workdirs: ReadonlyMap<string, string> = new Map(),
): void => {
  if (event.effect === "deny") return;
  const deny = (reason: string) => {
    event.effect = "deny";
    event.message = reason;
  };
  const resources = event.resources.filter(
    (resource): resource is string => typeof resource === "string",
  );
  // OpenCode runs every session (and its subagents) in this server process.
  const owner = liveOwner(
    { host: "opencode", session: { id: event.sessionID ?? "", parentId: null } },
    "in-process-plugin",
  );
  if (WRITE_ACTIONS.has(event.action)) {
    const decision = writeGate(root, resources, owner);
    if (decision.kind === "deny") deny(decision.reason);
    return;
  }
  if (event.action !== "shell") return;
  for (const resource of resources) {
    // The shell tool's workdir, noted by execute.before for this session; its
    // shell is bash (POSIX), like the other hosts' Bash tools.
    const cwd = (event.sessionID && workdirs.get(event.sessionID)) || root;
    const decision = shellPolicy(cwd, resource, "posix");
    if (decision.kind === "deny") return deny(decision.reason);
    const raw = rawGitPre(
      {
        host: "opencode",
        cwd,
        session: { id: event.sessionID ?? "", agentId: null, agentType: null, parentId: null },
        permissionMode: null,
        transcriptPath: null,
        event: { kind: "shell.pre", command: resource, toolUseId: null },
      },
      resource,
      // The nudge rides the tool result (shell.ts): only the deny is read here.
      { nudge: false },
    );
    if (raw.kind === "deny") return deny(raw.reason);
    const gated = shellGate(cwd, resource, owner);
    if (gated.kind === "deny") return deny(gated.reason);
    // A chain with heavy parts the host would allow outright: run them alone
    // under the lease. An ask or deny stands (#325).
    if (event.effect === "allow") {
      const plan = heavyGate(cwd, resource, { host: "opencode" });
      if (plan.kind === "split") return deny(plan.reason);
    }
  }
  // Issue #297: an ask for Workit's enumerated delivery verbs only becomes an
  // allow; their own grants and verdict gates decide. Never check, lock or
  // grant, never a bypass flag; a config deny returned above already.
  if (
    event.effect === "ask" &&
    resources.length > 0 &&
    resources.length === event.resources.length &&
    resources.every(isAllowedWorkitCommand)
  )
    event.effect = "allow";
};
