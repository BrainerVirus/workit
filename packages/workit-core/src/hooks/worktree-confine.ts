// Worktree confinement for implementer subagents (#310). Without host
// worktree isolation (Claude Code's refused every command it could not
// verify, `workit git` included), the lead makes the implementer's worktree
// with `workit fanout worktree create` and Workit's own hooks keep the
// implementer in it:
//
// - binding: the first edit or mutating git command an implementer makes
//   inside a worktree that `workit fanout worktree create` made (its admin
//   dir holds the fanout token) binds that agent to it, in
//   `<git common dir>/workit/worktree-bind/<agent>.json`, with a ledger row;
// - after binding, an edit or mutating git command outside that worktree is
//   denied naming it; the host's temp dir stays writable;
// - before binding (ruling: the safe default), an edit outside every Workit
//   worktree is denied too, so an implementer never edits the lead's checkout.
//
// An agent the host isolated itself (Claude Code's `.claude/worktrees/agent-<id>`)
// is left to the host. Reads only the filesystem; fails open on any error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendHookObserved } from "../ledger";
import type { HookDecision, HookInput } from "./protocol";
import { inWorkitWorkspace } from "./raw-git";
import { gitStoreDir } from "./standing-signal";

/** Written by `workit fanout worktree create` into git's admin dir for the worktree. */
export const FANOUT_TOKEN_FILE = "workit-fanout-token";

const NONE: HookDecision = { kind: "none" };
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/** The real path of `file`'s nearest existing ancestor, plus the rest. */
const canonical = (file: string): string => {
  let rest = "";
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return path.resolve(file);
      rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
    }
  }
};

const within = (child: string, parent: string): boolean => {
  const fold = (value: string) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
  const relative = path.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The git checkout `file` is in (the nearest directory above it with a
 * `.git`), and whether `workit fanout worktree create` made it: its `.git`
 * file names an admin dir that holds the fanout token. Null outside any
 * repository.
 */
const checkoutOf = (file: string): { root: string; workit: boolean } | null => {
  for (let dir = canonical(file); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    if (fs.existsSync(dotGit)) {
      if (!fs.statSync(dotGit).isFile()) return { root: dir, workit: false };
      const admin = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      return {
        root: dir,
        workit:
          Boolean(admin) && fs.existsSync(path.join(path.resolve(dir, admin!), FANOUT_TOKEN_FILE)),
      };
    }
    if (path.dirname(dir) === dir) return null;
  }
};

/** The root of the Workit-made worktree `file` is in, else null. */
const workitWorktreeOf = (file: string): string | null => {
  try {
    const checkout = checkoutOf(file);
    return checkout?.workit ? checkout.root : null;
  } catch {
    return null;
  }
};

type Binding = { worktree: string; session: string; agentId: string; at: string };

const bindingFile = (store: string, session: string, agentId: string): string =>
  path.join(
    store,
    "worktree-bind",
    `${createHash("sha256").update(`${session}\0${agentId}`).digest("hex").slice(0, 32)}.json`,
  );

const readBinding = (file: string): Binding | null => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Binding>;
    return typeof value.worktree === "string" ? (value as Binding) : null;
  } catch {
    return null;
  }
};

/** The worktree `input`'s agent is bound to, while that worktree is still a Workit one. */
const boundWorktree = (input: HookInput): string | null => {
  const agentId = input.session.agentId;
  const store = agentId ? gitStoreDir(input.cwd) : null;
  if (!store || !agentId) return null;
  const binding = readBinding(bindingFile(store, input.session.id, agentId));
  return binding && workitWorktreeOf(binding.worktree) === binding.worktree
    ? binding.worktree
    : null;
};

const bind = (input: HookInput, worktree: string): void => {
  const agentId = input.session.agentId!;
  const store = gitStoreDir(input.cwd);
  if (!store) return;
  const file = bindingFile(store, input.session.id, agentId);
  const binding: Binding = {
    worktree,
    session: input.session.id,
    agentId,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(binding));
  try {
    if (inWorkitWorkspace(input.cwd))
      appendHookObserved(input.cwd, {
        type: "worktree.bound",
        actor: { host: input.host, session: input.session.id, agentId },
        agentType: input.session.agentType,
        worktree,
      });
  } catch {
    // The binding file is what the hook reads; the row is evidence only.
  }
};

/** Claude Code's own isolation: the agent runs in `.claude/worktrees/agent-<its id>`. */
export const hostIsolated = (cwd: string, agentId: string | null): boolean =>
  agentId !== null &&
  new RegExp(
    `[\\\\/]\\.claude[\\\\/]worktrees[\\\\/]agent-${agentId.replace(/[^\w-]/g, "")}(?:[\\\\/]|$)`,
  ).test(cwd);

const shown = (target: string): string =>
  path.basename(target) === ".workit-live-target" ? path.dirname(target) : target;

const unboundDeny = (input: HookInput, target: string): HookDecision => {
  const unblock =
    "Work only in the worktree your brief names, which the lead made with `workit fanout worktree create <slice>`: edit files under it and run one verb per call against it (`workit --cwd <worktree> git commit -m … -- <paths>`, `workit --cwd <worktree> check <name>`). If your brief names no worktree, stop and report that to the lead.";
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} is not working in a Workit worktree yet, and ${shown(target)} is outside every worktree \`workit fanout worktree create\` made, so it would change the lead's checkout. ${unblock}`,
    unblock,
  };
};

const outsideDeny = (input: HookInput, worktree: string, target: string): HookDecision => {
  const unblock = `Edit only under ${worktree} and run git there, one verb per call: \`workit --cwd ${worktree} git commit -m … -- <paths>\`, \`workit --cwd ${worktree} check <name>\` (or \`git -C ${worktree} …\`). Anything outside it is a follow-up for your report.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} is bound to the worktree ${worktree}, and ${shown(target)} is outside it. ${unblock}`,
    unblock,
  };
};

/**
 * Judge an implementer's edit or mutating command by the absolute paths it
 * changes (`targets`). Only targets inside a git checkout are judged (scratch
 * and temp files elsewhere are host policy). Binds on the first target inside
 * a Workit worktree; denies a target outside the bound worktree (or, unbound,
 * outside every Workit worktree).
 */
export function confineImplementer(input: HookInput, targets: readonly string[]): HookDecision {
  try {
    if (!input.session.agentId || hostIsolated(input.cwd, input.session.agentId)) return NONE;
    const judged = targets
      .map((target) => canonical(target))
      .filter((target) => checkoutOf(target) !== null);
    if (judged.length === 0) return NONE;
    let worktree = boundWorktree(input);
    if (!worktree) {
      for (const target of judged) {
        worktree = workitWorktreeOf(target);
        if (worktree) break;
      }
      if (!worktree) return unboundDeny(input, judged[0]);
      bind(input, worktree);
    }
    const root = canonical(worktree);
    const outside = judged.find((target) => !within(target, root));
    return outside ? outsideDeny(input, worktree, outside) : NONE;
  } catch {
    return NONE;
  }
}
