import { rawGitPre, shellPolicy, shellWrites, writeGate } from "@brainervirus/workit-core/hooks";

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
 * before-write gate (S17) on edits and recognizable shell writes. Every
 * other permission keeps the host's own decision.
 */
export const evaluateShellPermission = (root: string, event: PermissionEvaluationEvent): void => {
  if (event.effect === "deny") return;
  const deny = (reason: string) => {
    event.effect = "deny";
    event.message = reason;
  };
  const resources = event.resources.filter(
    (resource): resource is string => typeof resource === "string",
  );
  if (WRITE_ACTIONS.has(event.action)) {
    const decision = writeGate(root, resources);
    if (decision.kind === "deny") deny(decision.reason);
    return;
  }
  if (event.action !== "shell") return;
  for (const resource of resources) {
    const decision = shellPolicy(root, resource);
    if (decision.kind === "deny") return deny(decision.reason);
    const raw = rawGitPre(
      {
        host: "opencode",
        cwd: root,
        session: { id: event.sessionID ?? "", agentId: null, agentType: null, parentId: null },
        permissionMode: null,
        transcriptPath: null,
        event: { kind: "shell.pre", command: resource, toolUseId: null },
      },
      resource,
      { pending: false },
    );
    if (raw.kind === "deny") return deny(raw.reason);
    const writes = shellWrites(resource);
    const gated = writes.writes ? writeGate(root, writes.targets) : null;
    if (gated?.kind === "deny") return deny(gated.reason);
  }
};
