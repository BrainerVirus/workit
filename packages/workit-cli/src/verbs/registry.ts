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
  finding: { record: "Record a finding", resolve: "Resolve a finding" },
  decision: { record: "Record a task decision", revoke: "Revoke a task decision" },
  worker: {
    assign: "Assign a worker to a task",
    report: "Report a worker's result",
    cancel: "Cancel a worker assignment",
  },
  state: { export: "Export a task's state (v1)", import: "Import an exported task state" },
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
    usage: `workit task start "<objective>" | task start ${FAMILY_OPTIONS}`,
    summary: "Start tracking the current branch's task (idempotent per branch)",
  },
  {
    name: "note",
    usage: 'workit task note [--next "<t>"] [--objective "<t>"] [--] "<text>"',
    summary: "Add a progress note to the current branch's task (creates it if needed)",
  },
  {
    name: "close",
    usage: `workit task close [--outcome verified|limited|stopped] [--summary "<t>"] [--confirm] | task close ${FAMILY_OPTIONS}`,
    summary: "Close the current branch's task, or a task by id",
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
    .map(([action, summary]) => ({
      name: action,
      usage:
        name === "policy" && action !== "explain"
          ? `workit policy ${action} ${POLICY_JUDGE} ${FAMILY_OPTIONS}`
          : `workit ${name} ${action} ${FAMILY_OPTIONS}`,
      summary,
    }));
  return [...implicit, ...grammar];
};

const family = (name: Family): VerbEntry =>
  withSubcommands({
    name,
    group: "task",
    summary:
      name === "task"
        ? "The current branch's task (created by its first note, check or recording; no ids needed), or the task family"
        : name === "policy"
          ? "Judge the branch's work; Workit derives its checks, verdicts, decision and plan gates"
          : `Inspect and control a Workit task (${name} family)`,
    subcommands: familySubcommands(name),
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

/** A verb with subcommands lists their names on its one-line usage. */
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

const VERIFY_OPTIONS =
  "[--expect pushed|pr|merged|released] [--pr <n> | --branch <b>] [--sha <sha>] [--tag <t>] [--package <name[@version]>]";

const LEDGER_ACTOR = "[--branch <b> | --pr <n>] [--supersedes <id>] [--session <id> | --as <role>]";

export const VERBS: readonly VerbEntry[] = [
  {
    name: "init",
    group: "setup",
    usage: "workit init",
    summary: "Run the interactive setup wizard",
    load: () => import("./init"),
  },
  {
    name: "upgrade",
    group: "setup",
    usage: "workit upgrade [--hosts=a,b|none] [--cli] [--preview | --apply --confirm]",
    summary: "Preview upgrades (--apply --confirm to apply)",
    load: () => import("./upgrade"),
  },
  {
    name: "launch",
    group: "setup",
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
    usage: "workit gc [--dry-run] [--prune-recovery --yes]",
    summary:
      "Compact long task event logs, drop unreferenced blobs and old check logs; report (or prune) 2.x recovery copies",
    load: () => import("./gc"),
  },
  {
    name: "uninstall",
    group: "setup",
    usage: "workit uninstall",
    summary: "Remove workit host registrations interactively (~/.config/workit is kept)",
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
            "workit grant set <workspace> <kind>=<true|false|verified>… [defaultEndpoint=commit|pr|green|merged] [verification=self|independent]",
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
  ...TASK_FAMILY_NAMES.map(family),
  {
    name: "check",
    group: "delivery",
    usage:
      "workit check <name> [--task <id>] [--base <ref>] | workit check [--name <n>] [--shell] [--timeout <s>] [--task <id>] [--base <ref>] -- <cmd…>",
    summary:
      "Run a configured or ad-hoc check and record CLI-observed evidence (exit = the command's)",
    examples: ["workit check test", "workit check --name unit -- bun test test/unit"],
    load: () => import("./check"),
  },
  withSubcommands({
    name: "pr",
    group: "delivery",
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
        usage:
          "workit pr create [--base <b> | --track <t>] (--title <t> [--body <text> | --body-file <f|->] | --fill) [--label <l>]… [--reviewer <login>]… [--draft]",
        summary: "Open a PR/MR for the pushed branch, verified against the local HEAD",
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
        usage: "workit pr reply [--pr <n>] --thread <id> [--body-file <f|->] [--resolve]",
        summary: "Reply to an unresolved review thread and/or resolve it",
      },
      {
        name: "merge",
        usage:
          "workit pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch] [--unverified --reason <why>]",
        summary: "Merge when READY, verified by a non-author and granted",
      },
    ],
    examples: [
      'workit pr create --title "fix(cli): answer help flags first" --body-file pr.md',
      "workit pr merge --method squash --delete-branch",
    ],
    load: () => import("./pr"),
  }),
  withSubcommands({
    name: "ci",
    group: "delivery",
    summary: "Wait for CI on the PR head (exit 0/1/3/4), or rerun failed jobs once per head",
    subcommands: [
      {
        name: "wait",
        usage:
          "workit ci wait [--pr <n> | --branch <b>] [--head <sha>] [--timeout 20m] [--interval 30s]",
        summary: "Wait for CI on the PR head; exit 0 green, 1 red, 3 blocked, 4 still pending",
      },
      {
        name: "rerun",
        usage:
          "workit ci rerun [--pr <n> | --branch <b>] [--check <name>… | --failed] --reason flake|infra [--force]",
        summary: "Rerun failed jobs once per head, with a recorded reason",
      },
    ],
    examples: ["workit ci wait --timeout 30m", "workit ci rerun --failed --reason flake"],
    load: () => import("./ci"),
  }),
  withSubcommands({
    name: "git",
    group: "delivery",
    summary:
      "Policy-checked branch and commit (Workit-Session trailer); push with a lease and a verified remote tip",
    subcommands: [
      {
        name: "branch",
        usage:
          "workit git branch <name> | git branch --kind feature|bugfix|hotfix --slug <s>  [--base <b>] [--track <t>] [--carry]",
        summary: "Create and switch to a branch from the trunk or a release track",
      },
      {
        name: "commit",
        usage:
          "workit git commit -m|--message <msg>… | -F|--file <file|-> [--amend [--no-edit]] [--allow-empty] [-a|--all | [--] <paths…>]",
        summary:
          "Commit (or --amend) with a linted Conventional Commit message and the session trailer",
      },
      {
        name: "push",
        usage:
          "workit git push [-u|--set-upstream] [--force-with-lease [--expect <sha>] [--overwrite-unintegrated]]",
        summary: "Push the current branch and verify the remote tip (never a blind --force)",
      },
    ],
    examples: [
      "workit git branch --kind feature --slug help-everywhere",
      'workit git commit -m "fix(cli): answer help flags first" --all',
      "workit git commit --amend --no-edit -- src/forgotten.ts",
      "workit git push --set-upstream",
    ],
    load: () => import("./git"),
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
        name: "land",
        usage:
          "workit stack land [--name <n>] [--dry-run] [--max <n>] [--method squash|merge|rebase] [--unverified --reason <why>] [--timeout 20m] [--interval 30s]",
        summary: "Merge the stack root first, restacking the rest as each lands",
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
        usage:
          "workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--take-lead]",
        summary: "Register the slices of a plan file",
      },
      {
        name: "brief",
        usage: "workit fanout brief <slice> [--mode new|resume] [--attempt <n>] [--name <n>]",
        summary: "Render one worker's brief with the standing orders",
      },
      {
        name: "check",
        usage: "workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline]",
        summary: "Gate fan-in: out-of-scope edits, trunk and sibling merge conflicts",
      },
      {
        name: "status",
        usage: "workit fanout status [--name <n>] [--stuck-after 30m] [--offline]",
        summary: "Each slice's state: STUCK, PR, CI, verdict, landed, landing order",
      },
      {
        name: "worktree",
        usage: "workit fanout worktree create|release <slice> [--name <n>] [--force]",
        summary: "Make or release a slice's worktree (--force applies to release only)",
      },
    ],
    examples: [
      "workit fanout plan plan.json --take-lead",
      "workit fanout status --stuck-after 20m",
    ],
    load: () => import("./fanout"),
  }),
  withSubcommands({
    name: "ledger",
    group: "delivery",
    summary:
      "Record and query decisions, rulings, SHA-keyed verdicts (patch-id carry-over across rebases) and a fanout's standing orders",
    subcommands: [
      {
        name: "decision",
        usage: `workit ledger decision "<what>" --why "<why>" [--ref <path|url>]… ${LEDGER_ACTOR}`,
        summary: "Record a decision and why",
      },
      {
        name: "ruling",
        usage: `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>" [--ref <path|url>]… ${LEDGER_ACTOR}`,
        summary: "Record a ruling on an open choice, with the cost of being wrong",
      },
      {
        name: "verdict",
        usage: `workit ledger verdict <result> --how "<method/evidence>" [--kind unit|live|perf|review] [--base <ref>] [--surface ui|cli|api] [--evidence <ref>]… [--self] ${LEDGER_ACTOR} | ledger verdict [<branch>]`,
        summary:
          "Record a SHA-keyed verdict on the branch head (result: verified, tests-verified, type-check-only, blocked, failed), or show the current verdicts",
      },
      {
        name: "list",
        aliases: ["show"],
        usage: "workit ledger list|show [--branch <b>] [--pr <n>] [--type <t>] [--last <n>]",
        summary: "List ledger rows, newest last",
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
        name: "standing",
        usage: `workit ledger standing add "<order>" | standing list | standing clear [<id>]  [--fanout <name>] [--supersedes <id>] [--session <id> | --as <role>]`,
        summary: "The lead's standing orders for a fanout's workers",
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
    summary: "Post a YouTrack comment or log work time (host permission, no grant)",
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
        summary: "Add entries (or only normalize the file)",
      },
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

const BY_NAME = new Map(VERBS.map((entry) => [entry.name, entry]));

export const findVerb = (name: string): VerbEntry | undefined => BY_NAME.get(name);

/** The subcommand `name` (or an alias of it) of `entry`. */
export const findSubcommand = (entry: VerbEntry, name: string): SubcommandEntry | undefined =>
  entry.subcommands?.find((sub) => sub.name === name || sub.aliases?.includes(name));
