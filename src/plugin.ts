import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { createTools } from "./tools";
import { adaptPluginHandoffClient } from "./tools/handoff";
import { WorkflowStateStore } from "./state";

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

const withoutHeredocBodies = (source: string) => {
const heredocMarker = (line: string) => {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length - 1; i++) {
    const char = line[i];
    if (char === "\\") { i++; continue; }
    if (char === "'" && !double) { single = !single; continue; }
    if (char === '"' && !single) { double = !double; continue; }
    if (single || double || char !== "<" || line[i + 1] !== "<") continue;
    let cursor = i + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor++;
    while (/\s/.test(line[cursor] ?? "")) cursor++;
    const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor++] : "";
    const start = cursor;
    if (quote) while (cursor < line.length && line[cursor] !== quote) cursor++;
    else while (cursor < line.length && !/[\s;&|()<>]/.test(line[cursor])) cursor++;
    const delimiter = line.slice(start, cursor);
    return delimiter ? { delimiter, stripTabs } : undefined;
  }
  return undefined;
};

  const lines = source.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const marker = heredocMarker(line);
    if (!marker) continue;
    while (++i < lines.length && (marker.stripTabs ? lines[i].replace(/^\t+/, "") : lines[i]) !== marker.delimiter) {
      // Heredoc bodies are data, not shell commands.
    }
  }
  return kept.join("\n");
};

const substitutions = (source: string) => {
  const found: string[] = [];
  let single = false;
  let double = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "'" && !double) { single = !single; continue; }
    if (char === '"' && !single) { double = !double; continue; }
    if (single) continue;
    if (char === "`") {
      const end = source.indexOf("`", i + 1);
      if (end !== -1) { found.push(source.slice(i + 1, end)); i = end; }
      continue;
    }
    if (char === "$" && source[i + 1] === "(") {
      let depth = 1;
      let end = i + 2;
      for (; end < source.length && depth; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")") depth--;
      }
      if (depth === 0) { found.push(source.slice(i + 2, end - 1)); i = end - 1; }
    }
  }
  return found;
};

const shellSegments = (source: string) => {
  const segments: string[][] = [[]];
  let word = "";
  let quote = "";
  const push = () => { if (word) segments.at(-1)?.push(word); word = ""; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && i + 1 < source.length) word += source[++i];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "\\" && i + 1 < source.length) { word += source[++i]; continue; }
    if (char === "\n" || ";&|(){}".includes(char)) { push(); segments.push([]); continue; }
    if (/\s/.test(char)) { push(); continue; }
    word += char;
  }
  push();
  return segments.filter((segment) => segment.length);
};

const unwrapCommand = (words: string[]) => {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
  const controlWords = new Set(["!", "if", "then", "elif", "else", "while", "until", "do", "time"]);
  while (index < words.length) {
    const command = path.basename(words[index]);
    if (controlWords.has(words[index])) { index++; continue; }
    if (command === "command") {
      index++;
      while (words[index]?.startsWith("-") && words[index] !== "--") index++;
      if (words[index] === "--") index++;
      continue;
    }
    if (command === "env") {
      index++;
      while (index < words.length) {
        const word = words[index];
        if (word === "--") { index++; break; }
        if (word === "-u" || word === "--unset") { index += 2; continue; }
        if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index++; continue; }
        break;
      }
      continue;
    }
    if (command === "sudo") {
      const takesValue = new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t"]);
      index++;
      while (words[index]?.startsWith("-")) index += takesValue.has(words[index]) ? 2 : 1;
      continue;
    }
    break;
  }
  return words.slice(index);
};

const segmentUsesGitWorktree = (segment: string[]): boolean => {
  const words = unwrapCommand(segment);
  const command = path.basename(words[0] ?? "");
  if (["bash", "sh", "zsh"].includes(command)) {
    const option = words.findIndex((word) => /^-[^-]*c/.test(word) || word === "--command");
    return option !== -1 && isGitWorktreeCommand(words[option + 1]);
  }
  if (command !== "git") return false;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") return words[i + 1] === "worktree";
    if (!word.startsWith("-")) return word === "worktree";
    if (takesValue.has(word)) i++;
  }
  return false;
};

export const isGitWorktreeCommand = (command: unknown): boolean => {
  if (typeof command !== "string") return false;
  const source = withoutHeredocBodies(command);
  return substitutions(source).some(isGitWorktreeCommand)
    || shellSegments(source).some(segmentUsesGitWorktree);
};

const plugin: Plugin = async ({ client }) => {
  const state = new WorkflowStateStore();
  return {
    tool: createTools(adaptPluginHandoffClient(client), state),
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
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && isGitWorktreeCommand(output.args?.command)) {
        throw new Error(
          "Workflow Toolkit: worktrees are forbidden; use workflow_resolve_branch and workflow_branch_setup for an in-place feature/* or bugfix/* branch.",
        );
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = state.compactionContext(sessionID);
      if (context) output.context.push(context);
    },
  };
};

export default plugin;
