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
//
// A verifier or reviewer (a judge, #790) writes only in a scratch dir:
// `.workit-scratch/` at the root of a checkout of the judged repository, the
// candidate worktree's included, and a scratch git repository made inside
// it. Every other write target,
// in a repository or not, is denied naming the scratch dir, and so is an
// unquoted heredoc whose body runs a command substitution.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../core/logger";
import { appendHookObserved } from "../ledger";
import type { HookDecision, HookInput } from "./protocol";
import {
  commandLines,
  inWorkitWorkspace,
  rawInvocations,
  skipWorkitGlobals,
  workitCheckTail,
  workitInvocations,
} from "./raw-git";
import { segmentsOf, type ShellDialect } from "./shell-words";
import {
  configWrites,
  OPAQUE_TARGET,
  placeholdersOf,
  shellMutationTargets,
  UNKNOWN_DIR,
  UNKNOWN_VAR,
} from "./write-gate";

/** Written by `workit fanout worktree create` into git's admin dir for the worktree. */
export const FANOUT_TOKEN_FILE = "workit-fanout-token";

const NONE: HookDecision = { kind: "none" };
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/** The real path of absolute, normalized `file`'s nearest existing ancestor, plus the rest. */
const realOf = (file: string): string => {
  let rest = "";
  for (let dir = file; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return file;
      rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
    }
  }
};

/**
 * Where a write to `file` lands: walked one component at a time as the OS
 * does, following each symlink (a dangling one too) before a later `..`
 * applies, so `link/../y` is judged beside the link's target. Parts that do
 * not exist yet are kept as spelled.
 */
const canonical = (file: string, hops = { chain: 40, total: 1000 }): string => {
  const start = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
  const { root } = path.parse(start);
  let at = root;
  let missing = false;
  for (const part of start.slice(root.length).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      at = path.dirname(at);
      continue;
    }
    const next = path.join(at, part);
    let link: string | null = null;
    if (!missing)
      try {
        link = fs.readlinkSync(next);
      } catch (error) {
        missing = (error as NodeJS.ErrnoException).code !== "EINVAL";
      }
    // A chain of links is capped at 40 like the OS's; the total bounds cycles through real dirs.
    if (link === null) {
      at = next;
      hops.chain = 40;
    } else if (hops.chain-- > 0 && hops.total-- > 0)
      at = canonical(path.isAbsolute(link) ? link : `${at}${path.sep}${link}`, hops);
    else return path.resolve(file);
  }
  return realOf(at);
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
      const admin = fs.statSync(dotGit).isFile() ? gitDirsAt(dir, null, false)?.[0] : undefined;
      return { root: dir, workit: !!admin && fs.existsSync(path.join(admin, FANOUT_TOKEN_FILE)) };
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

type Binding = {
  worktree: string;
  session: string;
  agentId: string;
  at: string;
};

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
    const [adminDir, gitDir] = gitDirsAt(checkout.root, null, false) ?? [];
    // The admin dir must point back at this checkout: a forged `.git` file
    // naming a sibling's admin dir does not make a directory that sibling's.
    const back = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    if (path.relative(canonical(path.resolve(adminDir, back)), canonical(dotGit)) !== "")
      return false;
    const expected = path.join(path.dirname(gitDir), ".claude", "worktrees", `agent-${agentId}`);
    return path.relative(canonical(expected), checkout.root) === "";
  } catch {
    return false;
  }
};

/** The command a placeholder target stands for (`python3` running in its directory), else null. */
const runnerAt = (target: string): string | null => {
  const base = path.basename(target);
  return base.startsWith(OPAQUE_TARGET)
    ? decodeURIComponent(base.slice(OPAQUE_TARGET.length))
    : null;
};

/** A target as the agent spelled it, in the platform's separators (Git Bash spells `C:/…`). */
const shown = (target: string): string => {
  const named = /^\.workit-(?:live-target$|runs-)/.test(path.basename(target))
    ? path.dirname(target)
    : target;
  return path.sep === "\\" ? named.replaceAll("/", "\\") : named;
};

const unboundDeny = (input: HookInput, target: string): HookDecision => {
  const unblock =
    "Work only in the worktree your brief names, which the lead made with `workit fanout worktree create <slice>`: edit files under it and run one verb per call against it (`workit git --cwd <worktree> commit -m … -- <paths>`, `workit check --cwd <worktree> <name>`). If your brief names no worktree, stop and report that to the lead.";
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} is not working in a Workit worktree yet, and ${shown(target)} is outside every worktree \`workit fanout worktree create\` made, so it would change the lead's checkout. ${unblock}`,
    unblock,
  };
};

const outsideDeny = (input: HookInput, worktree: string, target: string): HookDecision => {
  const runner = runnerAt(target);
  const unblock = `${runner === null ? "" : `Run \`${runner}\` from your worktree: \`cd ${worktree} && …\`. `}Edit only under ${worktree} and run git there, one verb per call: \`workit git --cwd ${worktree} commit -m … -- <paths>\`, \`workit check --cwd ${worktree} <name>\` (or \`git -C ${worktree} …\`); a command whose writes Workit cannot see is judged by the directory it runs in. Anything outside it is a follow-up for your report.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} is bound to the worktree ${worktree}, and ${runner === null ? `${shown(target)} is` : `\`${runner}\` runs in ${shown(target)},`} outside it. ${unblock}`,
    unblock,
  };
};

const unknownDirDeny = (input: HookInput, worktree: string | null): HookDecision => {
  const wt = worktree ?? "<worktree>";
  const unblock = `Workit cannot resolve \`cd -\`, \`cd "$X"\` or \`popd\`: write by absolute path, \`git -C ${wt}\` or \`workit <verb> --cwd ${wt}\`.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} writes after an unknown directory change. ${unblock}`,
    unblock,
  };
};

/** `command` with each unresolved reference in `refs` spelled as the absolute path it stands for. */
const literalForm = (command: string, refs: readonly string[]): string => {
  let text = command;
  for (const ref of refs) {
    const placeholder = `<absolute path of ${ref}>`;
    const name = /^\$(\w+)$/.exec(ref)?.[1];
    text = name
      ? text.replace(new RegExp(`\\$\\{${name}[^}]*\\}|\\$${name}(?!\\w)`, "g"), placeholder)
      : text.replaceAll(ref, placeholder);
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

const unknownVarDeny = (
  input: HookInput,
  worktree: string | null,
  targets: readonly string[],
  command: string | undefined,
): HookDecision => {
  const refs = [
    ...new Set(
      targets.flatMap((target) =>
        path
          .relative(UNKNOWN_VAR, path.resolve(target))
          .split(path.sep)[0]
          .split("+")
          .filter(Boolean)
          .map(decodeURIComponent),
      ),
    ),
  ];
  let text = command ?? "";
  const first: string[] = [];
  // A command substitution, used as is or through `F=$(…)` (whose assignment
  // leaves the retry): the agent runs it first and spells out what it prints.
  const named = refs.map((ref) => {
    const name = /^\$(\w+)$/.exec(ref)?.[1];
    const set = name
      ? new RegExp(
          `(^|[\\s;&|(])${name}=("?)(\\$\\([^()]*\\)|\`[^\`]*\`)\\2[ \\t]*(?:&&|;|\\n)?[ \\t]*`,
        ).exec(text)
      : null;
    const sub = set?.[3] ?? (/^(?:\$\(|`)/.test(ref) ? ref : null);
    if (sub === null) return ref;
    if (set) text = text.replace(set[0], set[1]);
    first.push(`Run \`${sub.slice(sub.startsWith("`") ? 1 : 2, -1).trim()}\` first, then`);
    return sub === ref ? ref : `${ref} (set by \`${sub}\`)`;
  });
  const wt = worktree ?? "<worktree>";
  // `curl -K <config>` names no reference to spell out.
  const literal = literalForm(
    text,
    refs.filter((ref) => /^[$`]/.test(ref)),
  );
  const retry =
    command === undefined || literal === command
      ? ""
      : ` ${first.length ? `${first.join(" ")} retry` : "Retry"} as: \`${literal}\`.`;
  const unblock = `Spell the path out instead of ${refs.join(", ")}: Workit follows only a plain \`NAME=<literal>\` set earlier in the same command, \`$(mktemp …)\`, \`$PWD\` after a literal \`cd\` and a \`for\` over literal words.${retry} Write under ${wt} (\`workit git --cwd ${wt} …\`, \`workit check --cwd ${wt} …\`) or a temp dir.`;
  return {
    kind: "deny",
    reason: `workit worktree confinement: implementer ${input.session.agentId} writes to a path built from ${named.join(", ")}, which Workit cannot resolve (a command substitution, a loop over unknown or split words, a conditional, a binder such as read or eval, or an options file sets it), so it cannot tell whether the write stays in its worktree. ${unblock}`,
    unblock,
  };
};

/**
 * Judge an implementer's edit or mutating command by the absolute paths it
 * changes (`targets`). Only targets inside a git checkout, or Workit's
 * binding records, are judged (scratch and temp files elsewhere are host
 * policy). Binds on the first target inside a Workit worktree; denies a
 * target outside the bound worktree (or, unbound, outside every Workit
 * worktree). Deny reasons name a target as the agent spelled it; a path
 * built from a variable Workit cannot resolve is denied naming the variable,
 * with `command` (when given) spelled out as the form to retry.
 */
export function confineImplementer(
  input: HookInput,
  targets: readonly string[],
  command?: string,
): HookDecision {
  try {
    if (!input.session.agentId || hostIsolated(input.cwd, input.session.agentId)) return NONE;
    const unresolved = targets.filter((target) => within(path.resolve(target), UNKNOWN_VAR));
    if (unresolved.length > 0)
      return unknownVarDeny(input, boundWorktree(input), unresolved, command);
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
    case "config":
      return configWrites(rest);
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
  return confineImplementer(
    input,
    shellMutationTargets(input.cwd, command, dialect, true),
    command,
  );
}

// --- judges: verifiers and reviewers write only in a scratch dir (#790) ----

/** A judge's scratch dir, at a checkout root (fanout-worktree.ts SCRATCH_DIR). */
const SCRATCH = ".workit-scratch";
const SHELL_NAMES = /^(?:sh|bash|zsh|dash|ksh|mksh|ash)$/;
const INTERPRETERS = /^(?:python[\d.]*|node|bun|deno|ruby|perl|php)$/;
/** A script operand that is standard input or a process substitution. */
const FED = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$|^<\(/;
/** Words before the command they run (`env -i`, `sudo -u me`, `builtin`, `then`). */
const LEADS =
  /^(?:sudo|doas|env|command|builtin|exec|nohup|time|nice|timeout|stdbuf|xargs|busybox|!|\{|if|then|else|elif|do|while|until|\w+=.*|[-\d].*)$/s;
/** Commands a judge's refusal reads (a lead's option value is never one of them). */
const RUNS =
  /^(?:sh|bash|zsh|dash|ksh|mksh|ash|python[\d.]*|node|bun|deno|ruby|perl|php|eval|source|\.|workit)$/;
/** Interpreter options that run an inline script, a module, or nothing (help, version, `--test`). */
const INLINE = /^-[a-zA-Z]*[ceEpm]$|^--(?:eval|print|test|version|help)$|^-[hvV]$/;
/** Interpreter options that take the next word. */
const VALUED = /^-[WXIrC]$|^--(?:require|import|loader|conditions|input-type)$/;

/** The git common dir of the checkout at `root`: what its linked worktrees share. */
const commonDir = (root: string): string => gitDirsAt(root, null, false)?.[1] ?? "";

/**
 * Whether the real path `real` is in the scratch dir at the root of a
 * checkout of repository `repo` (its common dir; null outside every
 * repository: any), a scratch git repository made inside it included.
 */
const inScratch = (real: string, repo: string | null): boolean => {
  for (let dir = real; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) !== SCRATCH) continue;
    const root = path.dirname(dir);
    if (checkoutOf(root)?.root === root && (repo === null || commonDir(root) === repo)) return true;
  }
  return false;
};

/** Whether real path `real` is a `.git` file or inside a `.git` dir: git's own files, written only through git. */
const inGitDir = (real: string): boolean => real.split(/[\\/]/).includes(".git");

/** The config keys a scratch repository may hold (lowercased); `remote.*.url` is checked as a path. */
const SAFE_KEY =
  /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|user\..*|init\.defaultbranch|commit\.gpgsign|extensions\.(?:objectformat|refstorage)|branch\..*\.(?:remote|merge)|remote\..*\.fetch)$/;

/** Whether `value` is a literal absolute path in scratch or, with `checkout`, in a checkout of repository `repo`. */
const literalIn = (value: string, repo: string | null, checkout = false): boolean => {
  if (/[$`]/.test(value) || !path.isAbsolute(value)) return false;
  const real = canonical(value);
  const root = checkout ? checkoutOf(real)?.root : undefined;
  return (
    inScratch(real, repo) || (root !== undefined && (repo === null || commonDir(root) === repo))
  );
};

/** Each `key = value` of git config text, keys as lowercased `section.subsection.name`. */
const configEntries = (text: string): Array<[string, string]> => {
  const entries: Array<[string, string]> = [];
  let section = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[\s*([\w.-]+)(?:\s+"([^"]*))?/.exec(line);
    const entry = /^\s*([\w-]+)\s*(?:=\s*"?(.*?)"?)?\s*$/.exec(line);
    if (header) section = header[2] === undefined ? header[1] : `${header[1]}.${header[2]}`;
    else if (entry) entries.push([`${section}.${entry[1]}`.toLowerCase(), entry[2] ?? "true"]);
  }
  return entries;
};

/**
 * The real git dir, common dir and configured work tree git uses when run
 * in real dir `dir` ([] outside every repository); null when Workit cannot
 * tell or git would run code it does not see: a `.git` file with no gitdir
 * line, or a config key outside `SAFE_KEY` (a remote not in scratch or the
 * judged repository).
 */
function gitDirsAt(dir: string, repo: string | null, scan = true): string[] | null {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    let gitDir: string | null = null;
    try {
      if (fs.statSync(dotGit).isDirectory()) gitDir = canonical(dotGit);
      else {
        const named = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(dotGit, "utf8"))?.[1];
        if (!named) return null;
        gitDir = canonical(path.resolve(at, named));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // A bare repository, or a `.git` dir run in.
      if (["HEAD", "objects", "refs"].every((name) => fs.existsSync(path.join(at, name))))
        gitDir = canonical(at);
    }
    if (gitDir !== null) {
      const common = path.join(gitDir, "commondir");
      const shared = fs.existsSync(common)
        ? canonical(path.resolve(gitDir, fs.readFileSync(common, "utf8").trim()))
        : gitDir;
      const dirs = [gitDir, shared];
      for (const config of scan
        ? new Set([path.join(gitDir, "config"), path.join(shared, "config")])
        : []) {
        let text = "";
        try {
          text = fs.readFileSync(config, "utf8");
        } catch {
          continue;
        }
        for (const [key, value] of configEntries(text)) {
          if (key === "core.worktree") dirs.push(canonical(path.resolve(gitDir, value)));
          else if (
            /^remote\..*\.url$/.test(key) ? !literalIn(value, repo, true) : !SAFE_KEY.test(key)
          )
            return null;
        }
      }
      return dirs;
    }
    if (path.dirname(at) === at) return [];
  }
}

// A judge's git verbs and the options each may take: "shorts|longs". Shorts
// are getopt-style (`x:` takes a value, `x?` an optional glued one); longs
// are exact names (`name=` takes a value, `name?` an optional `=value`), so an
// abbreviation is denied. `+` marks a verb that writes: scratch repositories
// only. `@d` and `@l` stand for the diff and log options.
const DIFF_S = "psuRaWwbzU:S:G:l:M?C?B?D";
const DIFF_L =
  "stat? numstat shortstat name-only name-status summary patch no-patch raw color? no-color word-diff? color-words? unified= ignore-all-space ignore-space-change ignore-blank-lines ignore-cr-at-eol diff-filter= find-renames? find-copies? no-renames relative? abbrev? diff-algorithm= ignore-space-at-eol word-diff-regex= full-index binary exit-code quiet minimal patience histogram src-prefix= dst-prefix= no-prefix dirstat? text check function-context no-ext-diff no-textconv output=";
const LOG_S = "n:iEFPgL:";
const LOG_L =
  "oneline format= pretty? graph decorate? no-decorate all branches? tags? remotes? since= until= after= before= author= committer= grep= all-match invert-grep regexp-ignore-case extended-regexp fixed-strings perl-regexp max-count= skip= first-parent no-merges merges reverse follow date= abbrev-commit no-abbrev-commit left-right cherry-pick cherry-mark boundary not topo-order date-order source simplify-by-decoration ancestry-path full-history notes? no-notes walk-reflogs mailmap use-mailmap";
const GIT_VERBS: Readonly<Record<string, string>> = {
  log: "@d@l|@d @l",
  show: "@d@l|@d @l",
  diff: "@d|@d cached staged merge-base no-index",
  "diff-tree": "@drtcm|@d root stdin no-commit-id",
  "diff-index": "@dm|@d cached merge-base",
  status:
    "sbu?zv|short branch porcelain? long untracked-files? ignored? ignore-submodules? show-stash ahead-behind no-ahead-behind renames no-renames find-renames? column? no-column null verbose",
  "rev-parse":
    "q|verify short? abbrev-ref? symbolic symbolic-full-name show-toplevel show-prefix git-dir git-common-dir absolute-git-dir is-inside-work-tree is-inside-git-dir is-bare-repository show-cdup quiet all branches? tags? remotes? since= until= default= path-format= sq-quote",
  "rev-list": "@l|@l count objects? left-only right-only",
  "ls-files":
    "cdmoiskuvtzfx:X:|cached deleted modified others ignored stage unmerged killed directory no-empty-directory exclude-standard exclude= exclude-from= full-name abbrev? error-unmatch with-tree= eol deduplicate format= recurse-submodules sparse",
  "ls-tree": "rdtlz|long name-only name-status object-only full-name full-tree abbrev? format=",
  "cat-file":
    "tsepz|batch? batch-check? batch-all-objects follow-symlinks unordered buffer allow-unknown-type mailmap use-mailmap",
  blame:
    "L:lstfnepwbcM?C?|porcelain line-porcelain incremental root show-stats show-name show-number show-email abbrev= reverse= first-parent date= ignore-rev= ignore-revs-file= minimal contents=",
  describe:
    "|tags all long abbrev= contains always dirty? broken? match= exclude= first-parent exact-match candidates= debug",
  "merge-base": "a|all octopus independent is-ancestor fork-point",
  "for-each-ref":
    "|count= sort= format= color? shell perl python tcl points-at= merged? no-merged? contains? no-contains? ignore-case omit-empty exclude=",
  shortlog: "@lsnec|@l summary numbered email committer group= format=",
  "show-ref": "dsq|head verify heads tags branches hash? abbrev? quiet dereference exists",
  "name-rev": "|tags refs= exclude= all annotate-stdin name-only no-undefined always",
  grep: "aiIvnhHcEGFPlLzoWqwe:A:B:C:m:f:|cached untracked no-index no-exclude-standard exclude-standard recurse-submodules text ignore-case word-regexp invert-match line-number column count full-name extended-regexp basic-regexp fixed-strings perl-regexp files-with-matches name-only files-without-match null only-matching heading break show-function function-context max-depth= threads= and or not all-match quiet after-context= before-context= context= max-count= color? no-color",
  "format-patch":
    "@do:nNks|@d stdout output-directory= numbered no-numbered start-number= subject-prefix= root cover-letter thread? signoff attach? inline? suffix= base=",
  reflog: "@l|@l all expire= expire-unreachable= rewrite updateref stale-fix dry-run verbose",
  "count-objects": "vH|verbose human-readable",
  "check-ignore": "qvnz|quiet verbose stdin non-matching no-index",
  var: "l|",
  version: "|build-options",
  "ls-remote": "htbq|heads tags branches refs quiet exit-code get-url symref sort=",
  remote: "v|verbose",
  config: "lz|get get-all get-regexp list local name-only null type= default=",
  worktree:
    "fdqvzb:B:|force detach lock reason= orphan no-checkout checkout quiet track no-track guess-remote porcelain expire= verbose",
  branch:
    "dDmMcCfvraliu:|delete move copy force list all remotes verbose contains? merged? no-merged? points-at= show-current set-upstream-to= unset-upstream track? no-track sort= format= color? column? ignore-case create-reflog",
  tag: "lam:dfF:n?|list annotate message= file= delete force sort= format= contains? merged? no-merged? points-at= column? create-reflog ignore-case",
  init: "+qb:|quiet bare initial-branch= object-format= ref-format= shared? separate-git-dir=",
  add: "+AunNvf|all update intent-to-add force dry-run verbose ignore-errors ignore-removal no-all renormalize chmod= sparse",
  commit:
    "+m:aqsnF:C:ouv|message= all amend no-edit allow-empty allow-empty-message author= date= signoff no-verify quiet file= reuse-message= fixup= squash= only include dry-run no-gpg-sign untracked-files? cleanup= reset-author verbose",
  checkout: "+b:B:fqm|detach force orphan= quiet track? no-track merge ours theirs",
  switch:
    "+c:C:dfqm|create= force-create= detach discard-changes force orphan= quiet track? no-track merge",
  restore: "+s:SWq|source= staged worktree ours theirs merge quiet overlay no-overlay",
  reset: "+qN|soft mixed hard merge keep quiet no-refresh",
  rm: "+rfnq|cached force dry-run quiet ignore-unmatch",
  mv: "+fnkv|force dry-run verbose",
  merge:
    "+m:qvnX:|no-ff ff ff-only squash no-squash commit no-commit message= no-edit abort continue quit allow-unrelated-histories stat no-stat quiet verbose no-verify signoff strategy-option=",
  stash: "+m:ukqa|message= include-untracked keep-index quiet all index staged",
  apply:
    "+p:C:R3qv|check stat numstat summary index cached 3way reverse reject allow-empty exclude= include= verbose quiet whitespace= recount",
  am: "+skq3|signoff keep 3way quiet abort continue skip quit whitespace= reject",
  fetch:
    "+fqvptn|all depth= deepen= shallow-since= unshallow tags no-tags prune force quiet verbose dry-run update-shallow refmap=",
  clone:
    "+nqlsb:o:|bare no-checkout depth= branch= origin= single-branch no-single-branch no-tags quiet shared local no-local filter= separate-git-dir=",
  "cherry-pick":
    "+nm:sxX:|no-commit mainline= signoff abort continue skip quit allow-empty keep-redundant-commits ff strategy-option=",
  revert: "+nm:sX:|no-commit mainline= signoff abort continue skip quit strategy-option= no-edit",
  rebase:
    "+qvfnX:|onto= root abort continue skip quit keep-base no-ff force-rebase autosquash no-autosquash autostash no-autostash update-refs signoff quiet verbose stat no-stat committer-date-is-author-date reset-author-date rebase-merges? no-rebase-merges empty= strategy-option= apply merge",
  clean: "+dfnqxXe:|dry-run force quiet exclude=",
  bisect: "+|term-old= term-new= no-checkout first-parent",
};

/** The operands of git `args` (the verb first) when every option is in the verb's list, else null. */
const gitOperands = (args: readonly string[]): string[] | null => {
  const [verb = "", ...rest] = args;
  const spec = Object.hasOwn(GIT_VERBS, verb) ? GIT_VERBS[verb] : null;
  if (spec === null) return null;
  const [shorts, longs] = spec.split("|");
  const short = shorts.replace("@d", DIFF_S).replace("@l", LOG_S);
  const long = longs.replace("@d", DIFF_L).replace("@l", LOG_L).split(" ");
  const operands: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const arg = rest[at];
    if (arg === "--") return [...operands, ...rest.slice(at + 1)];
    if (!arg.startsWith("-") || arg === "-") operands.push(arg);
    else if (arg.startsWith("--")) {
      const [name] = arg.slice(2).split("=");
      const valued = arg.includes("=");
      if (long.includes(`${name}=`)) at += valued ? 0 : 1;
      else if (!long.includes(`${name}?`) && (valued || !long.includes(name))) return null;
    } else if (!/^-\d+$/.test(arg))
      for (let index = 1; index < arg.length; index++) {
        const found = /[:?+]/.test(arg[index]) ? -1 : short.indexOf(arg[index]);
        if (found < 0) return null;
        const takes = short[found + 1];
        if (takes === ":" && index === arg.length - 1) at++;
        if (takes === ":" || takes === "?") break;
      }
  }
  return operands;
};

/**
 * What git `args` (the verb first) are for a judge: "read" anywhere, "write"
 * only in a scratch repository, null refused. `local` says whether a source
 * (fetch, clone, ls-remote, remote show) is a path in scratch or the judged
 * repository.
 */
const gitKind = (
  args: readonly string[],
  local: (source: string, remote?: boolean) => boolean = () => true,
): "read" | "write" | null => {
  const named = gitOperands(args);
  if (!named) return null;
  const [verb] = args;
  const [first = "", second] = named;
  const has = (pattern: RegExp) => args.some((arg) => pattern.test(arg));
  switch (verb) {
    case "reflog":
      return /^(?:expire|delete)$/.test(first) ? "write" : "read";
    case "branch":
    case "tag":
      return leadOwnedGit(args) ||
        (named.length > 0 && !has(/^(?:-l|--list|--contains|--(?:no-)?merged|--points-at)$/))
        ? "write"
        : "read";
    case "config": {
      // A full listing prints the user's config: only a scratch repository's own (--local).
      if (has(/^(?:-l|--list|--get-regexp)$/) || first === "list")
        return has(/^--local$/) ? "write" : null;
      if (has(/^--get/) || first === "get" || named.length === 1) return "read";
      const [key = "", value] = first === "set" ? named.slice(1) : named;
      return /^(?:user\.(?:name|email)|init\.defaultbranch)$/i.test(key) ||
        (/^commit\.gpgsign$/i.test(key) && value === "false")
        ? "write"
        : null;
    }
    case "worktree":
      return first === "list" ? "read" : /^(?:add|remove)$/.test(first) ? "write" : null;
    case "remote":
      return !first || (first === "show" && named.length === 2 && local(second, true))
        ? "read"
        : null;
    case "ls-remote":
      return local(first || "origin", true) ? "read" : null;
    case "bisect":
      return /^(?:log|terms)$/.test(first)
        ? "read"
        : /^(?:start|good|bad|new|old|skip|reset)$/.test(first)
          ? "write"
          : null;
    case "blame": {
      const contents = args.findIndex((arg) => arg.startsWith("--contents"));
      const file = args[contents]?.slice(11) || args[contents + 1];
      return contents < 0 || local(file) ? "read" : null;
    }
    case "fetch":
      return !first || local(first, true) ? "write" : null;
    case "clone":
      return local(first) ? "write" : null;
  }
  return GIT_VERBS[verb].startsWith("+") ? "write" : "read";
};

const JUDGE_GIT = `a judge runs git ${Object.keys(GIT_VERBS).join(" ")} with the options each documents (no abbreviations), writing only in a scratch repo; no -c, no wrapper but timeout, nice, time, command, no env but PAGER=cat, GIT_PAGER=cat, GIT_OPTIONAL_LOCKS=0, LC_*, LANG, TZ; status outside scratch needs --no-optional-locks`;

/** Whether remote `name` of the repository at absolute dir `dir` has a url in scratch or the judged repository. */
const remoteIn = (dir: string, name: string, repo: string | null): boolean => {
  const shared = path.isAbsolute(dir) ? gitDirsAt(canonical(dir), repo, false)?.[1] : undefined;
  if (!shared) return false;
  const url = configEntries(fs.readFileSync(path.join(shared, "config"), "utf8")).find(
    ([key]) => key === `remote.${name}.url`.toLowerCase(),
  )?.[1];
  return url !== undefined && literalIn(url, repo, true);
};

/**
 * Why a judge may not run the git in `command` (#790): a verb, option,
 * wrapper, environment or source outside the allowlist (`GIT_VERBS`,
 * `JUDGE_GIT`), `--git-dir`/`--work-tree` outside scratch, or a `status`
 * that would refresh a non-scratch index. Null when it may.
 */
const judgeGit = (command: string, repo: string | null, depth = 0): string | null => {
  const runsGit = /\bgit\b/.test(command);
  for (const segment of segmentsOf(command)) {
    const words = segment.words;
    let why: string | null = null;
    let at = 0;
    while (/^(?:if|then|elif|else|do|while|until|!|\{|\()$/.test(words[at] ?? "")) at++;
    const lead: string[] = [];
    while (/^\w+\+?=/.test(words[at] ?? "")) lead.push(words[at++]);
    const name = path.basename(words[at] ?? "");
    // git anywhere but the command (or behind timeout, nice, time or command with only
    // options and numbers) runs behind a wrapper Workit does not judge, or is an alias or
    // hash entry; readers that only print the word are fine.
    let start = words.findIndex((word) => /(?:^|[\\/])git(?:\.exe)?(?:=|$)/.test(word));
    if (start > at) {
      if (
        /^(?:grep|egrep|rg|echo|printf|ls|wc|head|tail|cat|which|type|test|\[|cd|mkdir)$/.test(
          name,
        ) ||
        (name === "command" && /^-[vV]$/.test(words[at + 1] ?? ""))
      )
        start = -1;
      else if (
        !/^(?:timeout|nice|time|command)$/.test(name) ||
        words.slice(at + 1, start).some((word) => !/^(?:-[\w-]+|\d[\w.]*)$/.test(word))
      )
        why = `\`${name}\` runs git`;
    }
    if (start >= 0 && words[start].includes("=")) why = "git is redefined";
    // git by path runs only from outside scratch and the judged repository.
    const run = words[start] ?? "";
    if (run.includes("/") && (!path.isAbsolute(run) || literalIn(run, repo, true)))
      why ??= `\`${run}\` is not the system git`;
    // A command named by an expansion (`g?t`, `{git,x}`, `$X`) may be git with any arguments.
    if ((segment.expands?.includes(at) && name !== "[") || /\{[^}]*,/.test(words[at] ?? ""))
      why = "the command's name is expanded by the shell";
    // The words git receives are the words Workit reads: nothing the shell expands.
    if (
      start >= 0 &&
      (segment.expands?.length || words.some((word) => /\{[^}]*(?:,|\.\.)[^}]*\}|^~/.test(word)))
    )
      why ??= "a word in this git command is expanded by the shell: spell it as a literal";
    if (/^(?:export|declare|local|readonly|typeset)$/.test(name))
      lead.push(...words.slice(at + 1).filter((word) => /^\w+\+?=/.test(word)));
    // The environment a git in this command sees (assignments to exported names too).
    // BASH_ENV and ENV run a script in any shell, git in it or not.
    for (const word of runsGit ? lead : lead.filter((set) => /^(?:BASH_)?ENV=/.test(set)))
      if (!/^(?:(?:GIT_)?PAGER=cat|GIT_OPTIONAL_LOCKS=0|(?:LC_\w+|LANG|TZ)=[^$`]*)$/.test(word))
        why ??= `\`${word}\` is not allowed`;
    let index = start < 0 ? words.length : start + 1;
    let dir = "";
    let unlocked = lead.includes("GIT_OPTIONAL_LOCKS=0");
    for (; !why && words[index]?.startsWith("-") && words[index] !== "--version"; index++) {
      const word = words[index];
      const flag = /^--(git-dir|work-tree)(?:=([\s\S]*))?$/.exec(word);
      const value =
        flag?.[2] ?? (/^(?:-C|--git-dir|--work-tree)$/.test(word) ? words[++index] : "");
      if (word === "-C") dir = value;
      unlocked ||= word === "--no-optional-locks";
      if (flag ? !literalIn(value, repo) : !/^(?:-C|-P|--no-pager|--no-optional-locks)$/.test(word))
        why = `\`${word}\` is not allowed`;
    }
    const args = words[index] === "--version" ? ["version"] : words.slice(index);
    if (!why && start >= 0) {
      const local = (source: string, remote?: boolean) =>
        remote && /^[\w-][\w.-]*$/.test(source)
          ? remoteIn(dir, source, repo)
          : literalIn(source, repo, true);
      if (!gitKind(args, local)) why = `\`git ${args.slice(0, 2).join(" ")}\` is not allowed`;
      else if (args[0] === "status" && !unlocked) {
        const dirs = path.isAbsolute(dir) ? gitDirsAt(canonical(dir), repo) : null;
        if (!dirs?.length || !dirs.every((gitDir) => inScratch(gitDir, repo)))
          why = "`git status` refreshes the index outside scratch: add --no-optional-locks";
      }
    }
    // Scripts it runs, whatever their text: `$(…)`, and the `-c` operand or heredoc of a
    // shell, also behind wrappers (`timeout 5 bash -c`, `xargs sh -c`, `find -exec sh -c`).
    const shell = /^(?:grep|egrep|rg|echo|printf|cat)$/.test(name)
      ? -1
      : words.findIndex((word) => /^(?:sh|bash|zsh|dash|ksh|mksh|ash)$/.test(path.basename(word)));
    const scripts = [
      ...words.filter(
        (_, after) =>
          shell >= 0 && after > shell && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[after - 1]),
      ),
      ...(shell < 0 ? [] : (segment.stdin ?? [])),
    ];
    if (
      shell > at &&
      scripts.some((script) => /git/.test(script)) &&
      (!/^(?:timeout|nice|time|command)$/.test(name) ||
        words.slice(at + 1, shell).some((word) => !/^(?:-[\w-]+|\d[\w.]*)$/.test(word)))
    )
      why ??= `\`${name}\` runs git`;
    for (const script of [...(segment.subs ?? []), ...scripts])
      why ??=
        depth < 4 ? judgeGit(script, repo, depth + 1) : "scripts nest too deep for Workit to read";
    if (why) return why;
  }
  return null;
};

/** The workit verbs a judge runs, with their allowed subverbs (true: all); any other verb, a new one too, is denied. */
const JUDGE_VERBS: Readonly<Record<string, true | readonly string[]>> = {
  check: true,
  dir: true,
  help: true,
  "test-audit": true,
  ledger: ["verdict", "finding", "list", "check", "ruling"],
  pr: ["status"],
  ci: ["wait", "logs"],
  fanout: ["status", "brief"],
  models: ["show"],
  lock: ["status"],
};

const HELP = /^(?:--help|-h)$/;

/** The call when workit `args` are outside a judge's job, else null; help is only right after workit or the verb. */
const judgeVerbRefused = (args: readonly string[]): string | null => {
  const { rest } = skipWorkitGlobals(args);
  const end = rest.indexOf("--");
  const call = end < 0 ? rest : rest.slice(0, end);
  const [verb, sub = ""] = call;
  if (verb === undefined || verb === "--version" || HELP.test(verb) || HELP.test(sub)) return null;
  const allowed = Object.hasOwn(JUDGE_VERBS, verb) ? JUDGE_VERBS[verb] : [];
  const ok =
    allowed === true
      ? !(verb === "test-audit" && call.some((arg) => /^--mutate(?:=|$)/.test(arg)))
      : allowed.includes(sub);
  return ok ? null : `workit ${call.join(" ")}`;
};

/** Package runners and interpreters that can start the workit CLI. */
const CLI_RUNNERS = /^(?:npx|bunx|pnpx|npm|pnpm|yarn|bun|node|nodejs|deno|tsx|ts-node)$/;
/** The workit CLI: its bin, its package, or its entry file (packages/workit-cli, the installed package). */
const CLI_ENTRY =
  /(?:^|[=\\/])(?:workit(?:\.(?:exe|cmd|[cm]?js))?|@workit-dev\/cli(?:@\S*)?)$|(?:workit-cli|@workit-dev[\\/]cli)[\\/](?:src[\\/](?:index|main)|dist[\\/]index)\.[cm]?[jt]sx?$/;

/**
 * The arguments of each workit CLI call in `command`: past wrappers (`time`,
 * `env`, `exec`), compound commands, `xargs`, `find -exec`, aliases (their
 * bodies, and their uses expanded) and package runners or interpreters that
 * start the CLI by package or path.
 */
const workitCalls = (
  command: string,
  depth = 0,
  aliases = new Map<string, string>(),
): string[][] =>
  depth > 4
    ? []
    : commandLines(command).flatMap((words) => {
        const name = path.basename(words[0] ?? "").toLowerCase();
        if (name === "alias")
          return words.flatMap((word) => {
            const set = /^([\w-]+)=(.*)$/s.exec(word);
            if (!set) return [];
            aliases.set(set[1], set[2]);
            return workitCalls(set[2], depth + 1, aliases);
          });
        const body = aliases.get(words[0] ?? "");
        if (body !== undefined)
          return workitCalls(
            [body, ...words.slice(1).map((word) => `'${word.replaceAll("'", `'\\''`)}'`)].join(" "),
            depth + 1,
            aliases,
          );
        let at = /^workit(?:\.exe|\.cmd)?$/.test(name)
          ? 0
          : CLI_RUNNERS.test(name)
            ? words.findIndex((word, index) => index > 0 && CLI_ENTRY.test(word))
            : -1;
        if (at < 0) return [];
        while (words[at + 1] === "--" || CLI_ENTRY.test(words[at + 1] ?? "")) at++;
        return [words.slice(at + 1)];
      });

const JUDGE_JOB = Object.entries(JUDGE_VERBS)
  .map(([verb, subs]) => `workit ${verb}${subs === true ? "" : ` ${subs.join("|")}`}`)
  .join(", ");

/**
 * Why a judge may not run `command` (#790), or null: a shell or interpreter
 * reading a script Workit cannot see (piped, on stdin, a process
 * substitution), `eval`, or a workit verb outside its job; in `$(…)`, `-c`
 * scripts and `workit check --` too. A shell fed a heredoc with no directory
 * change before it is read instead: its script goes to `fed`.
 */
const judgeRefusal = (command: string, fed: string[], depth = 0): string | null => {
  let moved = false;
  for (const segment of segmentsOf(command)) {
    const nested = (script: string | undefined) =>
      script !== undefined && depth < 4 ? judgeRefusal(script, fed, depth + 1) : null;
    for (const sub of segment.subs ?? []) {
      const why = nested(sub);
      if (why) return why;
    }
    const { words } = segment;
    const runs = (word = "") => RUNS.test(path.basename(word).toLowerCase());
    let at = 0;
    while (
      at < words.length &&
      (LEADS.test(words[at]) || (/^-\w$/.test(words[at - 1] ?? "") && !runs(words[at])))
    )
      at++;
    const name = path.basename(words[at] ?? "").toLowerCase();
    const args = words.slice(at + 1);
    const unseen = `\`${words.join(" ").slice(0, 80)}\` runs a script Workit cannot read (piped, on stdin, a process substitution or eval): write the case to a file in ${SCRATCH} and dispatch it from a test instead`;
    if (/^(?:cd|chdir|pushd|popd)$/.test(name)) moved = true;
    if (name === "eval" || ((name === "source" || name === ".") && FED.test(args[0] ?? "")))
      return unseen;
    if (SHELL_NAMES.test(name)) {
      let operand: string | undefined;
      let stdin = false;
      let inline: number | undefined;
      for (let index = 0; index < args.length && inline === undefined; index++) {
        const arg = args[index];
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) inline = index + 1;
        else if (/^[-+][oO]$/.test(arg)) index++;
        else if (arg === "--" || !/^[-+]/.test(arg)) {
          operand = arg === "--" ? args[index + 1] : arg;
          break;
        } else if (/^-[a-zA-Z]*s/.test(arg)) stdin = true;
      }
      if (inline !== undefined) {
        const why = nested(args[inline]);
        if (why) return why;
      } else if (operand === undefined || stdin || FED.test(operand)) {
        if (!segment.stdin?.length || moved || (operand !== undefined && !stdin)) return unseen;
        fed.push(...segment.stdin);
        for (const body of segment.stdin) {
          const why = nested(body);
          if (why) return why;
        }
      }
    }
    if (INTERPRETERS.test(name) && !args.some((arg) => INLINE.test(arg))) {
      const operand = args.find(
        (arg, index) =>
          (arg === "-" || !arg.startsWith("-")) && !VALUED.test(args[index - 1] ?? ""),
      );
      if (FED.test(operand ?? "") || (operand === undefined && !/^(?:bun|deno)$/.test(name)))
        return unseen;
    }
    const tail = workitCheckTail(words.slice(at));
    if (tail) {
      const why = nested(
        "script" in tail
          ? tail.script
          : tail.argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "),
      );
      if (why) return why;
    }
  }
  for (const args of workitCalls(command)) {
    const call = judgeVerbRefused(args);
    if (call) return `\`${call}\` is not a judge's job: a judge runs only ${JUDGE_JOB}`;
  }
  return null;
};

/**
 * An unquoted heredoc whose body holds `$(…)` or a backtick: the shell runs
 * that command while it writes the file, whatever the file is (#790).
 */
const substitutingHeredoc = (command: string): boolean => {
  for (const match of command.matchAll(/(?<!<)<<-?[ \t]*([^\s<>;&|()]+)/g)) {
    const delimiter = match[1];
    if (/['"\\]/.test(delimiter)) continue;
    const newline = command.indexOf("\n", match.index + match[0].length);
    if (newline < 0) continue;
    const lines = command.slice(newline + 1).split("\n");
    const end = lines.findIndex((line) => line.trim() === delimiter);
    // `$((…))` is arithmetic, not a command (a `$(` inside it still is).
    if (/\$\((?!\()|`/.test((end < 0 ? lines : lines.slice(0, end)).join("\n"))) return true;
  }
  return false;
};

/**
 * A judge writes in the scratch dir of any checkout of the judged repository:
 * the hook cwd's, and the candidate worktree's when `target` is in another
 * checkout of the same repository (#792 item 32), so the deny names both.
 */
const judgeDeny = (input: HookInput, what: string, target?: string): HookDecision => {
  const role = input.session.agentType?.endsWith("reviewer") ? "reviewer" : "verifier";
  const root = checkoutOf(input.cwd)?.root;
  const candidate = target ? checkoutOf(target)?.root : undefined;
  const also =
    root && candidate && candidate !== root && commonDir(candidate) === commonDir(root)
      ? ` or ${path.join(candidate, SCRATCH)}`
      : "";
  const scratch = root
    ? `${path.join(root, SCRATCH)}${also}`
    : `${SCRATCH}/ at the root of the checkout you judge`;
  const unblock = `Write only under ${scratch} (mkdir -p it): put a generated case in a file there with a quoted heredoc (<<'EOF') and never run it in the shell. Reads, \`workit check\` and \`workit ledger verdict|finding\` stay allowed; a change the candidate needs is a finding, not an edit.`;
  return {
    kind: "deny",
    reason: `workit scratch confinement: ${role} ${input.session.agentId} may write only in its scratch dir ${scratch}, and ${what}. ${unblock}`,
    unblock,
  };
};

/**
 * Judge a verifier's or reviewer's edit or command by the absolute paths it
 * changes: each must be in the scratch dir of a checkout of the judged
 * repository (the hook cwd's). git is judged by the repository it runs
 * against, so only a scratch repository's own git writes pass. A path built
 * from a variable or a directory change Workit cannot resolve is denied too.
 */
export function confineJudge(
  input: HookInput,
  targets: readonly string[],
  placeholders: ReadonlySet<string> = placeholdersOf(targets),
): HookDecision {
  try {
    if (!input.session.agentId) return NONE;
    const judged = checkoutOf(input.cwd);
    const repo = judged ? commonDir(judged.root) : null;
    for (const target of targets) {
      const resolved = path.resolve(target);
      if (within(resolved, UNKNOWN_VAR) || within(resolved, UNKNOWN_DIR))
        return judgeDeny(
          input,
          "it writes to a path Workit cannot resolve (a variable, a command substitution or `cd -`): spell the path out",
        );
      const real = canonical(target);
      // git writes the git dir it finds from where it runs, not that directory.
      const runsGit =
        placeholders.has(target) &&
        /^\.workit-(?:runs-git|live-target)$/.test(path.basename(target));
      const gitDirs = runsGit ? gitDirsAt(path.dirname(real), repo) : [];
      if (gitDirs === null)
        return judgeDeny(
          input,
          `git in ${shown(target)} uses a git dir or config Workit cannot check`,
        );
      if (
        runsGit
          ? gitDirs.length > 0
            ? gitDirs.every((dir) => inScratch(dir, repo))
            : inScratch(real, repo)
          : inScratch(real, repo) && !inGitDir(real)
      )
        continue;
      const runner = runnerAt(target);
      return judgeDeny(
        input,
        runner === null
          ? `${shown(target)} is outside it`
          : `\`${runner}\` runs in ${shown(target)}, outside it`,
        target,
      );
    }
    return NONE;
  } catch {
    return NONE;
  }
}

/**
 * Judge a verifier's or reviewer's shell command: a script it cannot read or
 * a workit verb outside its job (`judgeRefusal`), an unquoted heredoc that
 * runs a command substitution, then every path it may change (the strict
 * analysis, a heredoc a shell reads, git's ref, config and worktree writes).
 */
export function confineJudgeShell(
  input: HookInput,
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision {
  try {
    if (!input.session.agentId) return NONE;
    const fed: string[] = [];
    let refused: string | null;
    try {
      refused = dialect === "posix" ? judgeRefusal(command, fed) : null;
    } catch {
      refused = "Workit cannot read this command: split it into simpler ones";
    }
    if (!refused && dialect === "posix") {
      const judged = checkoutOf(input.cwd);
      try {
        const why = judgeGit(command, judged ? commonDir(judged.root) : null);
        if (why) refused = `${why}: ${JUDGE_GIT}`;
      } catch {
        refused = "Workit cannot read this command: split it into simpler ones";
      }
    }
    if (refused) return judgeDeny(input, refused);
    if (dialect === "posix" && substitutingHeredoc(command))
      return judgeDeny(
        input,
        "an unquoted heredoc runs the `$(…)` or backtick command in its body: quote the delimiter (<<'EOF')",
      );
    let git: string[] = [];
    try {
      git = rawInvocations(command, dialect).flatMap(({ tool, dir, args }) =>
        tool === "git" &&
        (args[0] === "push" ||
          leadOwnedGit(args) ||
          (gitKind(args) === "write" && !/^(?:init|clone)$/.test(args[0])))
          ? [
              path.join(
                dir === undefined ? UNKNOWN_DIR : path.resolve(input.cwd, dir ?? "."),
                `${OPAQUE_TARGET}git`,
              ),
            ]
          : [],
      );
    } catch {
      // The strict analysis below still judges the command.
    }
    const lists = [
      shellMutationTargets(input.cwd, command, dialect, true),
      ...fed.map((body) => shellMutationTargets(input.cwd, body, "posix", true)),
    ];
    return confineJudge(
      input,
      [...lists.flat(), ...git],
      new Set([...git, ...lists.flatMap((list) => [...placeholdersOf(list)])]),
    );
  } catch {
    return NONE;
  }
}
