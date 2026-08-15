import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Host-neutral post-plan menu wording and the handoff destination marker
 * (CA-07, CA-08). Import-light by design: session-start hooks and reminder
 * selection consume these constants WITHOUT dragging in the full flow-state
 * graph (approval digests, verification, repo-context), so a read-only hook
 * stays network-free by source inspection (RL-09/CA-25).
 */

/** Display labels the source menu presents (CA-08). */
export const SOURCE_MENU_LABELS = [
  "Subagent-driven",
  "Inline",
  "Handoff",
  "Review spec first",
  "Review plan first",
] as const;

/** Display labels a marked destination presents — exactly four, no Handoff (CA-08). */
export const DESTINATION_MENU_LABELS = [
  "Subagent-driven",
  "Inline",
  "Review spec first",
  "Review plan first",
] as const;

/**
 * The exact sentinel every generated destination contract carries on its own
 * line (CA-07). Host-neutral by design (CA-10): OpenCode seeded sessions,
 * Cursor copy/paste prompts, and CLI output all detect a destination by this
 * marker alone — no session IDs, parent IDs, or host metadata.
 */
export const HANDOFF_DESTINATION_MARKER =
  "<workflow-handoff-destination>true</workflow-handoff-destination>";

/**
 * Marked handoff destinations in a workspace (CA-07, CA-08): the persisted
 * `handoff_destination: true` flag that `markHandoffDestination` sets atomically
 * AFTER a genuine generated destination prompt succeeds. Hosts use this at
 * session start to select the destination reminder (four choices, no Handoff)
 * without session or parent IDs. The flag is cleared by approval-drift resets
 * AND by completion (a completed flow is never a destination); only a new-flow
 * `prepareFlowState` initializes it (false), and `markHandoffDestination` is
 * the sole true-setter. Raw read only: a session-start hook must never
 * reconcile or rewrite flow state, so a stale flag may read true until the
 * next effective read resets it — safe bias toward destination wording.
 * ponytail: raw flag scan, not readEffectiveFlowState — a hook is read-only;
 * reconcile-on-drift is the mutation path's job.
 */
export const findMarkedDestinations = (root: string): string[] => {
  const docsDir = path.join(root, "docs");
  if (!existsSync(docsDir)) return [];
  const slugs: string[] = [];
  for (const slug of readdirSync(docsDir)) {
    const file = path.join(docsDir, slug, "sdd", "flow.json");
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { handoff_destination?: unknown };
      if (parsed.handoff_destination === true) slugs.push(slug);
    } catch {
      // a malformed flow.json excludes the entry without touching it
      continue;
    }
  }
  return slugs;
};
