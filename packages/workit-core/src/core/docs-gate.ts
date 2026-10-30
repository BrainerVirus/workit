// The docs check `workit pr create` runs when a workspace sets
// `docs: when-user-facing`. It never blocks: the docs pass is the ship skill's
// step, and this check records whether the PR shows it (a doc file in the
// diff, or a "Docs" line in the body the skill asks for when nothing changed).
import { changedSince, nonUserFacingType, type ForkPoint } from "./changelog-gate";
import { appendObserved, type LedgerActor } from "../ledger";
import type { DocsMode } from "./workspaces";

export type DocsGate =
  | { status: "off" }
  | { status: "not-user-facing"; type: string }
  | { status: "updated"; files: string[] }
  | { status: "reported" }
  | { status: "unconfirmed" }
  | { status: "base-unknown"; base: string; remote: string };

const DOC_FILE = /\.(?:md|mdx|rst|adoc)$/iu;
const CHANGELOG_FILE = /(?:^|\/)(?:changelog|changes|history)(?:\.[a-z]+)?$/iu;
const DOCS_LINE = /^\s*(?:#{1,6}\s*)?docs\b/imu;

/** Whether the PR titled `title` shows its docs pass under `mode`. */
export function docsGate(input: {
  cwd: string;
  mode: DocsMode;
  title: string;
  body: string | null;
  forkPoint: () => ForkPoint;
}): DocsGate {
  if (input.mode === "off") return { status: "off" };
  const type = nonUserFacingType(input.title);
  if (type) return { status: "not-user-facing", type };
  const point = input.forkPoint();
  if (!point.fork) return { status: "base-unknown", base: point.base, remote: point.remote };
  const files = changedSince(input.cwd, point.fork).filter(
    (file) => DOC_FILE.test(file) && !CHANGELOG_FILE.test(file),
  );
  if (files.length) return { status: "updated", files };
  return DOCS_LINE.test(input.body ?? "") ? { status: "reported" } : { status: "unconfirmed" };
}

/** One `pr create` check outcome as it is printed and recorded. */
export type PrCheckOutcome = { check: "changelog" | "docs"; status: string; line: string };

const LINE_LIMIT = 1000;

/**
 * Record each outcome as an observed `pr.check` row on `branch` at `head`,
 * so the ledger shows whether the step ran, passed, was skipped or blocked.
 */
export function recordPrChecks(
  cwd: string,
  context: { actor: LedgerActor; branch: string | null; head: string | null; base: string },
  outcomes: readonly PrCheckOutcome[],
): string | null {
  for (const outcome of outcomes) {
    const row = appendObserved(cwd, {
      type: "pr.check",
      actor: context.actor,
      branch: context.branch,
      head: context.head,
      base: context.base,
      check: outcome.check,
      status: outcome.status,
      line: outcome.line.slice(0, LINE_LIMIT),
    });
    if (!row.ok) return row.error;
  }
  return null;
}
