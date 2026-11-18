// Cursor agents for the Workit judge, decider and babysitter roles (D1),
// rendered from the canonical Claude Code agent definitions
// (packages/workit-claude-code/agents/*.md). Cursor 2026.09 reads a plugin's
// `agents` path (.cursor-plugin/plugin.json) as Markdown agents with `name`,
// `description`, `model` and `permissionMode` (`default` or `readonly`)
// frontmatter. The implementer has none: Cursor's subagentStart keeps denying
// implementers. The files are committed (Cursor discovers the plugin from
// git) and carry no `model`, so the parent's model or the one it names runs.
import { readFileSync } from "node:fs";
import path from "node:path";

const CURSOR_AGENT_ROLES = ["verifier", "reviewer", "decider", "babysitter"] as const;

// The judges keep `default`: they run `workit check` and record a verdict,
// which write Workit state outside the repo.
const READ_ONLY = new Set(["decider"]);

/** Claude Code wording in the canonical body, in Cursor terms. */
const toCursorText = (body: string): string =>
  body
    .replace(/\n\nIn a Claude Code host-isolated worktree[\s\S]*?(?=\n\n)/u, "")
    .replace(/\(`\/workit:([a-z-]+)`\)/gu, "(read the `workit-$1` skill's SKILL.md and follow it)")
    .replace(/`\/workit:([a-z-]+)`/gu, "`workit-$1`")
    // Cursor puts no session id in the shell: the brief declares the verifier's.
    .replace(
      /\(it\s+carries your session and `--token=<token>`;[^)]*\)/gu,
      "(it names no --session or --token: the WORKIT_SESSION_ID your brief sets is your session)",
    )
    .replaceAll(" --session <id> --token=<token>", "");

/** One Cursor agent file rendered from the canonical Claude agent. */
const renderCursorAgent = (role: string, canonical: string): string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(canonical);
  if (!match) throw new Error(`agent ${role} has no frontmatter`);
  const description = /^description:\s*(.+)$/mu.exec(match[1])?.[1].trim() ?? "";
  return [
    "---",
    `name: workit-${role}`,
    `description: ${description}`,
    `permissionMode: ${READ_ONLY.has(role) ? "readonly" : "default"}`,
    "---",
    "",
    `${toCursorText(match[2].trim())}\n`,
  ].join("\n");
};

/** Every Cursor agent file (`workit-<role>.md`) rendered from `claudeAgentsDir`. */
export const renderCursorAgents = (claudeAgentsDir: string): Map<string, string> =>
  new Map(
    CURSOR_AGENT_ROLES.map((role) => [
      `workit-${role}.md`,
      renderCursorAgent(role, readFileSync(path.join(claudeAgentsDir, `${role}.md`), "utf8")),
    ]),
  );
