import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
} from "@brainervirus/workit-core/src/core/skill-manifests";
import { assetsRoot } from "../shared/assets";

type SkillDefinition = {
  id: string;
  name: string;
  description?: string;
  location: string;
  content: string;
};

type CommandDefinition = {
  name: string;
  description?: string;
  execute: (input: {
    sessionID: string;
    prompt: { text: string; files?: unknown; agents?: unknown; skills?: unknown };
    delivery: unknown;
  }) => Promise<void>;
};

type SkillContext = {
  skill: {
    list: () => Promise<{ data?: ReadonlyArray<{ id: string }> }>;
    transform: (
      fn: (editor: {
        list: () => ReadonlyArray<{ id: string }>;
        add: (skill: SkillDefinition) => void;
      }) => void,
    ) => Promise<unknown>;
  };
  command: {
    list: () => Promise<{ data?: ReadonlyArray<{ name: string }> }>;
    transform: (
      fn: (editor: { add: (command: CommandDefinition) => void }) => void,
    ) => Promise<unknown>;
  };
  session: {
    prompt: (input: Record<string, unknown>) => Promise<unknown>;
  };
};

const parseFrontmatter = (
  markdown: string,
): { name: string; description?: string; body: string } => {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { name: "", body: markdown };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return {
    name: (meta.name ?? "").replace(/^["']|["']$/g, "").trim(),
    description: (meta.description ?? "").replace(/^["']|["']$/g, "").trim() || undefined,
    body: `${match[2].trim()}\n`,
  };
};

/**
 * Register the 14 packaged method skills with exact ids, locations,
 * descriptions, and content. A user skill with the same id is never replaced.
 */
export const registerSkills = async (ctx: SkillContext): Promise<void> => {
  const skillsDir = path.join(assetsRoot(), "skills");
  if (!existsSync(skillsDir)) return;
  await ctx.skill.transform((editor) => {
    const existing = new Set(editor.list().map((skill) => skill.id));
    for (const id of WORKIT_METHOD_SKILLS) {
      if (existing.has(id)) continue;
      const file = path.join(skillsDir, id, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      editor.add({
        id,
        name: parsed.name || id,
        ...(parsed.description ? { description: parsed.description } : {}),
        location: file,
        content: parsed.body,
      });
    }
  });
};

/**
 * Register the 14 collision-safe `wk-*` aliases. A user command with the same
 * name is preserved untouched. Invocations forward the original prompt
 * (attachments, arguments, and delivery) through `session.prompt`.
 */
export const registerCommands = async (ctx: SkillContext): Promise<void> => {
  const listed = await ctx.command.list();
  const existing = new Set((listed?.data ?? []).map((command) => command.name));
  await ctx.command.transform((editor) => {
    for (const [alias, skill] of Object.entries(WORKIT_SKILL_ALIASES)) {
      if (existing.has(alias)) continue;
      editor.add({
        name: alias,
        description: `Apply the ${skill} method skill to the current task.`,
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            sessionID,
            text: `Load the ${skill} skill with the skill tool and apply it to the current task. Arguments: ${prompt.text}`,
            ...(prompt.files ? { files: prompt.files } : {}),
            ...(prompt.agents ? { agents: prompt.agents } : {}),
            ...(prompt.skills ? { skills: prompt.skills } : {}),
            delivery,
          });
        },
      });
    }
  });
};
