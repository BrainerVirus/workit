// `workit stack plan|status|sync|land` (design §2.1 S12). Flag parsing, the
// forge connection, the single-writer lock and rendering; the rules live in
// core stack.ts.
//
//   workit stack plan   [--name <n>] [--trunk <b> | --track <t>] [<bottom> … <top>]
//   workit stack status [--name <n>]
//   workit stack sync   [--name <n>] [--local] [--dry-run]
//   workit stack land   [--name <n>] [--dry-run] [--max <n>] [--method squash|merge|rebase]
//                       [--timeout 20m] [--interval 30s]
import type { MergeMethod } from "@brainervirus/workit-core/src/forge/types";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import {
  landStack,
  planStack,
  readStack,
  selectStack,
  stackStatus,
  syncStack,
  withStackLock,
  writeStack,
  type LandOutcome,
  type PlanOutcome,
  type StackError,
  type StackResult,
  type StatusOutcome,
  type SyncOutcome,
} from "@brainervirus/workit-core/src/stack";
import { vcsConfig } from "@brainervirus/workit-core/src/core/vcs-config";
import { emit, fail, ok, type Io } from "../output";
import {
  connect,
  forgeDeps,
  forgeFail,
  parseDuration,
  parseFlags,
  positiveInt,
  usage,
} from "./forge-common";

const PLAN_USAGE =
  "workit stack plan [--name <n>] [--trunk <b> | --track <t>] [<bottom> … <top>] [--json]";
const STATUS_USAGE = "workit stack status [--name <n>] [--json]";
const SYNC_USAGE =
  "workit stack sync [--name <n>] [--local] [--dry-run] [--force <branch>]… [--json]";
const LAND_USAGE =
  "workit stack land [--name <n>] [--dry-run] [--max <n>] [--method squash|merge|rebase] [--timeout 20m] [--interval 30s] [--json]";
const USAGE = "workit stack plan|status|sync|land ... (workit help stack)";

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : "?");

const stackFailed = (io: Io, result: StackError): number =>
  emit(io, fail(result.code, result.error, { unblock: result.unblock, data: result.data ?? {} }));

// The release track's PR target when tracks are configured (core vcsConfig).
const defaultTrunk = (io: Io, track: string | null): string | null => {
  const resolved = vcsConfig("resolve", io.cwd, { track });
  return resolved.ok === false ? null : String(resolved.defaultTargetBranch ?? "") || null;
};

const label = (forge: string | null, pr: number | null): string =>
  pr === null ? "no PR" : `${forge === "gitlab" ? "MR !" : "PR #"}${pr}`;

async function plan(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { name: "value", trunk: "value", track: "value" });
  if (typeof flags === "string") return usage(io, flags, PLAN_USAGE);
  const name = flags.values.name ?? null;
  const existingByName = name ? readStack(io.cwd, name) : null;
  if (existingByName && !existingByName.ok) return stackFailed(io, existingByName);
  let existing = existingByName?.ok ? existingByName.data : null;
  if (!name && flags.positionals.length === 0) {
    // Re-plan the stack the current branch is in, when there is one.
    const selected = selectStack(io.cwd, null);
    if (selected.ok) existing = selected.data;
  }
  const trunk =
    flags.values.trunk ?? existing?.trunk ?? defaultTrunk(io, flags.values.track ?? null) ?? "main";
  // PR lookups need the forge; planning itself does not (offline is fine).
  const connected = connect(io, flags.positionals[0] ?? null);
  const resolved = connected.ok ? connected.data : null;
  const planned = planStack(
    io.cwd,
    resolved,
    { name, trunk, branches: flags.positionals },
    existing,
  );
  if (!planned.ok) return stackFailed(io, planned);
  if (!connected.ok)
    planned.data.notes.push(
      `forge: ${connected.error}${connected.unblock ? ` (${connected.unblock})` : ""}`,
    );
  const result = await withStackLock(
    io.cwd,
    planned.data.stack.name,
    async (): Promise<StackResult<PlanOutcome>> => {
      const written = writeStack(io.cwd, planned.data.stack);
      return written.ok ? planned : written;
    },
  );
  if (!result.ok) return stackFailed(io, result);
  return emit(io, ok(result.data), (data: PlanOutcome) => [
    `${data.created ? "planned" : "re-planned"} stack ${data.stack.name} on ${data.stack.trunk}:`,
    ...data.stack.branches.map((entry, index) => {
      const check = data.checks.find((item) => item.branch === entry.branch);
      return `  ${index + 1}. ${entry.branch} <- ${entry.parent}  ${entry.merged ? "merged" : label(data.stack.forge, entry.pr)}${check && !check.onParent ? "  (not on its parent)" : ""}${check?.baseMatches === false ? `  (PR base ${check.prBase})` : ""}`;
    }),
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

async function status(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { name: "value" });
  if (typeof flags === "string") return usage(io, flags, STATUS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, STATUS_USAGE);
  const selected = selectStack(io.cwd, flags.values.name ?? null);
  if (!selected.ok) return stackFailed(io, selected);
  const connected = connect(io, selected.data.branches[0]?.branch ?? null);
  if (!connected.ok) return forgeFail(io, connected);
  const result = stackStatus(
    { cwd: io.cwd, resolved: connected.data, actor: actorFromEnv(io.env), sleep: forgeDeps.sleep },
    selected.data,
  );
  if (!result.ok) return stackFailed(io, result);
  return emit(io, ok(result.data), (data: StatusOutcome) => [
    `stack ${data.name} on ${data.trunk}: ${data.verdict}${data.reason ? ` (${data.reason})` : ""}`,
    ...data.branches.map(
      (row, index) =>
        `  ${index + 1}. ${row.branch} ${label(connected.data.forge.kind, row.pr)} ${
          row.merged
            ? "merged"
            : `${row.next ?? "?"} · checks ${row.checks ?? "?"} · verdict ${row.verdict.accepted ? `accepted (${row.verdict.basis})` : `missing (${row.verdict.reasons.join(", ") || row.verdict.basis})`} · ${row.onParent === false ? `not on ${row.parent}` : `on ${row.parent}`}${row.baseMatches === false ? ` · PR base ${row.prBase}` : ""}`
        }`,
    ),
    ...(data.next ? [`next: ${data.next}`] : []),
  ]);
}

const renderSync = (data: SyncOutcome): string[] => [
  `${data.dryRun ? "would sync" : "synced"} stack ${data.name}${data.merged.length ? `; merged: ${data.merged.map((item) => item.branch).join(", ")}` : ""}`,
  ...data.steps.map((step) =>
    [
      `  ${step.branch} on ${step.parent}:`,
      step.restack
        ? `restacked ${short(step.restack.from)} -> ${short(step.restack.onto)}${step.restack.head ? ` = ${short(step.restack.head)}` : ""}${step.restack.carried === true ? " (same change; verdict carries)" : step.restack.carried === false ? " (change differs; verdict stale)" : ""}`
        : "up to date",
      step.push
        ? step.push.pushed
          ? `pushed${step.push.forced ? " (lease)" : ""}`
          : "remote current"
        : "",
      step.retarget ? `retargeted ${step.retarget.from} -> ${step.retarget.to}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  ),
];

async function sync(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    name: "value",
    local: "boolean",
    "dry-run": "boolean",
    force: "list",
  });
  if (typeof flags === "string") return usage(io, flags, SYNC_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, SYNC_USAGE);
  const selected = selectStack(io.cwd, flags.values.name ?? null);
  if (!selected.ok) return stackFailed(io, selected);
  // --force names the branch whose changed restack may be pushed; never all.
  const force = new Set(flags.lists.force ?? []);
  const unknown = [...force].filter(
    (branch) => !selected.data.branches.some((entry) => entry.branch === branch),
  );
  if (unknown.length)
    return usage(
      io,
      `--force ${unknown[0]}: not a branch of stack ${selected.data.name}`,
      SYNC_USAGE,
    );
  const local = flags.booleans.has("local");
  let ctx = null;
  if (!local) {
    const connected = connect(io, selected.data.branches[0]?.branch ?? null);
    if (!connected.ok) return forgeFail(io, connected);
    ctx = {
      cwd: io.cwd,
      resolved: connected.data,
      actor: actorFromEnv(io.env),
      sleep: forgeDeps.sleep,
    };
  }
  const name = selected.data.name;
  const result = await withStackLock(io.cwd, name, async () => {
    // Re-read under the lock: another writer may have just changed it.
    const fresh = readStack(io.cwd, name);
    if (!fresh.ok) return fresh;
    return syncStack(
      io.cwd,
      ctx,
      fresh.data ?? selected.data,
      {
        publish: !local,
        dryRun: flags.booleans.has("dry-run"),
        force,
      },
      actorFromEnv(io.env),
    );
  });
  if (!result.ok) return stackFailed(io, result);
  return emit(io, ok(result.data), renderSync);
}

const METHODS: ReadonlySet<string> = new Set<MergeMethod>(["squash", "merge", "rebase"]);

async function land(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    name: "value",
    "dry-run": "boolean",
    max: "value",
    method: "value",
    timeout: "value",
    interval: "value",
  });
  if (typeof flags === "string") return usage(io, flags, LAND_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, LAND_USAGE);
  const max = positiveInt(flags.values.max, "--max");
  if (typeof max === "string") return usage(io, max, LAND_USAGE);
  const method = (flags.values.method ?? "squash") as MergeMethod;
  if (!METHODS.has(method))
    return usage(io, "--method must be squash, merge or rebase", LAND_USAGE);
  const timeoutMs = parseDuration(flags.values.timeout ?? "20m");
  const intervalMs = parseDuration(flags.values.interval ?? "30s");
  if (timeoutMs === null || timeoutMs > 6 * 3_600_000)
    return usage(io, "--timeout must be a duration up to 6h (20m, 90s)", LAND_USAGE);
  if (intervalMs === null || intervalMs < 1000 || intervalMs > 600_000)
    return usage(io, "--interval must be between 1s and 10m", LAND_USAGE);
  const selected = selectStack(io.cwd, flags.values.name ?? null);
  if (!selected.ok) return stackFailed(io, selected);
  const connected = connect(io, selected.data.branches[0]?.branch ?? null);
  if (!connected.ok) return forgeFail(io, connected);
  const name = selected.data.name;
  const result = await withStackLock(io.cwd, name, async () => {
    const fresh = readStack(io.cwd, name);
    if (!fresh.ok) return fresh;
    return landStack(
      {
        cwd: io.cwd,
        resolved: connected.data,
        actor: actorFromEnv(io.env),
        sleep: forgeDeps.sleep,
      },
      fresh.data ?? selected.data,
      { dryRun: flags.booleans.has("dry-run"), max, method, timeoutMs, intervalMs },
    );
  });
  if (!result.ok) return stackFailed(io, result);
  const kind = connected.data.forge.kind;
  return emit(io, ok(result.data), (data: LandOutcome) =>
    [
      ...(data.dryRun
        ? [
            data.wouldLand.length
              ? `would land: ${data.wouldLand.map((item) => `${label(kind, item.pr)} (${item.branch})`).join(", ")}`
              : "would land nothing",
          ]
        : [
            data.landed.length
              ? `landed: ${data.landed.map((item) => `${label(kind, item.pr)} (${item.branch}) -> ${short(item.mergeSha)}`).join(", ")}`
              : "landed nothing",
          ]),
      ...(data.retargeted.length
        ? [`retargeted: ${data.retargeted.map((pr) => label(kind, pr)).join(", ")}`]
        : []),
      ...(data.restacked.length ? [`restacked: ${data.restacked.join(", ")}`] : []),
      data.stoppedAt
        ? `stopped at ${label(kind, data.stoppedAt.pr)} (${data.stoppedAt.branch}): ${data.stoppedAt.reason}${data.stoppedAt.ready ? " (verified, ready)" : ""} - ${data.stoppedAt.detail}\n  unblock: ${data.stoppedAt.unblock}`
        : data.complete
          ? "stack complete"
          : "",
    ].filter(Boolean),
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  // `--json` is global; it may come before the subcommand.
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json");
  if (sub === "plan") return plan(rest, io);
  if (sub === "status") return status(rest, io);
  if (sub === "sync") return sync(rest, io);
  if (sub === "land") return land(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown stack subcommand "${sub}"` : "missing stack subcommand",
    USAGE,
  );
}
