// The `draft-in-full` repo rule (#864 drafts): a skill step that puts a draft
// before the user by its path only fails the repo rules; one that has the
// agent paste the whole text passes. The canonical skills hold no such step.
// The bench case: a reply that only names the draft's path fails its grade.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCases } from "@/scripts/eval/cases";
import { grade } from "@/scripts/eval/grade";
import { main } from "@/scripts/repo-rules/check.mts";
import { draftStepHits, scanDraftSteps } from "@/scripts/repo-rules/draft-steps.mts";

const repoRoot = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PATH_ONLY = `# Comment

1. Write the draft comment to \`notes/comment.md\` and give the user its path
   to approve.
2. Run \`workit youtrack note ABC-1 --file notes/comment.md\`.
`;

const IN_FULL = `# Comment

1. Write the draft comment to \`notes/comment.md\`, then paste the whole draft
   in chat for the user's yes; after every edit, paste it again.
`;

/** A tree with one canonical skill holding `text`, one clean source file and an empty baseline. */
const tree = (text: string): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-draft-rule-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/workit-core/skills/demo"), { recursive: true });
  writeFileSync(path.join(root, "packages/workit-core/skills/demo/SKILL.md"), text);
  writeFileSync(path.join(root, "baseline.json"), "{}\n");
  // oxlint refuses a tree with no source to lint.
  writeFileSync(path.join(root, "index.ts"), "export const one = 1;\n");
  return root;
};

const lint = (root: string) => {
  const err: string[] = [];
  const code = main(["--root", root, "--baseline", "baseline.json"], {
    out: () => {},
    err: (line) => void err.push(line),
  });
  return { code, err: err.join("\n") };
};

test("Given a skill whose draft step names only a path, When the repo rules run, Then they fail on that step", () => {
  expect(draftStepHits("SKILL.md", PATH_ONLY)).toMatchObject([{ rule: "draft-in-full", line: 3 }]);
  const out = lint(tree(PATH_ONLY));
  expect(out.code, out.err).toBe(1);
  expect(out.err).toContain(
    "packages/workit-core/skills/demo/SKILL.md:3:1 workit/draft-in-full: this step shows the user a draft by its path only",
  );
});

test("Given a skill whose draft step has the agent paste the whole text, When the repo rules run, Then they pass", () => {
  expect(draftStepHits("SKILL.md", IN_FULL)).toEqual([]);
  const out = lint(tree(IN_FULL));
  expect(out.code, out.err).toBe(0);
});

test("Given the canonical skills, Then no draft step names only a path", () => {
  expect(scanDraftSteps(repoRoot)).toEqual([]);
});

describe("Given the draft-shown-in-full bench case, When a stored run is re-graded", () => {
  const spec = loadCases(path.join(repoRoot, "evals/cases")).find(
    (each) => each.id === "draft-shown-in-full",
  );
  const reply = (result: string) =>
    [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu0",
              name: "Edit",
              input: { file_path: "~/drafts/X-1-comment.md", old_string: "1.2", new_string: "1.3" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu0", content: "ok", is_error: false }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", result }),
    ].join("\n");

  test("Then a reply that only names the path fails it", () => {
    if (!spec) throw new Error("evals/cases/draft-shown-in-full.json is missing");
    const graded = grade(
      reply("Updated the draft in ~/drafts/X-1-comment.md (now says 1.3). Approve when ready."),
      spec,
    );
    expect(graded.pass).toBe(false);
    expect(graded.failures.map((failure) => failure.rule)).toEqual(["answer", "answer", "answer"]);
  });

  test("Then a reply that pastes the whole revised comment passes", () => {
    if (!spec) throw new Error("evals/cases/draft-shown-in-full.json is missing");
    const full = [
      "Here is the revised comment for X-1:",
      "",
      "Fixed the login loop on 401.",
      "",
      "- cause: the stale session cookie survived a logout",
      "- fix: clear it on every 401 response",
      "- ships in 1.3",
    ].join("\n");
    expect(grade(reply(full), spec).failures).toEqual([]);
  });
});
