// Skill routing at the moment it matters. The session-start contract names a
// trigger for each skill, but in a long or compacted session that table loses
// weight and agents act without loading the skill. Three deterministic aids:
//   - a prompt that names a trigger gets one line naming the skill to load;
//   - a delivery command (push, PR create, CI wait) gets one line naming
//     workit-ship;
//   - each skill load is recorded as a `skill.loaded` ledger row, so a nudge
//     stops once the skill is loaded and workit-retro can count skill use.
// Neither nudge fires in a subagent or once the session loaded the skill.
// Every failure answers "no nudge": hooks fail open.
import {
  skillLoadWording,
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
  WORKIT_SKILL_TRIGGERS,
  type SkillHost,
  type WorkitSkill,
} from "../core/skill-manifests";
import { appendHookObserved, readLedger } from "../ledger";
import type { HookDecision, HookInput, HostId } from "./protocol";
import { inWorkitWorkspace, rawDelivery, rawGitPre } from "./raw-git";
import { segmentsOf, type ShellDialect } from "./shell-words";

/** Skills the user starts; a nudge says to offer them, never to load them. */
const USER_INVOKED: ReadonlySet<WorkitSkill> = new Set(["workit-retro", "workit-architecture"]);

const SKILL_HOST: Record<HostId, SkillHost> = {
  claude_code: "claude-code",
  opencode: "opencode",
  codex_cli: "codex",
  codex_desktop: "codex",
  cursor: "cursor",
  pi: "pi",
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An all-caps trigger (CI, BDD) matches its case only; any other, any case. */
const TRIGGER_PATTERNS: ReadonlyArray<{ skill: WorkitSkill; trigger: string; pattern: RegExp }> =
  WORKIT_METHOD_SKILLS.flatMap((skill) =>
    WORKIT_SKILL_TRIGGERS[skill].map((trigger) => ({
      skill,
      trigger,
      pattern: new RegExp(
        `(?<![\\w/-])${escape(trigger)}(?![\\w-])`,
        trigger === trigger.toUpperCase() ? "" : "i",
      ),
    })),
  );

/** The workit skill a loaded name refers to (`workit:shape`, `workit-shape`, `wk-shape`). */
export const workitSkillOf = (name: string): WorkitSkill | null => {
  const bare = name.trim().replace(/^\//, "").toLowerCase();
  const alias = (WORKIT_SKILL_ALIASES as Record<string, WorkitSkill>)[bare];
  if (alias) return alias;
  const skill = bare.replace(/^workit:/, "workit-");
  return (WORKIT_METHOD_SKILLS as readonly string[]).includes(skill)
    ? (skill as WorkitSkill)
    : null;
};

/** The first skill a prompt's text triggers, in table order, with the word that did. */
export const promptTrigger = (prompt: string): { skill: WorkitSkill; trigger: string } | null => {
  // Code blocks and quoted output carry words the user did not ask with.
  const text = prompt.replace(/```[\s\S]*?```/g, " ").slice(0, 4000);
  for (const { skill, trigger, pattern } of TRIGGER_PATTERNS)
    if (pattern.test(text)) return { skill, trigger };
  return null;
};

/** Skills this session already loaded, from its `skill.loaded` rows. */
const loadedSkills = (cwd: string, session: string): Set<string> => {
  const ledger = readLedger(cwd);
  const loaded = new Set<string>();
  if (!ledger.ok) return loaded;
  for (const row of ledger.value.rows)
    if (
      row.type === "skill.loaded" &&
      row.actor.session === session &&
      typeof row.skill === "string"
    )
      loaded.add(row.skill);
  return loaded;
};

/** The workit skill whose SKILL.md a command or path reads (hosts that load skills as files). */
export const skillFileIn = (text: string): string | null =>
  /(?:^|[\s'"\\/])(workit-[a-z-]+)[\\/]SKILL\.md\b/.exec(text)?.[1] ?? null;

/** Record that the session loaded a workit skill (`via`: the tool or the slash command). */
export function recordSkillLoad(
  input: HookInput,
  name: string,
  via: "tool" | "slash" | "read",
): void {
  try {
    const skill = workitSkillOf(name);
    const session = input.session.id;
    if (!skill || !session) return;
    if (loadedSkills(input.cwd, session).has(skill)) return;
    appendHookObserved(input.cwd, {
      type: "skill.loaded",
      actor: { host: input.host, session, agentId: input.session.agentId },
      skill,
      via,
    });
  } catch {
    // Fail open: a lost row only means a later nudge or a retro miscount.
  }
}

const nudgeText = (input: HookInput, skill: WorkitSkill, why: string): string =>
  USER_INVOKED.has(skill)
    ? `Workit: ${why} matches ${skill}, which the user starts; offer it (/${skill.replace(/^workit-/, "wk-")}) rather than loading it.`
    : `Workit: ${why} matches ${skill}; ${skillLoadWording(SKILL_HOST[input.host], skill)} before acting.`;

/** A main session's prompt: one line naming the triggered skill, unless already loaded. */
export function promptNudge(input: HookInput, prompt: string | null | undefined): string | null {
  try {
    const session = input.session.id;
    if (!prompt || !session || input.session.agentId) return null;
    // `/wk-shape`, `/workit:shape`, or Pi's expanded `/skill:` block.
    const slash =
      /^\s*\/(?:skill:)?([\w:-]+)/.exec(prompt)?.[1] ??
      /^\s*<skill name="([\w:-]+)"/.exec(prompt)?.[1];
    if (slash) {
      // A slash command already loads its skill; record it, never nudge.
      recordSkillLoad(input, slash, "slash");
      return null;
    }
    const hit = promptTrigger(prompt);
    if (!hit || loadedSkills(input.cwd, session).has(hit.skill)) return null;
    return nudgeText(input, hit.skill, `this request ("${hit.trigger}")`);
  } catch {
    return null;
  }
}

const WORKIT_DELIVERY = /^(?:pr (?:create|merge)|ci (?:wait|status|watch)|git push)\b/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const LAUNCHERS = new Set([
  "npx",
  "bunx",
  "pnpx",
  "-y",
  "--yes",
  "pnpm",
  "dlx",
  "exec",
  "env",
  "sudo",
  "command",
]);

/** Does a segment list run a workit delivery verb (also inside `bash -c '…'`)? */
const runsWorkitDelivery = (command: string, dialect: ShellDialect, depth = 0): boolean =>
  segmentsOf(command, dialect).some(({ words }) => {
    // The command word, past env assignments and package runners (`npx -y`).
    const at = words.findIndex((word) => !/^\w+=/.test(word) && !LAUNCHERS.has(word));
    if (at >= 0 && /(?:^|[\\/])workit(?:\.exe)?$|^@brainervirus\/workit-cli$/.test(words[at])) {
      const args = words.slice(at + 1);
      if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--dry-run")) return false;
      return WORKIT_DELIVERY.test(args.join(" "));
    }
    const shell = SHELLS.has(words[at]?.split(/[\\/]/).at(-1) ?? "");
    const script = shell && words[at + 1] === "-c" ? words[at + 2] : undefined;
    return depth < 3 && script !== undefined && runsWorkitDelivery(script, "posix", depth + 1);
  });

/**
 * Does the command deliver in a Workit workspace: a push, a PR/MR create or
 * merge, or a CI wait (never help or a dry run)?
 */
export const isDeliveryCommand = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
): boolean =>
  rawDelivery(cwd, command, dialect) ||
  (runsWorkitDelivery(command, dialect) && inWorkitWorkspace(cwd));

/** A delivery command in a main session that has not loaded workit-ship. */
export function shipNudge(input: HookInput, command: string): string | null {
  try {
    const session = input.session.id;
    if (!session || input.session.agentId) return null;
    const dialect = input.event.kind === "shell.pre" ? (input.event.dialect ?? "posix") : "posix";
    if (!isDeliveryCommand(input.cwd, command, dialect)) return null;
    if (loadedSkills(input.cwd, session).has("workit-ship")) return null;
    return nudgeText(input, "workit-ship", "this delivery step");
  } catch {
    return null;
  }
}

/** `decision` with `line` added: a context grows by a line, `none` becomes one. */
export const withContextLine = (decision: HookDecision, line: string | null): HookDecision => {
  if (!line) return decision;
  if (decision.kind === "none") return { kind: "context", text: line };
  if (decision.kind === "context") return { kind: "context", text: `${decision.text}\n${line}` };
  return decision;
};

/** Hosts whose shell nudge rides on the tool result: the raw-git nudge plus the ship line. */
export const shellNudge = (input: HookInput, command: string): HookDecision =>
  withContextLine(rawGitPre(input, command), shipNudge(input, command));
