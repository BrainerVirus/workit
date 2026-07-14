import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { createTools } from "./tools";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const descriptions: Record<string, string> = {
  "wf-init": "Initialize workflow-toolkit configuration",
  "wf-status": "Show workflow and repository status",
  "wf-verify": "Discover and run repository verification",
  "wf-commit": "Review and create a guarded commit",
  "wf-pr": "Prepare or create a pull/merge request",
  "wf-changelog": "Preview and update Keep a Changelog",
  "wf-release-notes": "Draft notes for an explicit release range",
  "wf-docs-refresh": "Refresh documentation affected by changes",
  "wf-handoff": "Continue work in a new seeded OpenCode session",
  "wf-implement": "Execute an approved Superpowers plan",
  "wf-meetings": "Log confirmed meeting time in YouTrack",
  "wf-issue-update": "Post a confirmed YouTrack work update",
};

const plugin: Plugin = async () => ({
  tool: createTools(),
  config: async (config) => {
    const mutable = config as typeof config & { skills?: { paths?: string[] } };
    config.command ??= {};
    for (const [name, description] of Object.entries(descriptions)) {
      config.command[name] = {
        description,
        template: readFileSync(path.join(root, "commands", `${name}.md`), "utf8").trim(),
      };
    }
    mutable.skills ??= {};
    mutable.skills.paths ??= [];
    const skillPath = path.join(root, "skills");
    if (!mutable.skills.paths.includes(skillPath)) mutable.skills.paths.push(skillPath);
  },
});

export default plugin;
