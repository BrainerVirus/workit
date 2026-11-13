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
  shellMutationTargets,
  UNKNOWN_DIR,
  UNKNOWN_VAR,
} from "./write-gate";

/** Written by `workit fanout worktree create` into git's admin dir for the worktree. */
export const FANOUT_TOKEN_FILE = "workit-fanout-token";

const NONE: HookDecision = { kind: "none" };
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * The real path of `file`'s nearest existing ancestor, plus the rest; a
 * dangling symlink on the way is followed to where a write through it lands.
 */
const canonical = (file: string, hops = 0): string => {
  let rest = "";
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return path.resolve(file);
      let link: string | null = null;
      try {
        link = fs.readlinkSync(dir);
      } catch {
        // Not a link: a part that does not exist yet.
      }
      if (link !== null)
        return hops < 40
          ? canonical(path.join(path.resolve(path.dirname(dir), link), rest), hops + 1)
          : path.resolve(file);
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
const commonDir = (root: string): string => {
  const dotGit = path.join(root, ".git");
  if (!fs.statSync(dotGit).isFile()) return canonical(dotGit);
  const admin = path.resolve(
    root,
    /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "",
  );
  const common = path.join(admin, "commondir");
  return canonical(
    fs.existsSync(common) ? path.resolve(admin, fs.readFileSync(common, "utf8").trim()) : admin,
  );
};

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
 * repository (the hook cwd's). A path built from a variable or a directory
 * change Workit cannot resolve is denied too.
 */
export function confineJudge(input: HookInput, targets: readonly string[]): HookDecision {
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
      if (inScratch(canonical(target), repo)) continue;
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
    if (refused) return judgeDeny(input, refused);
    if (dialect === "posix" && substitutingHeredoc(command))
      return judgeDeny(
        input,
        "an unquoted heredoc runs the `$(…)` or backtick command in its body: quote the delimiter (<<'EOF')",
      );
    let git: string[] = [];
    try {
      git = rawInvocations(command, dialect).flatMap(({ tool, dir, args }) => {
        if (tool !== "git" || (args[0] !== "push" && !leadOwnedGit(args))) return [];
        const at = dir === undefined ? UNKNOWN_DIR : path.resolve(input.cwd, dir ?? ".");
        // `git worktree add <path>` also writes the new checkout at <path>.
        const added =
          args[0] === "worktree" && args[1] === "add"
            ? args
                .slice(2)
                .find(
                  (arg, index, rest) =>
                    !arg.startsWith("-") && !/^(?:-[bB]|--reason)$/.test(rest[index - 1] ?? ""),
                )
            : undefined;
        return [
          path.join(at, `${OPAQUE_TARGET}git`),
          ...(added === undefined ? [] : [path.resolve(at, added)]),
        ];
      });
    } catch {
      // The strict analysis below still judges the command.
    }
    return confineJudge(input, [
      ...shellMutationTargets(input.cwd, command, dialect, true),
      ...fed.flatMap((body) => shellMutationTargets(input.cwd, body, "posix", true)),
      ...git,
    ]);
  } catch {
    return NONE;
  }
}
