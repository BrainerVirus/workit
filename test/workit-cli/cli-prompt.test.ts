import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPromptAbort } from "@/packages/workit-cli/src/prompt";

// The CLI's confirmation prompts treat an interrupted question as a
// cancellation. Published bundles run on Node.js, whose readline/promises
// rejects a pending question with an AbortError on ^C; pin that against the
// real module (Bun's readline does not emulate ^C) so a runtime change cannot
// silently turn ^C back into an uncaught_failure.

const promptModule = pathToFileURL(
  path.join(import.meta.dir, "../../packages/workit-cli/src/prompt.ts"),
).href;

test("given a pending confirmation on Node, when the user presses Ctrl+C, then askOrCancel reports Cancelled. and yields null", () => {
  const script = `
    import { createInterface } from "node:readline/promises";
    import { PassThrough } from "node:stream";
    import { askOrCancel } from ${JSON.stringify(promptModule)};
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough(), terminal: true });
    let stderr = "";
    const io = { json: false, cwd: ".", env: {}, stdout: () => {}, stderr: (t) => { stderr += t; } };
    const pending = askOrCancel(io, () => rl.question("Type the workspace name: "));
    input.write("\\x03");
    const answer = await pending;
    process.stdout.write(JSON.stringify({ answer, stderr }));
  `;
  const run = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(run.stderr).not.toContain("uncaught");
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ answer: null, stderr: "\nCancelled.\n" });
});

test("isPromptAbort recognizes only abort rejections", () => {
  expect(isPromptAbort(new DOMException("aborted", "AbortError"))).toBe(true);
  expect(isPromptAbort(new Error("boom"))).toBe(false);
  expect(isPromptAbort("AbortError")).toBe(false);
  expect(isPromptAbort(null)).toBe(false);
});
