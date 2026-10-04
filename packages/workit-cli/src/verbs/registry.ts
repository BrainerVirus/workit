// The verb table (design §2.0). Every verb is a lazily imported module that
// exports `run(argv, io): Promise<number>`, so `workit --version`/`help` load
// nothing but this file and the router, and no verb pays for ink/react.
//
// The S9b–S13 verbs were pre-registered against stub modules that answer
// `not_implemented`, and `planned` keeps them out of `workit help`. A later
// slice replaces its own verbs/<verb>.ts and deletes only its entry's
// `planned` line here.
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
  "writer",
  "state",
] as const;

const family = (name: string): VerbEntry => ({
  name,
  group: "task",
  usage: `workit ${name} <action> [options]`,
  summary: `Inspect and control a Workit task (${name} family)`,
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
    usage: "workit upgrade [--hosts=a,b|none] [--cli] [--apply --confirm] [--json]",
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
    summary:
      "Verify the offline installation health (--fix-lock clears a stale .workit metadata lock)",
    load: () => import("./doctor"),
  },
  {
    name: "gc",
    group: "setup",
    usage: "workit gc [--dry-run] [--json]",
    summary:
      "Prune .workit/recovery copies beyond the cap and dedupe stored candidates in paused tasks",
    load: () => import("./gc"),
  },
  {
    name: "uninstall",
    group: "setup",
    usage: "workit uninstall",
    summary: "Remove workit host registrations interactively (~/.config/workit is kept)",
    load: () => import("./uninstall"),
  },
  ...TASK_FAMILY_NAMES.map(family),
  {
    name: "action",
    group: "task",
    usage: "workit action <operation> --payload <JSON>",
    summary: "Preview or run one approved external action (--help lists payloads)",
    load: () => import("./action"),
  },
  {
    name: "check",
    group: "delivery",
    usage: "workit check <name> | workit check [--name <n>] -- <cmd…>",
    summary: "Run a configured or ad-hoc check and record CLI-observed evidence",
    planned: "S9b",
    load: () => import("./check"),
  },
  {
    name: "pr",
    group: "delivery",
    usage:
      "workit pr status [--pr <n>] | pr create [--base <b>] (--title <t> | --fill) [--draft] | pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch]",
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
      "workit git branch <name> [--base <b>] | git commit -m <msg> [--all | -- <paths…>] | git push [--set-upstream] [--force-with-lease]",
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
    usage: "workit stack plan|sync|land [--json]",
    summary: "Plan, restack and land a stack of PRs",
    planned: "S12",
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
