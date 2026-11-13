// `workit install --hosts=<h,…> [--preview | --yes]` (#423): install or repair
// Workit's plugin on the named hosts only, after showing the exact files,
// config keys, host commands and notes. A healthy host plans nothing, so a
// second run changes nothing. It never writes the Workit config, a workspace
// or another host. Like `workit uninstall`, never from inside an agent
// session: the user runs it in their own terminal.
import { configDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import { type HostId } from "../admin/host-install";
import { agentSessionVar } from "../admin/host-permissions";
import { applySetupPreview, planHostOnlyInstall, type HostOnlyInstallPlan } from "../admin/setup";
import { emit, fail, ok, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";
import { createStyle } from "../style";

const ALL_HOSTS: readonly HostId[] = ["claude-code", "codex", "cursor", "opencode", "pi"];
const USAGE = "workit install --hosts=claude-code,codex,cursor,opencode,pi [--preview | --yes]";

type Args = { hosts: HostId[]; preview: boolean; yes: boolean };
type PlanOptions = { env: NodeJS.ProcessEnv; cwd: string; dir: string; home?: string };

const isHost = (value: string): value is HostId => (ALL_HOSTS as readonly string[]).includes(value);

const parse = (argv: readonly string[]): Args | string => {
  // Repeated --hosts merge; a duplicate keeps its first place.
  let hosts: Set<HostId> | null = null;
  let preview = false;
  let yes = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--preview") preview = true;
    else if (arg === "--json") continue;
    else if (arg === "--hosts" || arg.startsWith("--hosts=")) {
      const value = arg === "--hosts" ? argv[++i] : arg.slice("--hosts=".length);
      const named = (value ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const unknown = named.find((h) => !isHost(h));
      if (named.length === 0) return `--hosts needs a value; hosts: ${ALL_HOSTS.join(", ")}`;
      if (unknown) return `unknown host ${unknown}; hosts: ${ALL_HOSTS.join(", ")}`;
      hosts = new Set([...(hosts ?? []), ...named.filter(isHost)]);
    } else return `unknown argument ${arg}`;
  }
  if (preview && yes) return "--preview and --yes cannot be combined";
  if (!hosts) return `--hosts=<h,…> names the hosts to install; hosts: ${ALL_HOSTS.join(", ")}`;
  return { hosts: [...hosts], preview, yes };
};

/** A host the plan cannot install: the preview and the apply print this same row. */
const blockedRow = (host: string, reason: string): string => `${host} blocked: ${reason}`;

const describe = (plan: HostOnlyInstallPlan) => ({
  host: plan.host,
  files: plan.diff.files,
  keys: plan.diff.keys,
  commands: plan.diff.commands,
  notes: plan.notes,
  blocked: plan.preview.blocked,
});

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") return emit(io, fail("invalid_input", args, { unblock: USAGE }));
  const command = `workit install --hosts=${args.hosts.join(",")} --yes`;
  const agent = agentSessionVar(io.env);
  // An agent never gets an install to run: hand the user the command before any plan.
  if (agent && !args.preview) {
    const refusal = fail(
      "blocked",
      `an agent cannot run this (${agent} is set): hand the user \`${command}\` to run in their own terminal`,
      { unblock: command },
    );
    if (io.json) return emit(io, refusal);
    io.stderr(`workit: ${refusal.error}\n`);
    return 3;
  }
  // Plan and apply resolve paths from the same options (setup's AR-09 guard).
  const options: PlanOptions = {
    env: io.env,
    cwd: io.cwd,
    dir: configDir(io.env),
    ...(io.env.HOME ? { home: io.env.HOME } : {}),
  };
  const plans = args.hosts.map((host) => planHostOnlyInstall(host, options));
  const say = io.json ? io.stderr : io.stdout;
  const style = createStyle({
    stream: io.json ? io.terminals?.stderr : io.terminals?.stdout,
    env: io.env,
  });
  for (const plan of plans) {
    const host = style.bold(plan.host);
    for (const reason of plan.preview.blocked)
      say(`${style.warn(blockedRow(plan.host, reason))}\n`);
    for (const file of plan.diff.files) say(`${host} write ${style.path(file)}\n`);
    for (const key of plan.diff.keys) say(`  ${style.ok("+")} ${key}\n`);
    for (const line of plan.diff.commands) say(`${host} run ${line}\n`);
    for (const note of plan.notes) say(`${host} note: ${note}\n`);
  }
  const summary = { hosts: plans.map(describe) };
  const pending = plans.filter((plan) => plan.preview.ok && plan.preview.mutations.length > 0);
  const blocked = plans.filter((plan) => !plan.preview.ok);
  if (pending.length === 0 && blocked.length === 0)
    return emit(io, ok({ ...summary, installed: [] }), () => [
      `Workit is already installed on ${args.hosts.join(", ")}: nothing to change.`,
    ]);
  if (args.preview)
    return emit(io, ok({ ...summary, installed: [] }), () =>
      pending.length > 0
        ? `Preview: nothing changed. \`${command}\` installs it, run in your own terminal.`
        : `Preview: nothing changed. \`${command}\` would install nothing: each blocked row above says why.`,
    );
  if (!args.yes) {
    if (process.stdin.isTTY !== true)
      return emit(
        io,
        fail("blocked", "installing Workit on these hosts needs your consent", {
          data: summary,
          unblock: `review the plan above, then run ${command} or run it in a terminal`,
        }),
      );
    const answer = await askOrCancel(io, () =>
      askLine(
        `${style.bold("Install Workit as shown above?")} [y/N] `,
        io.json ? process.stderr : process.stdout,
      ),
    );
    if (answer === null) return cancelled(io);
    if (!/^y(es)?$/i.test(answer.trim()))
      return emit(io, ok({ ...summary, installed: [] }), () => "Nothing installed.");
  }
  return applyPlans(plans, options, io, style);
}

type HostResult = { host: HostId; status: "installed" | "current" | "failed"; detail: string };

async function applyPlans(
  plans: HostOnlyInstallPlan[],
  options: PlanOptions,
  io: Io,
  style: ReturnType<typeof createStyle>,
): Promise<number> {
  const results: HostResult[] = [];
  const lines: string[] = [];
  for (const plan of plans) {
    const { host } = plan;
    if (!plan.preview.ok) {
      // Nothing of a blocked host runs: its row is the preview's, and no later step reads as done.
      const reason = plan.preview.blocked.join("; ");
      lines.push(`${style.warn("failed")} ${blockedRow(host, reason)}`);
      results.push({ host, status: "failed", detail: reason });
      continue;
    }
    if (plan.preview.mutations.length === 0) {
      lines.push(`${host} already installed: nothing to change`);
      results.push({ host, status: "current", detail: "nothing to change" });
      continue;
    }
    const applied = applySetupPreview(plan.preview, options);
    for (const entry of applied.entries)
      lines.push(
        `${entry.status === "Failed" ? style.warn(entry.status) : style.ok(entry.status)} ${style.path(entry.file)}${entry.detail ? ` (${entry.detail.split("\n")[0]})` : ""}`,
      );
    const failures = applied.entries
      .filter((entry) => entry.status === "Failed")
      .map((entry) => `${entry.file}: ${entry.detail?.split("\n")[0] ?? "failed"}`);
    if (failures.length > 0) {
      results.push({ host, status: "failed", detail: failures.join("; ") });
      continue;
    }
    // Prove the install: a second plan for the host is empty.
    const left = planHostOnlyInstall(host, options);
    const needs = [...left.diff.files, ...left.diff.commands, ...left.preview.blocked];
    if (needs.length === 0) {
      results.push({ host, status: "installed", detail: "installed" });
      continue;
    }
    const detail = `the install ran, but ${host} still needs: ${needs.join("; ")}`;
    lines.push(`${style.warn("failed")} ${detail}`);
    results.push({ host, status: "failed", detail });
  }
  const data = { hosts: plans.map(describe), results };
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    if (!io.json) for (const line of lines) io.stdout(`${line}\n`);
    return emit(
      io,
      fail("failed", failed.map((result) => `${result.host}: ${result.detail}`).join("; "), {
        data,
        unblock: `fix what failed above, then run workit install --hosts=${failed.map((result) => result.host).join(",")} --yes`,
      }),
    );
  }
  const installed = results.filter((result) => result.status === "installed");
  return emit(io, ok(data), () => [
    ...lines,
    `Installed Workit on ${installed.map((result) => result.host).join(", ")}. Restart the host sessions to load it.`,
  ]);
}
