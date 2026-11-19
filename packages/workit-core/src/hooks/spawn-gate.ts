// The spawn gate (#432, #654), Claude Code's PreToolUse on the Agent tool.
// No spawn runs under host isolation: Claude Code's worktree isolation refuses
// every command that wraps git and cannot be turned off, so `isolation` is
// stripped from every agent type (an implementer works in its brief's
// WORKTREE); under auto mode, which refuses a rewritten spawn, the spawn is
// denied with the same args without it (agent-model.ts). A `workit:implementer`
// spawn names a made Workit worktree in its prompt, in any form: a WORKTREE
// line (a brief, or the pointer `fanout worktree create` prints), the
// worktree's path (its git admin dir holds the fanout token), or the path of
// a brief file holding a WORKTREE line. Else it is denied in two lines whose
// Retry as is the ad-hoc `worktree create` for the slice word the prompt
// names. The launcher fast path (workit-hook.mjs) passes only the WORKTREE
// line and leaves the rest to this gate. The implementer is still bound to
// the first worktree it writes in (worktree-confine.ts).
import fs from "node:fs";
import path from "node:path";
import { agentModelDecision, type SpawnChange } from "./agent-model";
import type { HostDescriptor } from "./descriptor";
import type { HookDecision } from "./protocol";
import { workitRole } from "./steering";
import { FANOUT_TOKEN_FILE } from "./worktree-confine";

/** A brief's WORKTREE line naming a made worktree (`fanout brief` says "not made yet" otherwise). */
const MADE_WORKTREE = /^WORKTREE:[ \t]*(?!not made yet)\S(?![^\n]*not made yet)/mu;

/** A path a prompt names: a directory `fanout worktree create` made, or a brief file with a WORKTREE line. */
const namesMade = (word: string): boolean => {
  try {
    const stat = fs.statSync(word);
    if (stat.isFile()) return stat.size < 1e6 && MADE_WORKTREE.test(fs.readFileSync(word, "utf8"));
    const admin = /^gitdir: *(.+)/u.exec(fs.readFileSync(path.join(word, ".git"), "utf8"));
    return !!admin && fs.existsSync(path.resolve(word, admin[1].trim(), FANOUT_TOKEN_FILE));
  } catch {
    return false;
  }
};

const namesWorktree = (prompt: string): boolean =>
  MADE_WORKTREE.test(prompt) ||
  (prompt.match(/(?<![\w.~])\/[^\s'"`<>|;,()]+/gu) ?? []).some((word) =>
    namesMade(word.replace(/[.:]+$/u, "")),
  );

/** The slice word a prompt or description names, as a slice id. */
const sliceWord = (tool: Record<string, unknown>): string =>
  (
    /\b(?:WORKER:|brief|create) +([a-z0-9][\w.-]*)/iu.exec(String(tool.prompt))?.[1] ??
    String(tool.description ?? "")
  )
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-._]+|-+$/gu, "")
    .slice(0, 40) || "slice";

/** The gate on a Claude Code spawn: a deny, or the input it lets run and what it changed. */
type Gate =
  | { kind: "deny"; decision: HookDecision }
  | { kind: "run"; input: Record<string, unknown>; change: SpawnChange };

const gate = (descriptor: HostDescriptor, tool: Record<string, unknown>): Gate => {
  const type = typeof tool.subagent_type === "string" ? tool.subagent_type : "";
  const implementer = workitRole(descriptor, type) === "implementer";
  if (implementer && (typeof tool.prompt !== "string" || !namesWorktree(tool.prompt))) {
    const slice = sliceWord(tool);
    const unblock = `workit fanout worktree create ${slice} --branch feat/${slice}`;
    return {
      kind: "deny",
      decision: {
        kind: "deny",
        reason: `workit spawn gate: this ${type} prompt names no worktree Workit made.\nRetry as: ${unblock} (or --name <plan> for a planned slice), then spawn again with the WORKTREE line it prints as the prompt's first line.`,
        unblock,
      },
    };
  }
  if (tool.isolation === undefined)
    return { kind: "run", input: tool, change: { dropped: [], reasons: [], notes: [] } };
  const { isolation: _dropped, ...input } = tool;
  const why = `${
    implementer
      ? "it works in the brief's WORKTREE"
      : "it runs in your checkout; for its own worktree run `workit fanout worktree create <slice>` and name it in the prompt"
  } (Claude Code's isolation refuses wrapped git).`;
  return {
    kind: "run",
    input,
    change: {
      dropped: ["isolation"],
      reasons: [`Isolation goes: ${why}`],
      notes: [`Workit removed isolation from this ${type || "general-purpose"} spawn: ${why}`],
    },
  };
};

/**
 * The gate, then the role's model (agent-model.ts) on what it lets run: one
 * `updatedInput` for both, or under auto mode one deny naming the exact args.
 */
export const spawnDecision = (
  descriptor: HostDescriptor,
  cwd: string,
  tool: Record<string, unknown>,
  permissionMode: string | null = null,
): HookDecision => {
  const checked = gate(descriptor, tool);
  if (checked.kind === "deny") return checked.decision;
  return agentModelDecision(cwd, checked.input, { change: checked.change, permissionMode });
};
