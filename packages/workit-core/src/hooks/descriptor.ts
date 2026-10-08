// Per-host capability descriptor. Each host states what it supports, with a
// citation; workit derives engine capabilities from it. An `undocumented`
// axis is treated as `none`: it never backs a guarantee (fail-closed).
import type { Assurance, Capability } from "../core/task-contract";
import type { HookEventKind, HostId } from "./protocol";

export type Support = "native" | "partial" | "none" | "undocumented";

export type HostDescriptor = {
  host: HostId;
  /** Human label used in model-visible text, e.g. "Codex". */
  label: string;
  verifiedAgainst: string;
  docs: string[];
  transport: "hook-process" | "in-process-plugin";
  events: Record<HookEventKind, { support: Support; native: string | null }>;
  shellPolicy: {
    deny: Support;
    channel: "permissionDecision" | "exit2+json" | "effect" | "block" | null;
    /** A parse or handler failure on a pre-tool gate denies instead of passing. */
    failClosed: boolean;
  };
  context: {
    sessionStart: Support;
    perTurn: Support;
    afterCompact: Support;
    /** How the session's current task is chosen: by a session bound to the task
     * record, or the workspace's single active task when sessions never bind. */
    task: "session-bound" | "single-active";
    /** `on-change`: the host keeps each injected context in the transcript, so
     * the core resends per-turn context only when it changed; `every-turn`:
     * the core sends it on every turn (an in-process system-prompt hook needs
     * it each time, or the host plugin dedups itself); `per-session`: the
     * host plugin sends it once per session and again after compaction. */
    turnResend: "on-change" | "every-turn" | "per-session";
  };
  subagents: {
    identity: Support;
    parentBinding: Support;
    blockStart: Support;
    worktreeIsolation: Support;
    maxConcurrency: number | "undocumented";
    /** How a Workit agent type is spelled: plugin-namespaced (`workit:verifier`)
     * on hosts that namespace plugin agents, else a plain `workit-verifier`. */
    agentPrefix: "workit:" | "workit-";
  };
  provenance: { sessionId: Support; agentIdOnTool: Support; postToolObserve: Support };
  /** Host-native interaction boundaries workit can observe. */
  interaction: { questions: Support; writeBoundary: Support };
  stopControl: Support;
  shellAvailable: Support;
  perEventCost: "low" | "npx-network";
  capabilities: CapabilityRule[];
};

/** Descriptor axes a capability can depend on. */
export type Axis =
  | `event:${HookEventKind}`
  | "shellPolicy.deny"
  | `context.${"sessionStart" | "perTurn" | "afterCompact"}`
  | `subagents.${"identity" | "parentBinding" | "blockStart" | "worktreeIsolation"}`
  | `provenance.${"sessionId" | "agentIdOnTool" | "postToolObserve"}`
  | `interaction.${"questions" | "writeBoundary"}`
  | "stopControl"
  | "shellAvailable";

/**
 * One engine capability claim. `assurance` is granted only when every
 * `requires` axis is supported and every `observed` runtime flag is true;
 * `enforced` additionally needs at least one axis, all `native`, and degrades
 * to `agent_guided` otherwise.
 */
export type CapabilityRule = {
  name: string;
  surface: string;
  refs: string[];
  requires: Axis[];
  /** Runtime facts only the running dispatcher can attest (e.g. "subagent.start", "ui"). */
  observed?: string[];
  assurance: Assurance;
  reason: string;
  unavailableReason?: string;
};

export const support = (descriptor: HostDescriptor, axis: Axis): Support => {
  if (axis.startsWith("event:"))
    return descriptor.events[axis.slice("event:".length) as HookEventKind].support;
  if (axis === "shellPolicy.deny") return descriptor.shellPolicy.deny;
  if (axis === "stopControl" || axis === "shellAvailable") return descriptor[axis];
  const [group, key] = axis.split(".") as [
    "context" | "subagents" | "provenance" | "interaction",
    string,
  ];
  return (descriptor[group] as Record<string, Support>)[key];
};

const usable = (value: Support) => value === "native" || value === "partial";

export const capabilitiesFor = (
  descriptor: HostDescriptor,
  observed: Partial<Record<string, boolean>> = {},
): Capability[] =>
  descriptor.capabilities.map((rule) => {
    const levels = rule.requires.map((axis) => support(descriptor, axis));
    const available =
      rule.assurance !== "unavailable" &&
      levels.every(usable) &&
      (rule.observed ?? []).every((flag) => observed[flag] === true);
    const assurance: Assurance = !available
      ? "unavailable"
      : rule.assurance === "enforced" &&
          (levels.length === 0 || levels.some((level) => level !== "native"))
        ? "agent_guided"
        : rule.assurance;
    return {
      name: rule.name,
      surface: rule.surface,
      assurance,
      reason: assurance === "unavailable" ? (rule.unavailableReason ?? rule.reason) : rule.reason,
      refs: rule.refs.map((handle) => ({ kind: "host" as const, host: descriptor.host, handle })),
    };
  });
