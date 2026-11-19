// The verb table (design §2.0). Every verb is a lazily imported module that
// exports `run(argv, io): Promise<number>`, so `workit --version`/`help` load
// nothing but this file and the router, and no verb pays for ink/react.
//
// It is also the help source: `workit help <verb> [<sub>]` and `--help`/`-h`
// anywhere before a bare `--` print these usage lines, and
// test/workit-cli/help.test.ts holds every flag a verb's parser accepts to
// the flags its usage lines name.
//
// A verb registered ahead of its slice sets `planned` (kept out of
// `workit help`) and answers `not_implemented`; S12 implemented the last one.
import type { Verb } from "../output";

export type VerbGroup = "setup" | "task" | "delivery";

export type SubcommandEntry = {
  name: string;
  /** Other spellings the verb accepts for this subcommand. */
  aliases?: readonly string[];
  usage: string;
  summary: string;
  /** Flags this subcommand takes under another spelling: alias (no dashes) to the flag the parser reads. */
  flagAliases?: Readonly<Record<string, string>>;
  /** Flags agents guess that do not exist here: flag (no dashes) to the one-line fix. */
  flagHints?: Readonly<Record<string, string>>;
  /** Flags the parser refuses with its own guidance; the router leaves them to it. */
  deferredFlags?: readonly string[];
  /** Engine flags this subcommand accepts; the verb's note lists them once, not on the usage line. */
  engineFlags?: string;
};

export type VerbEntry = {
  name: string;
  group: VerbGroup;
  /** One line; for a verb with subcommands, derived from their names. */
  usage: string;
  summary: string;
  subcommands?: readonly SubcommandEntry[];
  /** The verb runs without a subcommand too (`grant` shows, `verify-delivery` infers). */
  optionalSubcommand?: boolean;
  examples?: readonly string[];
  /** One parser reads every subcommand's flags, so any flag its usage names is valid for all of them. */
  sharedParser?: boolean;
  /** Everything after the first positional goes to another program untouched (`launch <host> …`). */
  passthrough?: boolean;
  /** `flagAliases` and `flagHints` for a verb without subcommands. */
  flagAliases?: Readonly<Record<string, string>>;
  flagHints?: Readonly<Record<string, string>>;
  /** Subcommands agents guess from git that do not exist here: the word to the one-line fix. */
  subcommandGuesses?: Readonly<Record<string, string>>;
  /** Like `subcommandGuesses`, but the fix is built from the words after the guess (`git switch -c x` -> `workit git branch x`). */
  subcommandGuessFor?: Readonly<Record<string, (rest: readonly string[]) => string>>;
  /** Paragraphs `workit help <verb>` prints after the summary. */
  notes?: readonly string[];
  /** The slice that implements this verb; set while it is a stub. */
  planned?: string;
  load: () => Promise<Verb>;
};

// Kept in sync with core OPERATION_FAMILIES by test (importing the contract
// here would pull zod onto the cold path).
export const TASK_FAMILY_NAMES = [
  "task",
  "policy",
  "evidence",
  "finding",
  "decision",
  "worker",
  "state",
] as const;

type Family = (typeof TASK_FAMILY_NAMES)[number];

const FAMILY_OPTIONS =
  "[--task <id>] [--payload <JSON|@file|->] [--revision <r>] [--workspace-revision <r|null>] [--view <v>] [--actor <a>] [--confirm]";

// The family grammar's actions, kept equal to task.ts TASK_ACTIONS by test.
export const FAMILY_ACTIONS: Record<Family, Record<string, string>> = {
  task: {
    list: "List the workspace's tasks",
    inspect: "Show one task's full state",
    revise: "Change a task's intent or scope",
    progress: "Record progress on a task",
    pause: "Pause a task",
    resume: "Resume a paused task",
    start: "Start a task from a full payload",
    close: "Close a task by id",
  },
  policy: {
    assess: "Judge the branch's work and record the derived checks, verdicts and gates",
    preview: "Show what a judgment would derive, without recording it",
    explain: "Explain the policy in force",
  },
  evidence: { record: "Record evidence against a task's requirements" },
  finding: {
    record: "Record a finding; --queue files it as a tracker issue (or a comment on <issue>)",
    resolve: "Resolve a finding",
    list: "List findings with their ids [--branch <b>] [--status open|resolved]",
  },
  decision: {
    record: "Record a task decision",
    revoke: "Revoke a task decision",
  },
  worker: {
    assign: "Assign a worker to a task",
    report: "Report a worker's result",
    cancel: "Cancel a worker assignment",
  },
  state: {
    export: "Export a task's state (v1)",
    import: "Import an exported task state",
  },
};

const POLICY_JUDGE =
  "--judge risk=trivial|normal|high behavior=yes|no product-choice=yes|no plan=yes|no [--ref <path>]… [--why <reason>]";

// The implicit-task forms of `workit task` (verbs/task.ts), ahead of the family grammar.
const TASK_IMPLICIT: SubcommandEntry[] = [
  {
    name: "status",
    usage: "workit task status [--all]",
    summary: "The current branch's task, or every task with --all",
  },
  {
    name: "start",
    usage: 'workit task start "<objective>"',
    summary: "Start tracking the current branch's task (idempotent per branch)",
    engineFlags: FAMILY_OPTIONS,
  },
  {
    name: "note",
    usage: 'workit task note [--next "<t>"] [--objective "<t>"] [--] "<text>"',
    summary: "Add a progress note to the current branch's task (creates it if needed)",
  },
  {
    name: "close",
    usage: 'workit task close [--outcome verified|limited|stopped] [--summary "<t>"]',
    summary: "Close the current branch's task, or a task by id",
    engineFlags: FAMILY_OPTIONS,
  },
  {
    name: "adopt",
    usage: "workit task adopt <id>",
    summary: "Bind a migrated or other task to the current branch",
  },
];

const familySubcommands = (name: Family): SubcommandEntry[] => {
  const implicit = name === "task" ? TASK_IMPLICIT : [];
  const grammar = Object.entries(FAMILY_ACTIONS[name])
    .filter(([action]) => !implicit.some((entry) => entry.name === action))
    .map(([action, summary]): SubcommandEntry => {
      if (name === "finding" && action === "list")
        return {
          name: action,
          usage: "workit finding list [--branch <b>] [--status open|resolved] [--json]",
          summary,
        };
      if (name === "finding" && action === "record")
        return {
          name: action,
          usage: "workit finding record [--queue [<issue>]]",
          summary,
          engineFlags: FAMILY_OPTIONS,
        };
      const usage =
        name === "task" && action === "list"
          ? "workit task list [--status all]"
          : name === "policy" && action !== "explain"
            ? `workit policy ${action} ${POLICY_JUDGE}`
            : name === "worker" && action !== "assign"
              ? `workit worker ${action} [<workerId>]`
              : `workit ${name} ${action}`;
      return {
        name: action,
        usage,
        summary,
        engineFlags: FAMILY_OPTIONS,
        ...(name === "task" && action === "list"
          ? {
              flagHints: {
                limit:
                  "workit task list prints every task and takes only --status all; pipe the output through head to cut it",
              },
            }
          : {}),
      };
    });
  return [...implicit, ...grammar];
};

export const ENGINE_NOTE = "Engine flags, taken by every action above";

/** The engine flags once, under the list: every action that takes them, and the ones that do not. */
const engineNote = (subs: readonly SubcommandEntry[]): string[] => {
  const plain = subs.filter((sub) => !sub.engineFlags).map((sub) => sub.name);
  if (plain.length === subs.length) return [];
  const except = plain.length ? ` except ${plain.join(", ")}` : "";
  return [`${ENGINE_NOTE}${except}: ${FAMILY_OPTIONS}`];
};

const family = (name: Family): VerbEntry => {
  const subcommands = familySubcommands(name);
  return withSubcommands({
    name,
    group: "task",
    summary:
      name === "task"
        ? "The current branch's task (created by its first note, check or recording; no ids needed), or the task family"
        : name === "policy"
          ? "Judge the branch's work; Workit derives its checks, verdicts, decision and plan gates"
          : `Inspect and control a Workit task (${name} family)`,
    subcommands,
    notes: engineNote(subcommands),
    ...(name === "task"
      ? {
          examples: [
            'workit task note "parser done; wiring the router" --next "add the router test"',
            "workit task close --outcome verified",
          ],
        }
      : name === "policy"
        ? {
            examples: [
              "workit policy assess --judge risk=normal behavior=yes product-choice=no plan=no",
            ],
          }
        : {}),
    load: async () => (await import("./family")).familyVerb(name),
  });
};

/** A verb with subcommands lists their names on its one-line usage. */
/** The rest of a guessed git command, without the flags the router reads itself. */
const gitRest = (rest: readonly string[]): string[] => {
  const out: string[] = [];
  for (let index = 0; index < rest.length; index += 1)
    if (rest[index] === "--cwd") index += 1;
    else if (rest[index] !== "--json" && !rest[index].startsWith("--cwd=")) out.push(rest[index]);
  return out;
};

/** The branch `git switch -c <b>` / `git checkout -b <b>` would create, else null. */
const createdBranch = (rest: readonly string[]): string | null => {
  for (let index = 0; index < rest.length; index += 1) {
    const inline = /^--(?:force-)?create=(.+)$/u.exec(rest[index]);
    if (inline) return inline[1];
    if (/^(?:-[cCbB]|--(?:force-)?create)$/u.test(rest[index])) {
      const name = rest[index + 1];
      return name && !name.startsWith("-") ? name : null;
    }
  }
  return null;
};

const switchGuess = (rest: readonly string[]): string => {
  const words = gitRest(rest);
  const created = createdBranch(words);
  if (created)
    return `workit git branch ${created} creates it from the trunk and switches to it (add --carry to take uncommitted changes along)`;
  const target = words.find((word) => !word.startsWith("-"));
  return target
    ? `moving to an existing branch runs raw: git switch ${target}; workit git branch <name> creates a new one`
    : "workit git branch <name> creates a branch and switches to it; git switch <branch> moves to an existing one";
};

/** `git status|diff|log …`: read-only, so it needs no workit verb. */
const readOnlyGuess =
  (word: string, plain: string) =>
  (rest: readonly string[]): string => {
    const words = gitRest(rest);
    return `read-only git runs raw, no workit verb: run git ${words.length ? `${word} ${words.join(" ")}` : plain} directly`;
  };

function withSubcommands(
  entry: Omit<VerbEntry, "usage"> & { subcommands: readonly SubcommandEntry[] },
  options: { optional?: boolean } = {},
): VerbEntry {
  const names = entry.subcommands.map((sub) => sub.name).join("|");
  return {
    ...entry,
    usage: `workit ${entry.name} ${options.optional ? `[${names}]` : names} [options]`,
    ...(options.optional ? { optionalSubcommand: true } : {}),
  };
}

const LEASE_NOTES = [
  "The heavy-check lease: heavy work (tests, builds, installs, image builds) shares one machine-wide lease, so parallel agents and worktrees never exhaust this machine's memory and CPU. `slots` (default 1) heavy checks run at once; on Linux each also runs in a systemd scope with MemoryMax and CPUQuota.",
  "Queueing: a heavy check that finds every slot held joins a queue served shortest measured run first (a waiter queued 5 min goes ahead of newer ones) and prints `waiting for the heavy-check lease` naming the holder (check, pid, session, age, directory) and its position, then a status line every 30 s. It waits `--wait <dur>` (90, 90s, 30m, 1h), else `resources.wait` (default 30 min), and exits 4 (busy) only past that wait or at once with --no-wait. A waiter that is killed gives up its place. A wait longer than your shell tool's timeout belongs in a background call. `workit lock status` shows the holders and the queue.",
  "Light checks: the named checks lint, typecheck and format (`resources.light`, set in workspaces.json) never take the lease, so they run at once beside a long suite.",
  'Without a slot: a check whose last measured run took under 30 s, or a network-bound one (`"heavy": "io"` in .workit/checks.json, --io ad hoc), runs at once while the memory budget and the pressure gate allow.',
  "--heavy: an ad-hoc `workit check -- <cmd>` takes the lease only with --heavy; the named checks test and build always do. The shell hook runs a raw heavy command (`npx jest`, `npm run test:ci`, `cargo test`, `docker build`) as `workit check --heavy -- <cmd>` on Claude Code, OpenCode and Pi, and denies it with that exact command on Codex and Cursor.",
  '--no-lease skips the lease and needs --reason "<why>". Never hand-roll a flock: the lease already queues every agent on the machine.',
  "Output: a check prints the last 60 lines of its output and one summary line with `log: <path>` to the full log; --full streams all of it.",
];

const VERIFY_OPTIONS =
  "[--expect pushed|pr|merged|released] [--pr <n> | --branch <b>] [--sha <sha>] [--tag <t>] [--package <name[@version]>]";

const LEDGER_ACTOR =
  "[--branch <b> | --pr <n>] [--supersedes <id>] [--session <id> [--token <t>] | --as <role>]";

export const VERBS: readonly VerbEntry[] = [
  {
    name: "init",
    group: "setup",
    usage: "workit init",
    summary: "Run the interactive setup wizard",
    load: () => import("./init"),
  },
  {
    name: "setup",
    group: "setup",
    usage:
      "workit setup [--hosts=claude-code,codex,cursor,opencode,pi] [--no-shell] [--dry-run | --yes]",
    summary:
      "Write Workit's host permission block after showing the diff; run it in your own terminal",
    notes: [
      "--hosts takes claude-code, codex, cursor, opencode, pi (default: all five); --dry-run prints the diff and changes nothing; --yes writes it without asking; --no-shell leaves Claude Code's CLAUDE_CODE_SHELL unset for a zsh user. Only the user writes it, in their own terminal: from an agent session the CLI prints the diff and refuses to write it, handing over the command, and a host may also ask about or deny the agent's call.",
    ],
    load: () => import("./setup"),
  },
  {
    name: "upgrade",
    group: "setup",
    usage:
      "workit upgrade [--hosts=a,b|none] [--cli] [--preview | --yes | --apply --confirm | --check] [--set-updates=prompt|auto|off] [--json]",
    summary:
      "Upgrade the CLI and every host after one confirmation, then verify with doctor; --check compares installed and latest versions",
    load: () => import("./upgrade"),
  },
  {
    name: "launch",
    group: "setup",
    passthrough: true,
    usage: "workit launch <host> [--auto-upgrade] [-- <host args…>]",
    summary: "Upgrade before host startup, then start the host",
    load: () => import("./launch"),
  },
  {
    name: "doctor",
    group: "setup",
    usage: "workit doctor [--fix] [--fix-lock [--force [--yes]]]",
    summary:
      "Verify the offline installation health (--fix installs the session trailer hook; --fix-lock clears a stale workit store lock)",
    load: () => import("./doctor"),
  },
  {
    name: "gc",
    group: "setup",
    usage:
      "workit gc [--dry-run] [--prune-recovery --yes] | --worktrees [--apply] | --branches [--apply] | --procs [--apply]",
    summary:
      "Compact long task event logs, drop unreferenced blobs and old check logs; report (or prune) 2.x recovery copies; --worktrees lists (--apply removes) clean worktrees whose work is on the trunk; --branches lists (--apply deletes) local branches whose work is on the trunk; --procs lists (--apply stops) orphaned background processes",
    load: () => import("./gc"),
  },
  {
    name: "dir",
    group: "setup",
    usage: "workit dir [plans|retros|handoffs|notes|config|state|data|cache|runtime]",
    summary:
      "Print where a kind of file lives (the first four per clone, the rest per user); bare, list the kinds",
    examples: ["workit dir", "workit dir plans", "workit dir state --json"],
    load: () => import("./dir"),
  },
  {
    name: "completion",
    group: "setup",
    usage: "workit completion <zsh|bash|fish|powershell>",
    summary:
      "Print the shell completion script (setup and upgrade install it for $SHELL); verbs, subcommands, flags, check names, slice ids, workspaces",
    examples: ["workit completion zsh > ~/.local/share/zsh/site-functions/_workit"],
    load: () => import("./completion"),
  },
  {
    name: "install",
    group: "setup",
    usage: "workit install --hosts=<h,…> [--preview | --yes]",
    summary: "Install or repair Workit on the named hosts only",
    notes: [
      "--hosts takes the lowercase ids claude-code, codex, cursor, opencode, pi; --preview prints the files, config keys, host commands and notes and changes nothing; --yes installs them; with neither it asks at a terminal. It never changes the Workit config, a workspace or another host, and a host whose CLI is not on PATH shows a blocked row. Only the user applies it, in their own terminal: from an agent session the CLI runs --preview and refuses the rest, handing over the command, and a host may also ask about or deny the agent's call.",
    ],
    load: () => import("./install"),
  },
  {
    name: "uninstall",
    group: "setup",
    usage: "workit uninstall [--hosts=<h,…> [--preview | --yes]]",
    summary: "Remove Workit from the picked or named hosts (keeps the Workit config)",
    notes: [
      "No flags: the interactive picker (hosts and the owned CLI install). --hosts takes the lowercase ids claude-code, codex, cursor, opencode, pi; --preview prints the files, config keys and host commands it would remove and changes nothing; --yes removes them. Only the user applies it, in their own terminal: from an agent session the CLI runs --preview and refuses the rest, handing over the command, and a host may also ask about or deny the agent's call.",
    ],
    load: () => import("./uninstall"),
  },
  withSubcommands(
    {
      name: "grant",
      group: "setup",
      summary:
        "Show or change a workspace's autonomy grants (push, pr, merge, release, rerun) and default endpoint; raising needs the user at a terminal",
      subcommands: [
        {
          name: "show",
          usage: "workit grant show [<workspace>] [--all]",
          summary: "Show the grants of the current (or named) workspace, or of every workspace",
        },
        {
          name: "set",
          usage:
            "workit grant set <workspace> <kind>=<true|false|verified>… [defaultEndpoint=commit|pr|green|merged] [verification=proportional|self|independent]",
          summary:
            "Change grants (kinds: push, pr, merge, release, rerun); raising one asks the user to confirm at a terminal",
        },
        {
          name: "unset",
          usage: "workit grant unset <workspace> <kind>…",
          summary: "Remove grants, falling back to the defaults",
        },
      ],
      examples: ["workit grant show", "workit grant set my-repo push=true pr=true"],
      load: () => import("./grant"),
    },
    { optional: true },
  ),
  {
    name: "approve",
    group: "setup",
    usage: "workit approve <id>…",
    summary: "Ask the user to approve a Workit request; their yes is recorded once",
    notes: [
      "Agent: run exactly `workit approve <id>…` as its own call; the host shows the user the request and records their answer (Claude Code, Pi). Elsewhere it prints the line for the user's own terminal.",
    ],
    examples: ["workit approve ap_7k2m9q4x"],
    load: () => import("./approve"),
  },
  withSubcommands({
    name: "config",
    group: "setup",
    summary: "Show the effective config here and where each value comes from",
    subcommands: [
      {
        name: "show",
        usage: "workit config show [--json]",
        summary:
          "Print the matched workspace, vcs provider and target branch, role models and heavy-check resources, each with its source",
      },
    ],
    examples: ["workit config show", "workit config show --json"],
    load: () => import("./config"),
  }),
  withSubcommands(
    {
      name: "workspace",
      group: "setup",
      summary:
        "Edit workspace entries without the wizard; a raise (rm too) needs the user at a terminal",
      subcommands: [
        {
          name: "list",
          usage: "workit workspace list",
          summary: "Show every entry and the one that applies to --cwd, and why",
        },
        {
          name: "add",
          usage: "workit workspace add <name> --glob <glob> [--from <parent>]",
          summary:
            "Add an entry; --from copies vcs, issues, branchPolicy, commitPolicy, trailers, youtrack and models, never grants",
        },
        {
          name: "set",
          usage:
            "workit workspace set <name> <key>=<value>…  |  workit workspace set --global <key>=<value>…",
          summary:
            "Change non-grant keys (dotted paths, JSON values, null removes); --global edits the top-level models key; grants stay with workit grant set",
        },
        {
          name: "rm",
          usage: "workit workspace rm <name>…",
          summary:
            "Remove one or more entries; if another entry or the defaults could grant their folders more, the user confirms once (y/N) at their own terminal",
        },
        {
          name: "seal",
          usage: "workit workspace seal",
          summary:
            "Accept the authority fields of workspaces.json (grants, endpoint, verification, youtrack.writes, globs, remotes, forge identity): shows what changed since the last seal, then y/N; the user's terminal only",
        },
      ],
      examples: [
        "workit workspace list",
        "workit workspace add kit --glob '/home/me/work/libs/kit/**' --from work",
        "workit workspace set kit branchPolicy.integration=merge",
        "workit workspace set --global models.roles.verifier.claude_code=sonnet",
        "workit workspace rm kit",
      ],
      notes: [
        "A new entry starts with no grants of its own. It starts at the strictest level of every entry and the defaults, so its folders never get more than they had. rm counts every other entry and the defaults as a possible taker of the removed folders: when any could grant more, it is refused in an agent or headless shell and the user answers a y/N at their own terminal (one confirmation for several names); it never removes the last entry. Raising a grant, defaultEndpoint or verification needs the user: workit grant set <name> <kind>=<value> in their own terminal.",
        "Every write keeps the previous file as workspaces.json.bak. `workit doctor` lists overlapping globs and which entry wins.",
        "The seal (workspaces.json.seal) holds the authority fields the user last accepted. While it is missing or does not match, each grant, the endpoint, verification and youtrack.writes are the stricter of the file and the last seal (the D4 defaults when there is none), and a changed forge identity blocks forge verbs. A write at the user's terminal reseals when the seal matched before; elsewhere only a write that lowers them reseals. Limit (D18): a process that forges the seal too passes it.",
      ],
      load: () => import("./workspace"),
    },
    { optional: true },
  ),
  ...TASK_FAMILY_NAMES.map(family),
  {
    name: "check",
    group: "delivery",
    usage:
      'workit check <name> [--full] [--task <id>] [--base <ref>] [--wait <dur> | --no-wait] [--no-lease --reason "<why>"] | workit check [--name <n>] [--shell] [--full] [--timeout <s>] [--task <id>] [--base <ref>] [--heavy | --io [--wait <dur> | --no-wait]] [--no-lease --reason "<why>"] -- <cmd…> | workit check [--list]',
    summary:
      "Run a configured or ad-hoc check and record CLI-observed evidence (exit: the command's); heavy checks wait for the machine-wide check lease",
    examples: [
      "workit check test",
      "workit check --heavy -- npx jest",
      "workit check test --wait 45m",
      "workit check --name unit -- bun test test/unit",
      'workit check test --no-lease --reason "machine is idle, debugging a hang"',
    ],
    notes: LEASE_NOTES,
    load: () => import("./check"),
  },
  {
    name: "run",
    group: "delivery",
    usage:
      'workit run --bg [--port <n>] [--name <n>] [--restart <id>] [--no-lease --reason "<why>"] -- <cmd…>',
    summary:
      "Start a dev server or docker compose up in the background, registered; prints its id, pid, port and log",
    examples: [
      "workit run --bg -- npm run dev",
      "workit run --bg --port 4200 -- ng serve",
      "workit run --bg --name api -- docker compose up",
      "workit run --bg --restart p1abc2def3",
    ],
    notes: [
      "One dev server per repo and --name (default `dev`): a second start in the same checkout prints the running one's id and port and starts nothing; from another checkout of the repo it fails naming that server's directory, branch and owner.",
      'The server\'s memory counts against the heavy-check budget. A start that does not fit, or comes while the machine is under critical pressure, is refused at once naming the holders; stop one (`workit stop <id>`) or pass --no-lease --reason "<why>" (recorded in the ledger).',
      "The port is --port, else the first localhost:<port> the log shows within 15 s. A command that exits within that bound prints its output and exit code and leaves nothing running.",
      "Past the RSS ceiling (the heavy scope's memoryMax) the owner session gets one notice naming `workit run --bg --restart <id>`. The session that started a process stops it at the end of its work: `workit stop <id>`.",
    ],
    load: () => import("./run"),
  },
  {
    name: "ps",
    group: "delivery",
    usage: "workit ps [--all]",
    summary:
      "List the registered background processes: id, pid, port, RSS, owner (--all adds ended ones)",
    examples: ["workit ps", "workit ps --all --json"],
    load: () => import("./ps"),
  },
  {
    name: "stop",
    group: "delivery",
    usage: 'workit stop <id>… | --session <s> | --within <dir> | --orphans [--reason "<why>"]',
    summary:
      "Stop registered background processes (the process group: SIGTERM, SIGKILL after 10 s), with a ledger row each",
    examples: [
      "workit stop p1abc2def3",
      'workit stop --within . --reason "work delivered"',
      "workit stop --orphans",
    ],
    notes: [
      "Naming an id stops that process even when it is kept or was started from a terminal; --session and --within skip those and say why. An agent stops only processes its own session (or its workers) started.",
      "--orphans stops processes whose owner's host process is gone or was replaced (never judged by age); one whose owner cannot be told is listed, never stopped. `workit gc --procs` shows the same list first.",
      "Before each signal the process's start time is checked: a pid another process took is never signalled. Processes Workit did not start are never touched.",
    ],
    load: () => import("./stop"),
  },
  withSubcommands({
    name: "lock",
    group: "delivery",
    summary:
      "The machine-wide heavy-check lease: who holds it, wait for it, run a command under it, and which shell commands count as heavy",
    subcommands: [
      {
        name: "status",
        usage: "workit lock status",
        summary:
          "Show each lease slot (free, held by check, pid, session, age, directory, or stale) and the queue of waiting checks in serving order (shortest measured run first, aged waiters ahead) with each one's own last measured run, marking stuck? holders",
      },
      {
        name: "reap",
        usage: "workit lock reap [<pid|session|dir>]",
        summary:
          "Free the slot of a stuck? holder (past resources.maxHold, default 15 min, or 5 min without output or CPU) and record it in the ledger; the process keeps running",
      },
      {
        name: "cancel",
        usage: "workit lock cancel [<pid|session|dir>]",
        summary:
          "Drop queued heavy checks (default: this session's); each exits 4 saying it was cancelled",
      },
      {
        name: "wait",
        usage: "workit lock wait [--timeout <dur>]",
        summary:
          "Wait until a lease slot is free, without taking it (exit 0 free, 4 still busy at the timeout)",
      },
      {
        name: "run",
        usage: "workit lock run [--shell] [--wait <dur> | --no-wait] [--timeout <s>] -- <cmd…>",
        summary: "Run a command under the lease: the same as workit check --heavy -- <cmd…>",
      },
      {
        name: "heavy",
        usage: "workit lock heavy list | add <pattern> | remove <pattern> | test -- <cmd…>",
        summary:
          "List, add or remove machine-wide heavy-command patterns (words matched as a prefix, * inside a word), or test whether the shell hook gates a command",
      },
    ],
    examples: [
      "workit lock status",
      "workit lock reap",
      "workit lock cancel",
      "workit lock wait --timeout 300",
      "workit lock run -- npx jest",
      "workit lock heavy add 'mvn verify'",
      "workit lock heavy test -- npm run test:ci",
    ],
    notes: LEASE_NOTES,
    load: () => import("./lock"),
  }),
  withSubcommands({
    name: "models",
    group: "delivery",
    summary:
      "The model and effort each role (decider, implementer tiers, verifier, reviewer, explore, babysit) runs on for a host, from models.roles, fanout.tierModels and the built-in defaults",
    subcommands: [
      {
        name: "show",
        usage:
          "workit models show [--role <role>] [--tier <mundane|standard|hard>] [--host <host>] [--report [--days <n>]] [--json]",
        summary:
          "Print the resolved model and effort per role for a host (default: the lead's host, else claude_code) and where each came from",
      },
    ],
    examples: [
      "workit models show --host claude_code --json",
      "workit models show --role verifier --host claude_code",
    ],
    load: () => import("./models"),
  }),
  withSubcommands({
    name: "pr",
    group: "delivery",
    subcommandGuesses: {
      comment:
        "workit pr reply --thread <id> --body-file - answers a review thread (workit pr threads lists them)",
    },
    summary:
      "PR/MR state with failing log tails and next action; open a SHA-verified PR; mark ready, edit, list and answer review threads; merge only when READY, verified and granted",
    subcommands: [
      {
        name: "status",
        usage: "workit pr status [--pr <n> | --branch <b>] [--log-lines 60]",
        summary: "PR/MR state, failing check log tails, the next action and the command for it",
      },
      {
        name: "create",
        flagHints: {
          head: "pr create opens the PR for the current branch: git switch <branch>, then workit pr create (--base sets the target)",
        },
        usage:
          'workit pr create [--base <b> | --track <t>] (--title <t ≤100 chars> [--body <text> | --body-file <f|->] | --fill) [<issue>… | --issue <#n|ID|url>…] [--refs] [--label|--add-label <l>]… [--reviewer|--add-reviewer <login>]… [--draft] [--changelog "<Section>: <entry>" | --no-changelog <reason>]',
        summary:
          "Open a PR/MR for the pushed branch, verified against the local HEAD, linking its issues (Closes; --refs links one slice of an umbrella issue without closing it); --changelog writes, commits and pushes the missing Unreleased entry first; refuses a body that leaves the PR template unfilled",
      },
      {
        name: "template",
        usage: "workit pr template",
        summary:
          "Print the PR description template to fill (the repo's GitHub/GitLab template, else Workit's; workspace prTemplate) and where it came from",
      },
      {
        name: "ready",
        usage: "workit pr ready [--pr <n>] [--undo]",
        summary: "Mark a draft PR/MR ready for review (--undo: back to draft)",
      },
      {
        name: "edit",
        usage:
          "workit pr edit [--pr <n>] [--title <t>] [--body-file <f|->] [--add-label <l>]… [--remove-label <l>]… [--add-reviewer <login>]… [--base <b>]",
        summary:
          "Change the title, body, labels, reviewers or base (the default target or the stack parent)",
      },
      {
        name: "threads",
        usage: "workit pr threads [--pr <n>]",
        summary: "List unresolved review threads with their ids",
      },
      {
        name: "reply",
        flagHints: {
          body: 'the text goes through --body-file; - reads stdin: echo "<text>" | workit pr reply --thread <id> --body-file -',
        },
        usage: "workit pr reply [--pr <n>] --thread <id> [--body-file <f|->] [--resolve]",
        summary: "Reply to an unresolved review thread and/or resolve it",
      },
      {
        name: "merge",
        usage:
          "workit pr merge [--pr <n>] [--squash|--merge|--rebase | --method squash|merge|rebase] [--subject <s>] [--body <b> | --body-file <f|->] [--delete-branch | --keep-branch] [--unverified --reason <why>] [--base-red-ok --reason <why>] [--others-pr --reason <why>] [--allow-failing <check>… --reason <why>]",
        summary:
          "Merge when READY, verified by a non-author and granted; --subject/--body set the squash message",
      },
    ],
    examples: [
      "workit pr template",
      'workit pr create --title "fix(cli): answer help flags first" --body-file pr.md',
      "workit pr merge --method squash --delete-branch",
    ],
    load: () => import("./pr"),
  }),
  withSubcommands({
    name: "issue",
    group: "delivery",
    summary:
      "Read, comment on, close or open a GitHub/GitLab issue on the workspace tracker (or --repo on the same host); writes need the pr grant and are recorded",
    subcommands: [
      {
        name: "view",
        usage: "workit issue view <n> [--repo <owner/name>]",
        summary: "Show an issue's state, title, labels and body",
      },
      {
        name: "comment",
        flagHints: {
          body: 'the text goes through --body-file; - reads stdin: echo "<text>" | workit issue comment <n> --body-file -',
        },
        usage: "workit issue comment <n> --body-file <f|-> [--repo <owner/name>]",
        summary: "Comment on an issue",
      },
      {
        name: "close",
        usage:
          "workit issue close <n> --reason completed|not-planned [--comment <text> | --comment-file <f|->] [--repo <owner/name>]",
        summary: "Close an issue with a reason, posting the comment first; verified after",
      },
      {
        name: "create",
        usage:
          "workit issue create --title <t> --body-file <f|-> [--label|--add-label <l>]… [--repo <owner/name>]",
        summary: "Open an issue (a behavioural rule or follow-up goes here, not to host memory)",
      },
    ],
    examples: [
      'workit issue close 321 --reason not-planned --comment "superseded by #330"',
      'workit issue create --title "fix(cli): …" --body-file - < body.md',
    ],
    load: () => import("./issue"),
  }),
  {
    name: "feedback",
    group: "delivery",
    usage:
      'workit feedback "<title>" --body-file <f|-> [--verb "<workit …>"] [--exit-file <f|->] [--include-workspace] [--post [--account <login>] [--comment <n>]]',
    summary:
      "Draft a report of Workit friction for the Workit tracker (redacted, with version, host, verb and exit text), suggest a duplicate, and post only with --post after the user's yes",
    notes: [
      "Redacted by default: remote URLs, absolute paths, the branch, ticket IDs and the workspace's org, repo and workspace names; --include-workspace keeps them. Without --post the draft is saved under `workit dir retros` and its path printed. --post uses --account or feedback.account in workspaces.json, never the workspace's own account by default; the hosts ask the user before it runs. A workspace with feedback: \"off\" refuses.",
    ],
    flagHints: {
      body: 'the text goes through --body-file; - reads stdin: echo "<repro>" | workit feedback "<title>" --body-file -',
      title: 'the title is the first argument: workit feedback "<title>" --body-file <f|->',
    },
    examples: [
      'workit feedback "pr status fails outside a checkout" --body-file - --verb "workit pr status" --exit-file err.txt < repro.md',
      'workit feedback "pr status fails outside a checkout" --body-file <saved draft> --post --account <login>',
    ],
    load: () => import("./feedback"),
  },
  withSubcommands({
    name: "ci",
    group: "delivery",
    summary:
      "Wait for CI on the PR head (exit 0/1/3/4), read the failing jobs' log tails, or rerun failed jobs once per head",
    subcommands: [
      {
        name: "wait",
        usage:
          "workit ci wait [--pr <n> | --branch <b> | --ref <b>] [--head <sha>] [--timeout 20m] [--interval 30s]",
        summary:
          "Wait for CI on the PR head, or on a branch's push runs when it has no PR (a trunk after a merge); exit 0 green, 1 red, 3 blocked, 4 still pending",
      },
      {
        name: "rerun",
        usage:
          "workit ci rerun [--pr <n> | --branch <b> | --ref <branch>] [--check <name>… | --failed] --reason flake|infra [--force]",
        summary:
          "Rerun failed jobs once per head, with a recorded reason: the PR's (--pr, --branch, default this branch's) or a branch's latest run (--ref, e.g. a red main)",
      },
      {
        name: "logs",
        usage: "workit ci logs --failed [--pr <n> | --branch <b>]",
        summary: "The failing checks of the PR head, each with its job log's last 60 lines",
      },
    ],
    examples: [
      "workit ci wait --timeout 30m",
      "workit ci wait --branch main",
      "workit ci logs --failed",
      "workit ci rerun --failed --reason flake",
      "workit ci rerun --ref main --failed --reason flake",
    ],
    load: () => import("./ci"),
  }),
  withSubcommands({
    name: "git",
    group: "delivery",
    subcommandGuesses: {
      merge:
        "workit git rebase brings the trunk into this branch; workit pr merge lands a PR (workit help git rebase)",
      restore:
        "workit git unstage <paths…> takes paths out of the index (git restore --staged); dropping working-tree edits is raw git restore <paths>",
    },
    subcommandGuessFor: {
      switch: switchGuess,
      checkout: switchGuess,
      pull: (rest) =>
        `workit git rebase brings the trunk's new commits into this branch (workit help git rebase)${gitRest(rest).includes("--ff-only") ? "; a fresh branch from the trunk is workit git branch <name>, which fetches the base first" : ""}`,
      status: readOnlyGuess("status", "status --short"),
      diff: readOnlyGuess("diff", "diff"),
      log: readOnlyGuess("log", "log --oneline -20"),
    },
    summary:
      "Policy-checked branch (--carry moves uncommitted changes onto it), hunk staging and commit (Workit-Session trailer); push with a lease and the tip verified",
    subcommands: [
      {
        name: "branch",
        usage:
          "workit git branch <name> | git branch --kind feature|bugfix|release|hotfix --slug <s>  [--base <b>] [--track <t>] [--carry]",
        summary:
          "Create and switch to a branch from the trunk, the git-flow route of its kind or a release track; --carry brings uncommitted changes along, still uncommitted (no stash)",
      },
      {
        name: "commit",
        usage:
          "workit git commit -m|--message <msg>… | -F|--file <file|-> [--trailer <key: value>]… [--amend [--no-edit]] [--allow-empty] [-a|--all | --staged | [--whole] [--] <paths…>]",
        summary:
          "Commit (or --amend) with a linted Conventional Commit message, the session trailer (unless the workspace sets trailers: false) and any --trailer; a path staged in part commits its staged hunks only (--whole for all of it), --staged commits exactly the index",
      },
      {
        name: "stage",
        aliases: ["add"],
        usage: "workit git stage --patch <file|-> | [--] <paths…>",
        summary:
          "Stage selected hunks without git add -p: apply a unified diff to the index only (checked first); or stage whole paths",
      },
      {
        name: "unstage",
        usage: "workit git unstage [--] <paths…>",
        summary: "Put paths back to HEAD in the index; the working tree keeps the changes",
      },
      {
        name: "push",
        deferredFlags: ["force"],
        usage:
          "workit git push [-u|--set-upstream] [--force-with-lease [--expect <sha>] [--overwrite-unintegrated]] [--release <main|develop|v-tag>[,…]]",
        summary:
          "Push the current branch and verify the remote tip (never a blind --force); --release finishes a git-flow release, and a pushed release tag gets its forge release with the release notes",
      },
      {
        name: "rebase",
        usage: "workit git rebase [<base> | --onto <base>]",
        summary:
          "Replay the current branch onto its freshly fetched base (the default base, or --onto); a conflict aborts and names the paths, a rewrite is recorded and prints the leased push",
      },
      {
        name: "hold",
        usage: 'workit git hold --why "<the user\'s words>" | --clear',
        summary:
          'Record the user\'s "not yet" for this branch: the Stop hook stops asking to push or open a PR until the next push or --clear (grants nothing)',
      },
      {
        name: "trailers",
        usage: "workit git trailers",
        summary:
          "Print on or off: whether commits in this workspace get the Workit-Session trailer",
      },
    ],
    examples: [
      "workit git branch --kind feature --slug help-everywhere",
      "workit git branch feature/next --base main --carry  # move the uncommitted change too",
      'workit git commit -m "fix(cli): answer help flags first" --all',
      'workit git commit -m "feat: x" --trailer "Co-Authored-By: Name <email>" --all',
      "workit git commit --amend --no-edit -- src/forgotten.ts",
      "workit git stage --patch hunks.patch  # a git diff trimmed to the hunks to commit",
      'workit git commit --staged -m "fix(a): one focused change"',
      "workit git push --set-upstream",
      "workit git rebase  # then: workit git push --force-with-lease",
    ],
    load: () => import("./git"),
  }),
  withSubcommands({
    name: "release",
    group: "delivery",
    summary:
      "git-flow releases without the git-flow binary: make a release locally, finish it (merge, tag, merge back, push, forge release), publish it, tag packages; tag-driven releases (goreleaser and similar): tag the green trunk",
    subcommands: [
      {
        name: "start",
        usage: "workit release start <version> [--hotfix] [--track <t>]",
        summary:
          "Cut release/<version> (hotfix/<version> from production) locally; never pushes it",
      },
      {
        name: "finish",
        usage: "workit release finish [<version>] [--track <t>] [--dry-run]",
        summary:
          "Merge into production, tag, merge back, delete the branch, push production, merge-back branches and the tag, publish the forge release with the release notes; resumes an interrupted finish",
      },
      {
        name: "publish",
        usage: "workit release publish [<version>]",
        summary: "Push the release branch (opt-in: others commit to it or CI runs on it)",
      },
      {
        name: "notes",
        usage:
          "workit release notes draft <version> [--reset] | notes show <version> | notes approve <version>  [--package <name>] [--track <t>] | notes edit <tag> --from-changelog",
        summary:
          "Draft the forge release notes (Highlights, Breaking changes, Changes, Full changelog) in .git/workit/release-notes/, show them, or approve them (the user only, at a terminal; releaseNotes: review); a release package's tag (pkg-a@0.1.0) or --package reads that package's changelog; edit puts a published release's changelog section at the top of its body (idempotent, release grant)",
      },
      {
        name: "package",
        usage: "workit release package <name> <version> [--at <ref>] [--latest] [--dry-run]",
        summary:
          "Tag a release package (workspace releasePackages) <namespace><version> on the workspace's release commit (default: the newest release tag on the remote production branch), push it under the release grant, publish its forge release from its changelog (not Latest unless --latest) and verify it",
      },
      {
        name: "tag",
        usage:
          "workit release tag <vX.Y.Z> [--at <ref>] [--wait [--timeout 30m] [--interval 30s]] [--dry-run]",
        summary:
          "Tag-driven release (goreleaser and similar): under the release grant, tag the fetched remote trunk (or --at a commit on it) once its CI is green, the tag is new and the changelog has the version's section; push it (remote tip verified) without moving a local branch; --wait first waits for pending CI on the trunk, then watches the release workflow and verifies the forge release",
      },
    ],
    examples: [
      "workit release start 1.4.0",
      'workit git commit -m "chore(release): 1.4.0" -- package.json CHANGELOG.md',
      "workit release notes draft 1.4.0",
      "workit release finish --dry-run",
      "workit release finish",
      "workit release package pkg-a 0.1.0 --dry-run",
      "workit release tag v1.4.0 --dry-run",
      "workit release notes edit v1.3.0 --from-changelog",
    ],
    load: () => import("./release"),
  }),
  withSubcommands(
    {
      name: "verify-delivery",
      group: "delivery",
      summary:
        "Observe that a push, PR head, merge or release really landed on the remote (exit 1 when not)",
      subcommands: (
        [
          ["push", "pushed", "the branch's remote tip is the local HEAD"],
          ["pr", null, "the PR head is the local HEAD"],
          ["merge", "merged", "the PR merged into its base"],
          ["release", "released", "the release tag and package exist"],
        ] as const
      ).map(([name, alias, what]) => ({
        name,
        ...(alias ? { aliases: [alias] } : {}),
        usage: `workit verify-delivery ${name} ${VERIFY_OPTIONS}`,
        summary: `Observe that ${what}`,
      })),
      examples: ["workit verify-delivery push", "workit verify-delivery merge --pr 42"],
      load: () => import("./verify-delivery"),
    },
    { optional: true },
  ),
  withSubcommands({
    name: "stack",
    group: "delivery",
    summary:
      "Plan, restack (lease push + retarget) and land a base-branch stack of PRs, root first",
    subcommands: [
      {
        name: "plan",
        usage: "workit stack plan [--name <n>] [--trunk <b> | --track <t>] [<bottom> … <top>]",
        summary: "Record the stack's branches, bottom first",
      },
      {
        name: "status",
        usage: "workit stack status [--name <n>]",
        summary: "Each stacked PR's base, head, CI and verdict",
      },
      {
        name: "sync",
        usage: "workit stack sync [--name <n>] [--local] [--dry-run] [--force <branch>]…",
        summary: "Restack onto the moved bases, lease-push and retarget the PRs",
      },
      {
        name: "restack",
        usage: "workit stack restack [--name <n>] [--dry-run] [--force <branch>]…",
        summary:
          "After a parent merged (squash too): sync, then delete the merged stack branches locally",
      },
      {
        name: "land",
        usage:
          "workit stack land [--name <n>] [--dry-run] [--max <n>] [--method squash|merge|rebase] [--unverified --reason <why>] [--base-red-ok --reason <why>] [--others-pr --reason <why>] [--allow-failing <check>… --reason <why>] [--timeout 20m] [--interval 30s]",
        summary:
          "Judge every PR first (any refusal lands nothing), then merge from the root, restacking the rest as each lands",
      },
    ],
    examples: ["workit stack plan feature/a feature/b feature/c", "workit stack land --dry-run"],
    load: () => import("./stack"),
  }),
  withSubcommands({
    name: "fanout",
    group: "delivery",
    summary:
      "Register parallel slices (complete briefs, disjoint scopes, shared-file owners), render each worker's brief with the standing orders, watch them (STUCK, PR, CI, verdict, landed, landing order), make and release slice worktrees, and gate fan-in: out-of-scope edits, trunk and sibling merge conflicts",
    subcommands: [
      {
        name: "plan",
        flagAliases: { fanout: "name" },
        usage:
          "workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--take-lead]",
        summary: "Register the slices of a plan file",
      },
      {
        name: "brief",
        flagAliases: { fanout: "name", plan: "name" },
        usage:
          "workit fanout brief <slice> [--mode new|resume] [--attempt <n>] [--host <h>] [--name <n>]",
        summary: "Render one worker's brief with the standing orders",
      },
      {
        name: "check",
        flagAliases: { fanout: "name", plan: "name" },
        usage: "workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline]",
        summary: "Gate fan-in: out-of-scope edits, trunk and sibling merge conflicts",
      },
      {
        name: "status",
        flagAliases: { fanout: "name", plan: "name" },
        usage: "workit fanout status [--name <n>] [--stuck-after 30m] [--offline]",
        summary: "Each slice's state: STUCK, PR, CI, verdict, landed, landing order",
      },
      {
        name: "worktree",
        flagAliases: { fanout: "name", plan: "name" },
        usage:
          "workit fanout worktree create|release <slice>… [--name <plan|plan.json>] [--branch <b>] [--base <b>] [--tier <t>] [--force]",
        summary:
          "Make slice worktrees and print each WORKTREE line and spawn (a plan file in --name is registered; --branch, --base and --tier make one unplanned slice), or release one (--force applies to release only)",
      },
    ],
    examples: [
      "workit fanout plan plan.json --take-lead",
      "workit fanout worktree create api ui --name plan.json",
      "workit fanout worktree create fix-login --branch fix/login",
      "workit fanout status --stuck-after 20m",
    ],
    load: () => import("./fanout"),
  }),
  withSubcommands({
    name: "ledger",
    group: "delivery",
    sharedParser: true,
    summary:
      "Record and query decisions, rulings, SHA-keyed verdicts (patch-id carry across rebases) and a fanout's standing orders",
    subcommands: [
      {
        name: "decision",
        usage: `workit ledger decision "<what>" --why "<why>" [--by decider [--view "<view>"]…] [--keep branch:<name>|worktree:<path>|proc:<id>]… [--ref <path|url>]… ${LEDGER_ACTOR}`,
        summary:
          "Record a decision and why; --by decider marks a tie-breaker agent's call (not the user's answer, not a verdict); --keep records the user's keep, which cleanup at the end of work leaves in place",
      },
      {
        name: "ruling",
        flagHints: {
          cost: 'the flag is --cost-if-wrong: workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>"',
        },
        usage: `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>" [--ref <path|url>]… ${LEDGER_ACTOR}`,
        summary: "Record a ruling on an open choice, with the cost of being wrong",
      },
      {
        name: "verdict",
        flagAliases: { sha: "head" },
        flagHints: {
          repo: "a verdict is recorded in the checkout you run it from: pass --cwd <dir> (workit ledger --cwd <dir> verdict …)",
        },
        usage: `workit ledger verdict <result> --how "<method/evidence>" [--head <sha>] [--kind unit|live|perf|review] [--base <ref>] [--surface ui|cli|api] [--evidence <ref>]… [--self] ${LEDGER_ACTOR} | ledger verdict [<branch>]`,
        summary:
          "Record a SHA-keyed verdict on the branch head (result: verified, tests-verified, type-check-only, blocked, failed), or show the current verdicts",
      },
      {
        name: "list",
        aliases: ["show"],
        usage:
          "workit ledger list|show [--branch <b>] [--pr <n>] [--type <t>] [--last|--limit <n>]",
        summary: "List ledger rows, newest last (findings live in the task: workit finding list)",
      },
      {
        name: "finding",
        usage:
          "workit ledger finding [record|list|resolve] [--payload <JSON|@file|->] [<workit finding flags>]",
        summary:
          "Runs workit finding <action> (record by default): findings live in the task store",
        // workit finding's own flags, checked by that verb.
        deferredFlags: [
          "task",
          "revision",
          "workspace-revision",
          "view",
          "actor",
          "confirm",
          "queue",
          "status",
          "branch",
        ],
      },
      {
        name: "check",
        usage: "workit ledger check [--pr <n> | --branch <b>]",
        summary: "Whether the branch head carries an accepted non-author verdict",
      },
      {
        name: "verify-integrity",
        usage: "workit ledger verify-integrity",
        summary:
          "Rows outside the CLI's hash chain (hand-written or changed); reports, never blocks",
      },
      {
        name: "void",
        usage: 'workit ledger void <verdict id|#n> --reason "<why>"',
        summary:
          "The user, at a terminal, voids a verdict that is wrong on its face (wrong repo or branch); gates stop counting it. Refused in an agent shell",
      },
      {
        name: "standing",
        flagAliases: { name: "fanout" },
        usage: `workit ledger standing add "<order>" | standing add --stop ["<note>"] | standing add --clear | standing list | standing clear [<id>]  [--fanout <name>] [--supersedes <id>] [--session <id> [--token <t>] | --as <role>]`,
        summary:
          "The lead's standing orders for a fanout's workers; running workers get each change on their next tool call, and --stop tells them to stop and report",
      },
      {
        name: "add",
        usage: 'workit ledger add decision|ruling|verdict "<what>" …',
        summary: "Same as the bare decision, ruling and verdict forms",
      },
    ],
    examples: [
      'workit ledger decision "keep the registry as the help source" --why "one place to update"',
      'workit ledger verdict verified --how "ran the CLI against a scratch repo" --kind live --as verifier',
    ],
    load: () => import("./ledger"),
  }),
  {
    name: "test-audit",
    group: "delivery",
    usage:
      "workit test-audit [paths…] [--diff [<base>]] [--rule <ids>] [--min-severity <level>] [--fail-on <level>] [--mutate [--test-cmd <cmd {files}>] [--max-mutants <n>] [--budget <s>] [--timeout <s>]]",
    summary:
      "Flag tautological and low-value tests with a suggested independent oracle; --mutate checks changed lines with diff-scoped mutation",
    load: () => import("./test-audit"),
  },
  withSubcommands({
    name: "deslop",
    group: "delivery",
    summary:
      "Classify the comments, suppressions and debug leftovers a branch adds, by review lane, with no agent",
    subcommands: [
      {
        name: "scan",
        usage: "workit deslop scan [--diff [<base>]] [--lane none|self|focused|full]",
        summary:
          "List each added comment as narration, marker, suppression, debug or allowed (the keep list), run test-audit on changed tests, and name the lane's passes; a marker or suppression raises self to focused",
      },
      {
        name: "result",
        usage:
          "workit deslop result --removed <n> [--reshapes <n>] [--open <n>] [--lane <lane>] [--base <b>]",
        summary:
          "Record the one result line of a finished deslop: deslop: lane <l>, -N lines, R reshapes, O open",
      },
    ],
    load: () => import("./deslop"),
  }),
  withSubcommands({
    name: "knowledge",
    group: "delivery",
    summary:
      "Lint agent knowledge files: AGENTS.md byte budget, broken local links, scaffold-only files, duplicated rules (exit 1 on findings)",
    subcommands: [
      {
        name: "lint",
        usage: "workit knowledge lint",
        summary: "Lint AGENTS.md and the knowledge files it links",
      },
    ],
    load: () => import("./knowledge"),
  }),
  withSubcommands({
    name: "youtrack",
    group: "delivery",
    summary: "YouTrack issues and time; writes ask first (unless writes: auto)",
    subcommands: [
      {
        name: "note",
        usage:
          "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] [--date auto|YYYY-MM-DD]",
        summary: "Post a comment, optionally logging time",
      },
      {
        name: "time",
        usage: "workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]",
        summary: "Log work time",
      },
      {
        name: "meeting",
        usage: "workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]",
        summary: "Log meeting time",
      },
      {
        name: "update",
        usage:
          "workit youtrack update <ISSUE> [--markdown <t> | --file <p>] [--attach <file>]... [--minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]] [--state <S>] [--command '<command>']",
        summary: "Comment (with attachments), log time and change state on one issue under one yes",
      },
      {
        name: "show",
        usage: "workit youtrack show <ISSUE>",
        summary: "Read an issue (summary, state, fields, comments) through ytrack",
      },
      {
        name: "create",
        usage:
          "workit youtrack create --project <P> --summary <s> [--description <t> | --file <p>] [--attach <file>]... [--command '<command>']",
        summary: "Create an issue, optionally attaching files and applying a command",
      },
    ],
    load: () => import("./youtrack"),
  }),
  withSubcommands({
    name: "changelog",
    group: "delivery",
    summary: "Add entries under the Unreleased section of the changelog",
    subcommands: [
      {
        name: "apply",
        usage:
          "workit changelog apply (--entries <JSON|@file|-> | --normalize-only) [--path CHANGELOG.md] [--preview]",
        summary:
          'Add entries (or only normalize the file); --entries takes {"Added":["…"],"Fixed":["…"]} or [{"category":"Fixed","text":"…"}]',
      },
      {
        name: "merge",
        usage: "workit changelog merge <base> <ours> <theirs>",
        summary: "Git merge driver: keep both sides' Unreleased entries",
      },
      {
        name: "driver",
        usage: "workit changelog driver install",
        summary: "Register the merge driver in .git/config and .gitattributes",
      },
    ],
    examples: [
      `workit changelog apply --entries '{"Fixed":["fanout plan names every valid tier"]}'`,
    ],
    load: () => import("./changelog"),
  }),
  {
    name: "handoff",
    group: "delivery",
    usage:
      "workit handoff [--note <t>] [--next <t>] [--record] [--last <n>] | workit handoff --task <id>",
    summary:
      "Print a resume brief (branch, HEAD, dirty state, verdict, rulings, next command); --task exports v1 task state",
    load: () => import("./handoff"),
  },
];

/**
 * Verbs agents type that live under another verb (W2.9): the guess, to the
 * unblock naming the command that does it. The router answers these before
 * the edit-distance suggestion, which would point `commit` or `switch` at an
 * unrelated verb.
 */
export const VERB_GUESSES: Readonly<Record<string, string>> = {
  commit: "did you mean workit git commit? (workit help git commit)",
  push: "did you mean workit git push? (workit help git push)",
  branch: "did you mean workit git branch? (workit help git branch)",
  switch:
    "workit git branch <name> creates a branch and switches to it; git switch <branch> moves to an existing one",
  checkout:
    "workit git branch <name> creates a branch and switches to it; git switch <branch> moves to an existing one",
  add: "did you mean workit git stage <paths…>? (workit help git stage)",
  stage: "did you mean workit git stage? (workit help git stage)",
  merge: "did you mean workit pr merge? (workit help pr merge)",
  verify: "did you mean workit verify-delivery? (workit help verify-delivery)",
  review:
    "the review skill (/workit:review) reviews a diff; workit ledger verdict <result> --how <evidence> records the verdict (workit help ledger verdict)",
  checks:
    "did you mean workit check <name>? (a name that is not configured lists the configured ones)",
};

const BY_NAME = new Map(VERBS.map((entry) => [entry.name, entry]));

export const findVerb = (name: string): VerbEntry | undefined => BY_NAME.get(name);

/** The subcommand `name` (or an alias of it) of `entry`. */
export const findSubcommand = (entry: VerbEntry, name: string): SubcommandEntry | undefined =>
  entry.subcommands?.find((sub) => sub.name === name || sub.aliases?.includes(name));
