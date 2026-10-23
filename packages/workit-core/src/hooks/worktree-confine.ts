// Worktree confinement for implementer subagents (#310). Without host
// worktree isolation (Claude Code's refused every command it could not
// verify, `workit git` included), the lead makes the implementer's worktree
// with `workit fanout worktree create` and Workit's own hooks keep the
// implementer in it:
//
// - binding: the first edit or mutating git command an implementer makes
//   inside a worktree that `workit fanout worktree create` made (its admin
//   dir holds the fanout token) binds that agent to it, in
//   `<state dir>/worktree-bind/<session+agent>.json`, with a ledger row;
// - after binding, an edit or mutating git command outside that worktree is
//   denied naming it; the host's temp dir stays writable;
// - before binding (ruling: the safe default), an edit outside every Workit
//   worktree is denied too, so an implementer never edits the lead's checkout;
// - always, what the lead owns is denied: worktree, ref and config changes
//   (`git worktree add|remove`, `branch -D`, `update-ref`, a delete push…)
//   and `workit fanout plan|worktree`.
//
// An agent the host isolated itself (a real linked worktree at Claude Code's
// `<repo>/.claude/worktrees/agent-<id>`) is left to the host. Reads only the
// filesystem; fails open on any error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../core/logger";
import { appendHookObserved } from "../ledger";
import type { HookDecision, HookInput } from "./protocol";
import { inWorkitWorkspace, rawInvocations, skipWorkitGlobals, workitInvocations } from "./raw-git";
import type { ShellDialect } from "./shell-words";
import { shellMutationTargets, UNKNOWN_DIR } from "./write-gate";

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

// Bindings live in Workit's machine state dir, keyed by session and agent, so
// one is kept wherever the hook's cwd is (even outside every repository).
const bindingDir = (): string => path.join(resolveStateDir(), "worktree-bind");

const bindingFile = (session: string, agentId: string): string =>
  path.join(
    bindingDir(),
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
  if (!agentId) return null;
  const binding = readBinding(bindingFile(input.session.id, agentId));
  return binding && workitWorktreeOf(binding.worktree) === binding.worktree
    ? binding.worktree
    : null;
};

const bind = (input: HookInput, worktree: string): void => {
  const agentId = input.session.agentId!;
  const file = bindingFile(input.session.id, agentId);
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

/**
 * Claude Code's own isolation: the agent runs in a linked worktree (its `.git`
 * is a file) whose root is exactly `<repo>/.claude/worktrees/agent-<its id>`.
 * A directory that only looks like one is not.
 */
export const hostIsolated = (cwd: string, agentId: string | null): boolean => {
  try {
    if (agentId === null) return false;
    const checkout = checkoutOf(cwd);
    if (!checkout) return false;
    const dotGit = path.join(checkout.root, ".git");
    if (!fs.statSync(dotGit).isFile()) return false;
    const admin = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!admin) return false;
    const adminDir = path.resolve(checkout.root, admin);
    // The admin dir must point back at this checkout: a forged `.git` file
    // naming a sibling's admin dir does not make a directory that sibling's.
    const back = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    if (path.relative(canonical(path.resolve(adminDir, back)), canonical(dotGit)) !== "")
      return false;
    const common = path.join(adminDir, "commondir");
    const gitDir = fs.existsSync(common)
      ? path.resolve(adminDir, fs.readFileSync(common, "utf8").trim())
      : adminDir;
    const expected = path.join(
      path.dirname(canonical(gitDir)),
      ".claude",
      "worktrees",
      `agent-${agentId}`,
    );
    return path.relative(canonical(expected), checkout.root) === "";
  } catch {
    return false;
  }
};

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
  const unblock = `Edit only under ${worktree} and run git there, one verb per call: \`workit --cwd ${worktree} git commit -m … -- <paths>\`, \`workit --cwd ${worktree} check <name>\` (or \`git -C ${worktree} …\`); a command whose writes Workit cannot see is judged by the directory it runs in. Anything outside it is a follow-up for your report.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} is bound to the worktree ${worktree}, and ${shown(target)} is outside it. ${unblock}`,
    unblock,
  };
};

const unknownDirDeny = (input: HookInput, worktree: string | null): HookDecision => {
  const wt = worktree ?? "<worktree>";
  const unblock = `Workit cannot resolve \`cd -\`, \`cd "$X"\` or \`popd\`: write by absolute path, \`git -C ${wt}\` or \`workit --cwd ${wt}\`.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} writes after an unknown directory change. ${unblock}`,
    unblock,
  };
};

/**
 * Judge an implementer's edit or mutating command by the absolute paths it
 * changes (`targets`). Only targets inside a git checkout, or Workit's
 * binding records, are judged (scratch and temp files elsewhere are host
 * policy). Binds on the first target inside a Workit worktree; denies a
 * target outside the bound worktree (or, unbound, outside every Workit
 * worktree). Deny reasons name a target as the agent spelled it.
 */
export function confineImplementer(input: HookInput, targets: readonly string[]): HookDecision {
  try {
    if (!input.session.agentId || hostIsolated(input.cwd, input.session.agentId)) return NONE;
    if (targets.some((target) => within(path.resolve(target), UNKNOWN_DIR)))
      return unknownDirDeny(input, boundWorktree(input));
    const bindings = canonical(bindingDir());
    const judged = targets
      .map((named) => ({ named, real: canonical(named) }))
      .filter(({ real }) => within(real, bindings) || checkoutOf(real) !== null);
    if (judged.length === 0) return NONE;
    let worktree = boundWorktree(input);
    if (!worktree) {
      for (const { real } of judged) {
        worktree = within(real, bindings) ? null : workitWorktreeOf(real);
        if (worktree) break;
      }
      if (!worktree) return unboundDeny(input, judged[0].named);
      bind(input, worktree);
    }
    const root = canonical(worktree);
    const outside = judged.find(({ real }) => !within(real, root) || within(real, bindings));
    return outside ? outsideDeny(input, worktree, outside.named) : NONE;
  } catch {
    return NONE;
  }
}

const MUTATING_REMOTE = new Set([
  "add",
  "remove",
  "rm",
  "rename",
  "set-url",
  "set-head",
  "set-branches",
  "prune",
]);
const CONFIG_READ = /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|get|list)$/;
const CONFIG_WRITE =
  /^(?:--(?:unset(?:-all)?|add|replace-all|rename-section|remove-section|edit)|-e|set|unset|rename-section|remove-section|edit)$/;
const CONFIG_VALUE = /^(?:--file|-f|--blob|--type|--default|--comment)$/;

/**
 * Whether git `args` (the subcommand first) change what the lead owns: the
 * repository's worktrees, refs other than by commit, the shared stash, or
 * its configuration and remotes.
 */
const leadOwnedGit = (args: readonly string[]): boolean => {
  const [sub = "", ...rest] = args;
  if (rest.some((arg) => arg === "--help" || arg === "-h")) return false;
  const names = rest.filter((arg) => !arg.startsWith("-"));
  const flag = (pattern: RegExp) => rest.some((arg) => pattern.test(arg));
  switch (sub) {
    case "worktree":
      return names[0] !== undefined && names[0] !== "list";
    case "update-ref":
      return true;
    case "symbolic-ref":
      return names.length > 1 || flag(/^(?:-d|--delete)$/);
    case "branch":
      return flag(/^-[a-zA-Z]*[dDfmMcC]|^--(?:delete|force|move|copy)$/);
    case "tag":
      return flag(/^-[a-zA-Z]*[df]|^--(?:delete|force)$/);
    case "push": {
      if (flag(/^(?:-d|--delete|--mirror|--prune)$/)) return true;
      // names[0] is the remote; the rest are refspecs. `git push [-u] [remote]` and
      // `git push --force-with-lease [remote]` (the current branch) stay the implementer's.
      const refspecs = names.slice(1);
      return (
        refspecs.some((name) => name.includes(":") || name.startsWith("+")) ||
        (refspecs.length > 0 && flag(/^-[a-zA-Z]*f|^--force/))
      );
    }
    case "replace":
    case "filter-branch":
    case "gc":
    case "prune":
    case "repack":
    case "sparse-checkout":
      return true;
    case "notes":
    case "reflog":
    case "submodule":
      return !/^(?:list|show|status|exists)$/.test(names[0] ?? "list");
    case "stash":
      return names[0] === "drop" || names[0] === "clear";
    case "remote":
      return MUTATING_REMOTE.has(names[0] ?? "");
    case "config": {
      if (rest.some((arg) => CONFIG_READ.test(arg))) return false;
      if (rest.some((arg) => CONFIG_WRITE.test(arg))) return true;
      let operands = 0;
      for (let index = 0; index < rest.length; index++)
        if (CONFIG_VALUE.test(rest[index])) index++;
        else if (!rest[index].startsWith("-")) operands++;
      return operands > 1;
    }
    default:
      return false;
  }
};

/** A `workit [globals] fanout plan|worktree …` in `args` (also behind `check --`). */
const leadOwnedWorkit = (args: readonly string[]): boolean =>
  !args.includes("--help") &&
  args.some((_, start) => {
    if (start > 0 && !/(?:^|[\\/])workit(?:\.exe|\.cmd)?$/.test(args[start - 1])) return false;
    const [verb, sub] = skipWorkitGlobals(args.slice(start)).rest;
    return verb === "fanout" && /^(?:plan|worktree)$/.test(sub ?? "");
  });

const leadOwnedDeny = (input: HookInput, command: string): HookDecision => {
  const unblock =
    "Worktrees, branches other than your own, refs, tags, remotes, git config, the shared stash and the fan-out plan belong to the lead: report what you need changed as a follow-up instead.";
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} may not run \`${command.slice(0, 160)}\`. ${unblock}`,
    unblock,
  };
};

/**
 * Judge an implementer's shell command: deny what the lead owns, then confine
 * every path it may change (the strict analysis, see `shellMutationTargets`).
 */
export function confineImplementerShell(
  input: HookInput,
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision {
  try {
    if (!input.session.agentId || hostIsolated(input.cwd, input.session.agentId)) return NONE;
    if (
      rawInvocations(command, dialect).some(
        (invocation) => invocation.tool === "git" && leadOwnedGit(invocation.args),
      ) ||
      workitInvocations(command, dialect).some(leadOwnedWorkit)
    )
      return leadOwnedDeny(input, command);
  } catch {
    // An unanalysable command falls through to the path confinement.
  }
  return confineImplementer(input, shellMutationTargets(input.cwd, command, dialect, true));
}
