import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  detectBlindReviewAcceptance,
  detectFixWithoutRootCause,
  detectImplementationWithoutDesign,
  detectUntestedImplementation,
  detectVerificationClaim,
} from "../packages/workit/src/core/detector";
import {
  BRAINSTORM_TEXT,
  DEBUG_TEXT,
  REVIEW_RECEPTION_TEXT,
  TDD_TEXT,
  VERIFICATION_TEXT,
  shouldInjectBrainstorm,
  shouldInjectDebug,
  shouldInjectReviewReception,
  shouldInjectTdd,
  shouldInjectVerification,
} from "../packages/workit/src/core/reminder";

test("CA-02: verification detector fires on completion claim without check output", () => {
  expect(detectVerificationClaim("All done. The bug is fixed.")).toBe(true);
  expect(detectVerificationClaim("Tests are passing, everything is green.")).toBe(true);
});

test("CA-02: verification detector does NOT fire when a check command is present", () => {
  expect(detectVerificationClaim("All fixed — bun run check passes: 380 pass / 0 fail")).toBe(false);
  expect(detectVerificationClaim("Done after workflow_verify confirmed the build.")).toBe(false);
  expect(detectVerificationClaim("Complete — bun test shows all green.")).toBe(false);
});

test("CA-02: verification detector does NOT fire on a clean message", () => {
  expect(detectVerificationClaim("I'll run the check and report back.")).toBe(false);
  expect(detectVerificationClaim("")).toBe(false);
  expect(detectVerificationClaim("Still investigating the failure.")).toBe(false);
});

test("CA-02: verification evidence requires word boundaries (review I-1)", () => {
  expect(detectVerificationClaim("All done — tests pass.")).toBe(false);
  expect(detectVerificationClaim("fixed, passing")).toBe(true);
  expect(detectVerificationClaim("bun run check passes: 402 pass")).toBe(false);
});

test("CA-02: TDD detector fires on implementation without failing-test evidence", () => {
  expect(detectUntestedImplementation("Implemented the parser and committed.")).toBe(true);
  expect(detectUntestedImplementation("Refactored the module and edited the tests.")).toBe(true);
});

test("CA-02: TDD detector does NOT fire with failing-test wording or clean text", () => {
  expect(detectUntestedImplementation("I wrote a failing test first, then implemented the feature.")).toBe(false);
  expect(detectUntestedImplementation("Red-green: watched it fail, then committed the fix.")).toBe(false);
  expect(detectUntestedImplementation("Nothing to report on this turn.")).toBe(false);
});

test("CA-02: brainstorm detector fires on implementation without presented design", () => {
  expect(detectImplementationWithoutDesign("I'll implement the feature now.")).toBe(true);
  expect(detectImplementationWithoutDesign("Let me build this and write the code.")).toBe(true);
});

test("CA-02: brainstorm detector does NOT fire with design wording or clean text", () => {
  expect(detectImplementationWithoutDesign("The design is approved — I'll implement it.")).toBe(false);
  expect(detectImplementationWithoutDesign("Per the spec and plan, I'll build it.")).toBe(false);
  expect(detectImplementationWithoutDesign("Waiting for your feedback before proceeding.")).toBe(false);
});

test("CA-02: brainstorm build signal narrowed + instruction silencer (review I-2)", () => {
  expect(detectImplementationWithoutDesign("Ran bun run build and it compiled")).toBe(false);
  expect(detectImplementationWithoutDesign("I'll implement the feature as you requested")).toBe(false);
  expect(detectImplementationWithoutDesign("I'll implement the feature")).toBe(true);
});

test("CA-02: debugging detector fires on fix without root-cause evidence", () => {
  expect(detectFixWithoutRootCause("Fixed the crash by adding a null check.")).toBe(true);
  expect(detectFixWithoutRootCause("Patched the timeout and solved the issue.")).toBe(true);
});

test("CA-02: debugging detector does NOT fire with root-cause wording or clean text", () => {
  expect(detectFixWithoutRootCause("Root cause: null deref in the parser. Fixed.")).toBe(false);
  expect(detectFixWithoutRootCause("Investigation showed the leak, then I patched it.")).toBe(false);
  expect(detectFixWithoutRootCause("No fixes proposed yet.")).toBe(false);
});

test("CA-02: receiving detector fires on acceptance without verification", () => {
  expect(detectBlindReviewAcceptance("Good point, agreed — thanks for the feedback, I'll implement.")).toBe(true);
  expect(detectBlindReviewAcceptance("That makes sense, will implement right away.")).toBe(true);
});

test("CA-02: receiving detector does NOT fire with verification wording or clean text", () => {
  expect(detectBlindReviewAcceptance("Good point — I verified it against the codebase and it checks out.")).toBe(false);
  expect(detectBlindReviewAcceptance("Agreed, confirmed by the tests I ran.")).toBe(false);
  expect(detectBlindReviewAcceptance("I need to check this against the code first.")).toBe(false);
});

test("CA-02: receiving detector future-tense evidence + politeness removed (review I-3)", () => {
  expect(detectBlindReviewAcceptance("Good point, I'll verify this first")).toBe(false);
  expect(detectBlindReviewAcceptance("Thanks for the feedback, I'll take a look")).toBe(false);
  expect(detectBlindReviewAcceptance("Good point, I'll implement it")).toBe(true);
});

test("CA-02: multiple rails can fire on one turn (composed, no clobber)", () => {
  const text = "Fixed the crash and committed the change.";
  expect(detectVerificationClaim(text)).toBe(true);
  expect(detectUntestedImplementation(text)).toBe(true);
  expect(detectFixWithoutRootCause(text)).toBe(true);
});

test("CA-01: verification rail names the skill and carries the Iron Law", () => {
  expect(VERIFICATION_TEXT).toContain("verification-before-completion");
  expect(VERIFICATION_TEXT).toContain("NO completion claims");
  expect(VERIFICATION_TEXT).toContain("bun run check");
});

test("CA-01: TDD rail names the skill and carries the Iron Law", () => {
  expect(TDD_TEXT).toContain("test-driven-development");
  expect(TDD_TEXT).toContain("NO production code");
  expect(TDD_TEXT).toContain("failing test first");
});

test("CA-01: brainstorm rail names the skill and carries the Iron Law", () => {
  expect(BRAINSTORM_TEXT).toContain("brainstorming");
  expect(BRAINSTORM_TEXT).toContain("presented and approved");
  expect(BRAINSTORM_TEXT).toContain("NO implementation");
});

test("CA-01: debugging rail names the skill and carries the Iron Law", () => {
  expect(DEBUG_TEXT).toContain("systematic-debugging");
  expect(DEBUG_TEXT).toContain("NO fixes");
  expect(DEBUG_TEXT).toContain("root cause");
});

test("CA-01: receiving rail names the skill and carries the Iron Law", () => {
  expect(REVIEW_RECEPTION_TEXT).toContain("receiving-code-review");
  expect(REVIEW_RECEPTION_TEXT).toContain("Verify before implementing");
});

test("CA-03: shouldInject helpers are marker-based idempotent", () => {
  expect(shouldInjectVerification(VERIFICATION_TEXT)).toBe(false);
  expect(shouldInjectVerification(`msg with ${VERIFICATION_TEXT} marker`)).toBe(false);
  expect(shouldInjectVerification("plain message")).toBe(true);
  expect(shouldInjectTdd(TDD_TEXT)).toBe(false);
  expect(shouldInjectTdd("plain message")).toBe(true);
  expect(shouldInjectBrainstorm(BRAINSTORM_TEXT)).toBe(false);
  expect(shouldInjectBrainstorm("plain message")).toBe(true);
  expect(shouldInjectDebug(DEBUG_TEXT)).toBe(false);
  expect(shouldInjectDebug("plain message")).toBe(true);
  expect(shouldInjectReviewReception(REVIEW_RECEPTION_TEXT)).toBe(false);
  expect(shouldInjectReviewReception("plain message")).toBe(true);
});

test("CA-03: each rail fires on its signal (detector true and shouldInject true)", () => {
  expect(detectVerificationClaim("All done, the bug is fixed.")).toBe(true);
  expect(shouldInjectVerification("next user turn")).toBe(true);
  expect(detectUntestedImplementation("Implemented the parser and committed.")).toBe(true);
  expect(shouldInjectTdd("next user turn")).toBe(true);
  expect(detectImplementationWithoutDesign("I'll implement the feature now.")).toBe(true);
  expect(shouldInjectBrainstorm("next user turn")).toBe(true);
  expect(detectFixWithoutRootCause("Fixed the crash by adding a null check.")).toBe(true);
  expect(shouldInjectDebug("next user turn")).toBe(true);
  expect(detectBlindReviewAcceptance("Good point, agreed — thanks for the feedback.")).toBe(true);
  expect(shouldInjectReviewReception("next user turn")).toBe(true);
});

test("CA-04: three rails compose on one assistant text, markers distinct", () => {
  const assistant = "All done. Implemented the feature. Good point, I'll fix it.";
  expect(detectVerificationClaim(assistant)).toBe(true);
  expect(detectUntestedImplementation(assistant)).toBe(true);
  expect(detectBlindReviewAcceptance(assistant)).toBe(true);
  expect(shouldInjectVerification("next user turn")).toBe(true);
  expect(shouldInjectTdd("next user turn")).toBe(true);
  expect(shouldInjectReviewReception("next user turn")).toBe(true);
  const composed = `${VERIFICATION_TEXT}\n${TDD_TEXT}\n${REVIEW_RECEPTION_TEXT}`;
  expect(composed).toContain("workflow-verification-rail");
  expect(composed).toContain("workflow-tdd-rail");
  expect(composed).toContain("workflow-review-reception-rail");
});

test("CA-04: all five rails use distinct part tags in plugin.ts", () => {
  const src = readFileSync(path.join(import.meta.dir, "..", "packages", "workit", "src", "plugin.ts"), "utf8");
  const tags = [...src.matchAll(/makePart\([^,\n]+,\s*"([a-z]+)"\)/g)].map((m) => m[1]);
  expect(tags).toContain("vf");
  expect(tags).toContain("tdd");
  expect(tags).toContain("br");
  expect(tags).toContain("db");
  expect(tags).toContain("rc");
  expect(new Set(tags).size).toBe(tags.length);
});

test("CA-03: fail-closed — all five detectors no-op on empty/weird input", () => {
  expect(detectVerificationClaim("")).toBe(false);
  expect(detectUntestedImplementation("")).toBe(false);
  expect(detectImplementationWithoutDesign("")).toBe(false);
  expect(detectFixWithoutRootCause("")).toBe(false);
  expect(detectBlindReviewAcceptance("")).toBe(false);
  expect(detectVerificationClaim("\u0000\u0001\u0002")).toBe(false);
  expect(detectFixWithoutRootCause("\u0000\u0001\u0002")).toBe(false);
});
