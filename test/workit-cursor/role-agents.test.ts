// D1 on Cursor: the plugin ships the verifier, reviewer, decider and
// babysitter agents through its manifest's `agents` path, rendered from the
// canonical Claude Code agents and committed (Cursor discovers the plugin
// from git). They name no model, so the parent's or the one it passes runs.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderCursorAgents } from "@/packages/workit-cursor/scripts/agents";

const root = path.resolve(import.meta.dir, "../..");
const cursor = path.join(root, "packages/workit-cursor");

test("G the canonical Claude agents, W the Cursor build renders them, T the four committed agent files match (regenerate: bun packages/workit-cursor/scripts/build.ts --skills-only)", () => {
  const rendered = renderCursorAgents(path.join(root, "packages/workit-claude-code/agents"));
  expect(readdirSync(path.join(cursor, "agents")).toSorted()).toEqual([
    "workit-babysitter.md",
    "workit-decider.md",
    "workit-reviewer.md",
    "workit-verifier.md",
  ]);
  for (const [file, text] of rendered)
    expect(readFileSync(path.join(cursor, "agents", file), "utf8"), file).toBe(text);
});

test("G the Cursor plugin, W it is installed, T its manifest and package ship the agents dir", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(cursor, ".cursor-plugin/plugin.json"), "utf8"),
  );
  expect(manifest.agents).toBe("agents/");
  const pkg = JSON.parse(readFileSync(path.join(cursor, "package.json"), "utf8"));
  expect(pkg.files).toContain("agents/");
});

test("G a rendered agent, T it names workit-<role>, carries no model and no Claude Code wording; only the decider is read-only", () => {
  for (const [file, text] of renderCursorAgents(
    path.join(root, "packages/workit-claude-code/agents"),
  )) {
    const role = file.replace(/^workit-|\.md$/gu, "");
    expect(text, file).toStartWith(`---\nname: workit-${role}\n`);
    expect(text, file).not.toMatch(/^model:/mu);
    expect(text, file).not.toContain("/workit:");
    expect(text, file).not.toContain("--token=<token>");
    expect(text, file).toContain(`permissionMode: ${role === "decider" ? "readonly" : "default"}`);
  }
});
