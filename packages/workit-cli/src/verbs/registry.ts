// The verb table (design §2.0). Every verb is a lazily imported module that
// exports `run(argv, io): Promise<number>`, so `workit --version`/`help` load
// nothing but this file and the router, and no verb pays for ink/react.
//
// A verb registered ahead of its slice sets `planned` (kept out of
// `workit help`) and answers `not_implemented`; S12 implemented the last one.
import type { Verb } from "../output";

export type VerbGroup = "setup" | "task" | "delivery";

export type VerbEntry = {
  name: string;
  group: VerbGroup;
  usage: string;
  summary: string;
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

const family = (name: string): VerbEntry => ({
  name,
  group: "task",
  usage:
    name === "task"
      ? 'workit task status [--all] | task start "<objective>" | task note "<text>" [--next "<t>"] | task close [--outcome verified|limited|stopped] | task adopt <id> | task <action> --payload <JSON>'
      : name === "policy"
        ? "workit policy assess|preview --judge risk=trivial|normal|high behavior=yes|no product-choice=yes|no plan=yes|no [--ref <path>] | policy explain"
        : `workit ${name} <action> [options]`,
  summary:
    name === "task"
      ? "The current branch's task (created by its first note, check or recording; no ids needed), or the task family"
      : name === "policy"
        ? "Judge the branch's work; Workit derives its checks, verdicts, decision and plan gates"
        : `Inspect and control a Workit task (${name} family)`,
  load: async () => (await import("./family")).familyVerb(name),
});

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
    usage: "workit upgrade [--hosts=a,b|none] [--cli] [--preview | --apply --confirm] [--json]",
    summary: "Preview upgrades (--apply --confirm to apply)",
    load: () => import("./upgrade"),
  },
  {
    name: "launch",
    group: "setup",
    usage: "workit launch <host> [--auto-upgrade] [-- args]",
    summary: "Upgrade before host startup, then start the host",
    load: () => import("./launch"),
  },
  {
    name: "doctor",
    group: "setup",
    usage: "workit doctor [--json] [--fix-lock [--force [--yes]]]",
    summary: "Verify the offline installation health (--fix-lock clears a stale workit store lock)",
    load: () => import("./doctor"),
  },
  {
    name: "gc",
    group: "setup",
    usage: "workit gc [--dry-run] [--prune-recovery --yes] [--json]",
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
  {
    name: "grant",
    group: "setup",
    usage:
      "workit grant show [<workspace>] [--all] | grant set <workspace> <kind>=<true|false|verified>… | grant unset <workspace> <kind>…",
    summary:
      "Show or change a workspace's autonomy grants (push, pr, merge, release, rerun) and default endpoint; raising needs the user at a terminal",
    load: () => import("./grant"),
  },
  ...TASK_FAMILY_NAMES.map(family),
  {
    name: "check",
    group: "delivery",
    usage:
      "workit check <name> | workit check [--name <n>] [--shell] [--timeout <s>] [--task <id>] -- <cmd…>",
    summary:
      "Run a configured or ad-hoc check and record CLI-observed evidence (exit = the command's)",
    load: () => import("./check"),
  },
  {
    name: "pr",
    group: "delivery",
    usage:
      "workit pr status [--pr <n>] | pr create [--base <b> | --track <t>] (--title <t> | --fill) [--draft] | pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch]",
    summary:
      "PR/MR state with failing log tails and next action; open a SHA-verified PR; merge only when READY, verified and granted",
    load: () => import("./pr"),
  },
  {
    name: "ci",
    group: "delivery",
    usage:
      "workit ci wait [--pr <n>] [--head <sha>] [--timeout 20m] | ci rerun [--failed | --check <name>…] --reason flake|infra [--force]",
    summary: "Wait for CI on the PR head (exit 0/1/3/4), or rerun failed jobs once per head",
    load: () => import("./ci"),
  },
  {
    name: "git",
    group: "delivery",
    usage:
      "workit git branch <name> [--base <b>] [--track <t>] | git commit -m <msg> [--all | -- <paths…>] | git push [--set-upstream] [--force-with-lease]",
    summary:
      "Policy-checked branch and commit (Workit-Session trailer); push with a lease and a verified remote tip",
    load: () => import("./git"),
  },
  {
    name: "verify-delivery",
    group: "delivery",
    usage:
      "workit verify-delivery [push|pr|merge|release] [--pr <n> | --branch <b>] [--sha <s>] [--tag <t>] [--package <p>]",
    summary:
      "Observe that a push, PR head, merge or release really landed on the remote (exit 1 when not)",
    load: () => import("./verify-delivery"),
  },
  {
    name: "stack",
    group: "delivery",
    usage:
      "workit stack plan [<bottom> … <top>] | status | sync [--local] | land [--dry-run] [--max <n>] [--json]",
    summary:
      "Plan, restack (lease push + retarget) and land a base-branch stack of PRs, root first",
    load: () => import("./stack"),
  },
  {
    name: "ledger",
    group: "delivery",
    usage: "workit ledger decision|ruling|verdict|list|check ...",
    summary:
      "Record and query decisions, rulings and SHA-keyed verdicts (patch-id carry-over across rebases)",
    load: () => import("./ledger"),
  },
  {
    name: "test-audit",
    group: "delivery",
    usage:
      "workit test-audit [paths…] [--diff [base]] [--rule <ids>] [--min-severity <level>] [--fail-on <level>] [--mutate [--test-cmd <cmd {files}>] [--max-mutants <n>] [--budget <s>]] [--json]",
    summary:
      "Flag tautological and low-value tests with a suggested independent oracle; --mutate checks changed lines with diff-scoped mutation",
    load: () => import("./test-audit"),
  },
  {
    name: "youtrack",
    group: "delivery",
    usage:
      "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] | youtrack time|meeting <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]",
    summary: "Post a YouTrack comment or log work time (host permission, no grant)",
    load: () => import("./youtrack"),
  },
  {
    name: "changelog",
    group: "delivery",
    usage:
      "workit changelog apply (--entries <JSON|@file|-> | --normalize-only) [--path CHANGELOG.md] [--preview]",
    summary: "Add entries under the Unreleased section of the changelog",
    load: () => import("./changelog"),
  },
  {
    name: "handoff",
    group: "delivery",
    usage: "workit handoff [--note <t>] [--next <t>] [--record] | workit handoff --task <id>",
    summary:
      "Print a resume brief (branch, HEAD, dirty state, verdict, rulings, next command); --task exports v1 task state",
    load: () => import("./handoff"),
  },
];

const BY_NAME = new Map(VERBS.map((entry) => [entry.name, entry]));

export const findVerb = (name: string): VerbEntry | undefined => BY_NAME.get(name);
