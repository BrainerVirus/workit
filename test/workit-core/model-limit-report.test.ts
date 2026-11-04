// #710 nit: a worker report that merely names a provider's limit message is
// not that message, so it must not mark the provider exhausted.
import { expect, test } from "bun:test";
import { parseUsageLimit } from "@/packages/workit-core/src/hooks/model-limit";

const NOW = new Date("2026-11-04T00:00:00Z");

test("Given a worker report quoting the 5-hour limit reached message, When parsed, Then it is no usage limit", () => {
  for (const report of [
    "Implemented: the 5-hour limit reached message is now parsed.",
    "Done: weekly limit reached banners now show the reset time.",
    "Fixed the Claude usage limit reached handling in the hook.",
  ])
    expect(parseUsageLimit(report, NOW)).toBeNull();
});

test("Given the provider's real limit messages, When parsed, Then each is a usage limit", () => {
  expect(
    parseUsageLimit("5-hour limit reached ∙ resets 3:30am (UTC)", NOW)?.resetAt?.toISOString(),
  ).toBe("2026-11-04T03:30:00.000Z");
  expect(parseUsageLimit("Opus limit reached · resets 9am (UTC)", NOW)?.family).toBe("opus");
  expect(parseUsageLimit("Claude AI usage limit reached|1793750400", NOW)).not.toBeNull();
  expect(parseUsageLimit("Claude usage limit reached.", NOW)).not.toBeNull();
  expect(parseUsageLimit("Session limit reached\n", NOW)).not.toBeNull();
});
