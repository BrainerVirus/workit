// `workit uninstall`: with no flags, the interactive host picker (ink/react
// loaded lazily). `--hosts=<h,…>` removes Workit from those hosts only after
// showing the exact files, config keys and host commands: `--preview` only
// shows them, `--yes` is the consent for a script. Like `workit setup`, never
// from inside an agent session: the user runs it in their own terminal.
import { agentSessionVar } from "../admin/host-permissions";
import {
  applyUninstall,
  configKeptNote,
  planUninstall,
  uninstallKeyChanges,
  type UninstallPaths,
  type UninstallPlan,
} from "../admin/uninstall";
import { emit, fail, ok, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";
import { createStyle } from "../style";

const ALL_HOSTS = ["claude-code", "codex", "cursor", "opencode", "pi"];
const USAGE = "workit uninstall [--hosts=claude-code,codex,cursor,opencode,pi [--preview | --yes]]";

type Args = { hosts: string[]; preview: boolean; yes: boolean };

const parse = (argv: readonly string[]): Args | string => {
  let hosts: string[] | null = null;
  let preview = false;
  let yes = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--preview") preview = true;
    else if (arg === "--json") continue;
    else if (arg === "--hosts" || arg.startsWith("--hosts=")) {
      const value = arg === "--hosts" ? argv[++i] : arg.slice("--hosts=".length);
      hosts = (value ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const unknown = hosts.filter((h) => !ALL_HOSTS.includes(h));
      if (hosts.length === 0) return `--hosts needs a value; hosts: ${ALL_HOSTS.join(", ")}`;
      if (unknown.length > 0) return `unknown host ${unknown[0]}; hosts: ${ALL_HOSTS.join(", ")}`;
    } else return `unknown argument ${arg}`;
  }
  if (preview && yes) return "--preview and --yes cannot be combined";
  if (!hosts) return "--preview and --yes need --hosts=<h,…>";
  return { hosts, preview, yes };
};

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.every((arg) => arg === "--json")) {
    const agent = agentSessionVar(io.env);
    if (agent) return emit(io, agentRefusal(agent, "workit uninstall"));
    if (io.json)
      return emit(
        io,
        fail("invalid_input", "workit uninstall is interactive and has no --json output", {
          unblock: "run `workit uninstall` in a terminal without --json",
        }),
      );
    const { runUninstall } = await import("../index");
    await runUninstall();
    return 0;
  }
  const args = parse(argv);
  if (typeof args === "string") return emit(io, fail("invalid_input", args, { unblock: USAGE }));
  return uninstallHosts(args, io);
}

/** An agent never removes Workit: it hands the user the command for their own terminal. */
const agentRefusal = (agent: string, command: string) =>
  fail(
    "blocked",
    `an agent cannot run this (${agent} is set): hand the user \`${command}\` to run in their own terminal`,
    { unblock: command },
  );

async function uninstallHosts(args: Args, io: Io): Promise<number> {
  const paths: UninstallPaths = {
    env: io.env,
    cwd: io.cwd,
    ...(io.env.HOME ? { home: io.env.HOME } : {}),
  };
  const full = planUninstall(paths);
  const named = new Set<string>(args.hosts);
  const plan: UninstallPlan = { hosts: full.hosts.filter((h) => named.has(h.host)) };
  const actions = plan.hosts.flatMap((h) =>
    h.actions.map((action) => ({
      host: h.host,
      kind: action.kind,
      path: action.path,
      detail: action.detail,
      keys: uninstallKeyChanges(action, paths),
    })),
  );
  const say = io.json ? io.stderr : io.stdout;
  const style = createStyle({
    stream: io.json ? io.terminals?.stderr : io.terminals?.stdout,
    env: io.env,
  });
  for (const action of actions) {
    say(`${style.bold(action.host)} ${action.kind} ${style.path(action.path)}\n`);
    say(`  ${action.detail}\n`);
    for (const key of action.keys) say(`  ${style.warn("-")} ${key}\n`);
  }
  const kept = configKeptNote(io.env);
  const summary = { hosts: args.hosts, actions, kept };
  const command = `workit uninstall --hosts=${args.hosts.join(",")} --yes`;
  const agent = agentSessionVar(io.env);
  // An agent never gets an uninstall to run, even one with nothing to remove.
  if (agent && !args.preview) return emit(io, { ...agentRefusal(agent, command), data: summary });
  if (actions.length === 0)
    return emit(io, ok({ ...summary, removed: [] }), () => [
      `Workit is not installed on ${args.hosts.join(", ")}: nothing to remove.`,
    ]);
  say(`${kept}\n`);
  if (args.preview)
    return emit(
      io,
      ok({ ...summary, removed: [] }),
      () => `Preview: nothing changed. \`${command}\` removes it, run in your own terminal.`,
    );
  if (!args.yes) {
    if (process.stdin.isTTY !== true)
      return emit(
        io,
        fail("blocked", "removing Workit from these hosts needs your consent", {
          data: summary,
          unblock: `review the plan above, then run ${command} or run it in a terminal`,
        }),
      );
    const answer = await askOrCancel(io, () =>
      askLine(
        `${style.bold("Remove Workit as shown above?")} [y/N] `,
        io.json ? process.stderr : process.stdout,
      ),
    );
    if (answer === null) return cancelled(io);
    if (!/^y(es)?$/i.test(answer.trim()))
      return emit(io, ok({ ...summary, removed: [] }), () => "Nothing removed.");
  }
  const result = applyUninstall(plan, paths);
  const data = { ...summary, removed: result.entries };
  if (!result.ok)
    return emit(
      io,
      fail(
        "failed",
        result.entries
          .filter((e) => e.status === "failed")
          .map((e) => `${e.path}: ${e.detail ?? "failed"}`)
          .join("; "),
        { data },
      ),
    );
  return emit(io, ok(data), () => [
    ...result.entries.map(
      (e) =>
        `${e.status === "removed" ? style.ok(e.status) : e.status} ${style.path(e.path)}${e.detail ? ` (${e.detail})` : ""}`,
    ),
    "Restart the host sessions to unload Workit.",
  ]);
}
