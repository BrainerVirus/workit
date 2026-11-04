// Retro W2.35: a host lists an agent as running while any background command
// it started lives, so every shipped agent definition tells it to stop them.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const RULE =
  "Before your final report, wait for or stop every background command you started\n(the host shows you running while one lives); never report with one still running.";

test.each([
  ["packages/workit-claude-code/agents/implementer.md"],
  ["packages/workit-claude-code/agents/verifier.md"],
  ["packages/workit-claude-code/agents/reviewer.md"],
  ["packages/workit-codex/agents/workit-implementer.toml"],
  ["packages/workit-codex/agents/workit-verifier.toml"],
  ["packages/workit-codex/agents/workit-reviewer.toml"],
])(
  "Given the agent definition %s, When it is read, Then it tells the agent to stop its background commands before the final report",
  (file) => {
    expect(readFileSync(path.join(ROOT, file), "utf8")).toContain(RULE);
  },
);

test.each([
  ["packages/workit-core/skills/workit-fanout/SKILL.md"],
  ["packages/workit-cursor/skills/workit-fanout/SKILL.md"],
])(
  "Given the fanout skill %s, When step 5 is read, Then it tells the lead to stop a worker whose final report arrived",
  (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const step5 = text.slice(text.indexOf("\n5. "), text.indexOf("\n6. "));
    expect(step5).toContain("stop a finished one when its");
    expect(step5).toContain("TaskStop");
  },
);
