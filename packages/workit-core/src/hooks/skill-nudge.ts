// Skill routing at the moment it matters. The session-start contract names a
// trigger for each skill, but in a long or compacted session that table loses
// weight and agents act without loading the skill. Three deterministic aids,
// inside a Workit workspace only:
//   - a prompt that asks for a skill's work in so many words gets one
//     advisory line naming the skill;
//   - a delivery command (push, PR create or merge, CI wait) gets one line
//     naming workit-ship;
//   - each skill load is recorded as a `skill.loaded` ledger row, so a nudge
//     stops once the skill is loaded and workit-retro can count skill use.
// A session is nudged about one skill at most once (a marker per session
// in the workspace store), never in a subagent, never once it loaded the skill.
// Every failure answers "no nudge": hooks fail open.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  skillLoadWording,
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
  type SkillHost,
  type WorkitSkill,
} from "../core/skill-manifests";
import { appendHookObserved, readLedger } from "../ledger";
import { resolveStore } from "../store/paths";
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

/**
 * Prompt phrasings that ask for a skill's work. The contract's single-word
 * triggers (plan, build, merge, CI) are for the model's judgment; a hook
 * cannot tell "plan the cache" from "what's in the plan?", so it matches
 * phrases only. Ordered by precedence: a broken thing is debug work before
 * it is a feature or a plan.
 */
const PROMPT_INTENTS: ReadonlyArray<readonly [WorkitSkill, RegExp]> = [
  [
    "workit-debug",
    /\b(flaky|regressed|(?:is|introduced) a regression|regression (?:in|after|since|from)|(?:is|are|got|looks) broken|debug (?:this|it|the|why)|fix (?:the|this|a) bug)\b/i,
  ],
  [
    "workit-continue",
    /\b(pick up where|where (?:were|did) we|resume (?:the|this|my|our|work|where)|hand ?off)\b/i,
  ],
  [
    "workit-review",
    /\b(blast radius|code review|review (?:the|this|my|PR|pr|#\d+|branch|diff|changes))\b/i,
  ],
  [
    "workit-ship",
    /\b(ship (?:it|this|the)|babysit|open (?:a|the) (?:PR|pr|MR|mr)(?=\s*$|\s+(?:for|to|on|with|and|against|into|from|after|once)\b|[.!,;])|merge (?:the|this|my) (?:PR|pr|MR|mr|branch)|(?:get|until|make) CI (?:is )?green)\b/i,
  ],
  ["workit-bdd", /\b(BDD|TDD|acceptance criteria|Given\/When\/Then)(?![\w/])/],
  ["workit-test-audit", /\b(test audit|audit the tests|tautolog\w*|weak tests)\b/i],
  ["workit-deslop", /\b(deslop|slop|dead code)\b/i],
  [
    "workit-fanout",
    /\b(fan(?: |-)?out|parallelize|parallel agents|agent swarm|swarm of agents)\b/i,
  ],
  ["workit-verify-app", /\b(verify the app|smoke test|prove it works)\b/i],
  ["workit-retro", /\b((?:a|the) retro(?![-\w]|\.\w)|retrospective)/i],
  ["workit-architecture", /\b(deepen (?:the )?modules|architecture (?:review|pass|audit))\b/i],
  [
    "workit-shape",
    /\b(brainstorm\w*|grill me|should we|let'?s plan|plan (?:out|how|the|a|for)|(?:write|draft) (?:a|the) spec)\b/i,
  ],
  [
    "workit-implement",
    /\b(implement (?:the|this|a|it)|add (?:a|the) feature|build (?:a|an|the) (?:new )?(?:feature|command|verb|page|endpoint|component|cli|tool))\b/i,
  ],
];

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

/** The skill a prompt asks for, by precedence, with the phrase that did. */
export const promptTrigger = (prompt: string): { skill: WorkitSkill; trigger: string } | null => {
  // Code blocks and quoted output carry words the user did not ask with.
  const text = prompt.replace(/```[\s\S]*?```/g, " ").slice(0, 4000);
  for (const [skill, pattern] of PROMPT_INTENTS) {
    const match = pattern.exec(text);
    if (match) return { skill, trigger: match[1] ?? match[0] };
  }
  return null;
};

/** Per-session nudge state: skills nudged or loaded, so each nudges once. */
type Marker = { nudged: string[]; loaded: string[] };

/** The marker in the workspace's store (null outside one: nothing is nudged or recorded there). */
const markerFile = (input: HookInput, session: string): string | null => {
  const location = resolveStore(input.cwd);
  if (location instanceof Error || !location.shared) return null;
  const name = createHash("sha256").update(`${input.host}\0${session}`).digest("hex").slice(0, 32);
  return path.join(location.dir, "hooks", `skills-${name}.json`);
};

const readMarker = (file: string): Marker => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Marker>;
    return { nudged: value.nudged ?? [], loaded: value.loaded ?? [] };
  } catch {
    return { nudged: [], loaded: [] };
  }
};

const writeMarker = (file: string, marker: Marker): void => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker));
  } catch {
    // Fail open: without a marker a later nudge repeats.
  }
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

const SKILL_FILE = /(?:^|[\\/])(workit-[a-z-]+)[\\/]SKILL\.md$/;

/** The workit skill whose SKILL.md a path names (Pi's read tool). */
export const skillFileIn = (file: string): string | null => SKILL_FILE.exec(file)?.[1] ?? null;

/** Commands that read a file for the agent: a shell-loaded skill is one of these on its SKILL.md. */
const READERS = new Set([
  "cat",
  "sed",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "nl",
  "get-content",
  "gc",
  "type",
]);

/** The workit skill whose SKILL.md a shell command reads (Codex, Cursor); never git, grep or an editor. */
export const skillReadIn = (command: string, dialect: ShellDialect = "posix"): string | null => {
  for (const { words } of segmentsOf(command, dialect)) {
    if (!READERS.has((words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase())) continue;
    // `sed -i` edits the file; it does not load it.
    if (words.some((word) => /^(?:-i(?:\.\w+)?|--in-place(?:=.*)?)$/.test(word))) continue;
    for (const word of words.slice(1)) {
      const skill = skillFileIn(word);
      if (skill) return skill;
    }
  }
  return null;
};

/** Record that the session loaded a workit skill (`via`: the tool, a slash command, a file read). */
export function recordSkillLoad(
  input: HookInput,
  name: string,
  via: "tool" | "slash" | "read",
): void {
  try {
    const skill = workitSkillOf(name);
    const session = input.session.id;
    if (!skill || !session) return;
    if (!inWorkitWorkspace(input.cwd)) return;
    const file = markerFile(input, session);
    if (!file) return;
    const marker = readMarker(file);
    if (marker.loaded.includes(skill)) return;
    writeMarker(file, { ...marker, loaded: [...marker.loaded, skill] });
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

/** The nudge for `skill` once per session: null when it was nudged or loaded. */
const nudgeOnce = (
  input: HookInput,
  session: string,
  skill: WorkitSkill,
  line: string,
): string | null => {
  const file = markerFile(input, session);
  if (!file) return null;
  const marker = readMarker(file);
  if (marker.nudged.includes(skill) || marker.loaded.includes(skill)) return null;
  if (loadedSkills(input.cwd, session).has(skill)) return null;
  writeMarker(file, { ...marker, nudged: [...marker.nudged, skill] });
  return line;
};

const nudgeText = (input: HookInput, skill: WorkitSkill, why: string): string =>
  USER_INVOKED.has(skill)
    ? `Workit: ${why} looks like ${skill} work, which the user starts; offer it (/${skill.replace(/^workit-/, "wk-")}) rather than loading it.`
    : `Workit: ${why} looks like ${skill} work; if it is, ${skillLoadWording(SKILL_HOST[input.host], skill)} first.`;

/** A skill the prompt already loads: `/wk-shape`, `/workit:shape`, Pi's expanded
 * `/skill:` block, or OpenCode's rewritten `/wk-*` command. */
const promptLoads = (prompt: string): string | null =>
  /^\s*\/(?:skill:)?([\w:-]+)/.exec(prompt)?.[1] ??
  /^\s*<skill name="([\w:-]+)"/.exec(prompt)?.[1] ??
  /^\s*Load the (workit-[a-z-]+) skill with the skill tool\b/.exec(prompt)?.[1] ??
  null;

/** A main session's prompt in a Workit workspace: one advisory line naming the skill it asks for. */
export function promptNudge(input: HookInput, prompt: string | null | undefined): string | null {
  try {
    const session = input.session.id;
    if (!prompt || !session || input.session.agentId) return null;
    const loads = promptLoads(prompt);
    if (loads) {
      // The prompt already loads its skill; record it, never nudge.
      recordSkillLoad(input, loads, "slash");
      return null;
    }
    const hit = promptTrigger(prompt);
    if (!hit || !inWorkitWorkspace(input.cwd)) return null;
    return nudgeOnce(
      input,
      session,
      hit.skill,
      nudgeText(input, hit.skill, `this request ("${hit.trigger}")`),
    );
  } catch {
    return null;
  }
}

const WORKIT_DELIVERY = /^(?:pr (?:create|merge)|ci wait|git push)\b/;
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
    return nudgeOnce(
      input,
      session,
      "workit-ship",
      nudgeText(input, "workit-ship", "this delivery step"),
    );
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
