// `workit setup`: write Workit's permission block into each host's own config
// (issue #297) after one consent that shows the exact diff. `--yes` is that
// consent for a script; `--dry-run` only shows the diff. Never from inside an
// agent session: the user runs it in their own terminal.
import {
  applyHostPermissions,
  permissionDiff,
  planHostPermissions,
} from "../admin/host-permissions";
import { emit, fail, ok, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";

const ALL_HOSTS = ["claude-code", "codex", "cursor", "opencode", "pi"];
const USAGE =
  "workit setup [--hosts=claude-code,codex,cursor,opencode,pi] [--no-shell] [--dry-run | --yes]";

const parse = (
  argv: readonly string[],
): { hosts: string[]; yes: boolean; dryRun: boolean; shell: boolean } | string => {
  let hosts = ALL_HOSTS;
  let yes = false;
  let dryRun = false;
  let shell = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-shell") shell = false;
    else if (arg === "--json") continue;
    else if (arg === "--hosts" || arg.startsWith("--hosts=")) {
      const value = arg === "--hosts" ? argv[++i] : arg.slice("--hosts=".length);
      hosts = (value ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const unknown = hosts.filter((h) => !ALL_HOSTS.includes(h));
      if (hosts.length === 0 || unknown.length > 0)
        return `unknown host ${unknown[0] ?? "(none)"}; hosts: ${ALL_HOSTS.join(", ")}`;
    } else return `unknown argument ${arg}`;
  }
  if (yes && dryRun) return "--dry-run and --yes cannot be combined";
  return { hosts, yes, dryRun, shell };
};

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") return emit(io, fail("invalid_input", args, { unblock: USAGE }));
  const plan = planHostPermissions({
    hosts: args.hosts,
    shell: args.shell,
    env: io.env,
    ...(io.env.HOME ? { home: io.env.HOME } : {}),
  });
  const say = io.json ? io.stderr : io.stdout;
  for (const note of plan.notes) say(`${note}\n`);
  for (const blocked of plan.blocked) say(`blocked: ${blocked}\n`);
  for (const change of plan.changes) say(`${permissionDiff(change)}\n`);
  const summary = {
    changes: plan.changes.map((c) => ({ host: c.host, file: c.file })),
    notes: plan.notes,
    blocked: plan.blocked,
  };
  if (plan.refused)
    return emit(
      io,
      fail("blocked", plan.refused, {
        data: summary,
        unblock: `workit setup --hosts=${plan.changes.map((c) => c.host).join(",")}`,
      }),
    );
  if (plan.changes.length === 0)
    return emit(io, ok({ ...summary, written: [] }), () =>
      plan.blocked.length ? "Nothing written." : "Host permissions are up to date.",
    );
  if (args.dryRun)
    return emit(io, ok({ ...summary, written: [] }), () => "Dry run: nothing written.");
  if (!args.yes) {
    if (process.stdin.isTTY !== true)
      return emit(
        io,
        fail("blocked", "host permission changes need your consent", {
          data: summary,
          unblock: `review the diff above, then run ${USAGE.replace("[--dry-run | --yes]", "--yes")} or run it in a terminal`,
        }),
      );
    const answer = await askOrCancel(io, () =>
      askLine(
        "Write Workit's permission block shown above? [y/N] ",
        io.json ? process.stderr : process.stdout,
      ),
    );
    if (answer === null) return cancelled(io);
    if (!/^y(es)?$/i.test(answer.trim()))
      return emit(io, ok({ ...summary, written: [] }), () => "Nothing written.");
  }
  const entries = applyHostPermissions(plan, {
    env: io.env,
    ...(io.env.HOME ? { home: io.env.HOME } : {}),
  });
  const failed = entries.filter((e) => e.status === "failed");
  const data = { ...summary, written: entries };
  if (failed.length)
    return emit(
      io,
      fail("failed", failed.map((e) => `${e.file}: ${e.detail ?? "failed"}`).join("; "), { data }),
    );
  return emit(io, ok(data), () => [
    ...entries.map((e) => `written ${e.file}`),
    "Restart the host sessions to load the new permissions. `workit uninstall` removes them.",
  ]);
}
