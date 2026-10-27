// The context-budget ratchet (#425): what Workit adds to an agent's context
// may only change on purpose. A drift in either direction fails until the
// committed budget is rewritten (`bun run write:budget`); a growth also needs
// the `context-increase` label in CI.
import { expect, test } from "bun:test";
import { measureBudget, readBudget } from "./context-budget";

test("Given the committed context budget, When Workit's agent-facing text is measured, Then every item matches it", async () => {
  const measured = await measureBudget();
  const committed = readBudget();
  const drift = Object.keys({ ...measured, ...committed })
    .filter((key) => measured[key] !== committed[key])
    .map(
      (key) => `${key}: committed ${committed[key] ?? "none"}, measured ${measured[key] ?? "none"}`,
    );
  if (drift.length)
    throw new Error(
      `context budget drifted (run \`bun run write:budget\`; growth needs the context-increase PR label):\n${drift.join("\n")}`,
    );
  expect(drift).toEqual([]);
}, 60_000);
