// `workit finding record --queue [<issue>]` (#439): a finding reaches the
// tracker as a new issue, or as a comment on an open one, so it is not left
// in a ledger only the recording session reads.
import type { Ref } from "./task-contract";

const TITLE_MAX = 120;

const refLine = (ref: Ref): string =>
  ref.kind === "file"
    ? `\`${ref.path}\``
    : ref.kind === "external"
      ? ref.url
      : ref.kind === "record"
        ? `${ref.collection}/${ref.id}`
        : `${ref.host}:${ref.handle}`;

/** The issue title and body (or comment body) for a finding. */
export function findingIssueText(finding: {
  claim: string;
  consequence: string;
  refs: readonly Ref[];
}): { title: string; body: string } {
  const claim = finding.claim.trim().replace(/\s+/gu, " ");
  const title = claim.length > TITLE_MAX ? `${claim.slice(0, TITLE_MAX - 1)}…` : claim;
  const body = [
    finding.claim.trim(),
    "",
    `Consequence: ${finding.consequence.trim()}`,
    ...(finding.refs.length
      ? ["", "Refs:", ...finding.refs.map((ref) => `- ${refLine(ref)}`)]
      : []),
    "",
    "Queued by `workit finding record --queue`.",
  ].join("\n");
  return { title, body };
}
