// `workit setup`: write Workit's permission block into each host's own config
// (issue #297) after one consent that shows the exact diff. `--yes` is that
// consent for a script; `--dry-run` only shows the diff. Never from inside an
// agent session: the user runs it in their own terminal.
import {
  applyHostPermissions,
  permissionDiff,
  planHostPermissions,
} from "../admin/host-permissions";
import { userHome } from "@workit-dev/core/src/core/workit-paths.mjs";
import pkg from "../../package.json" with { type: "json" };
import { completionLines, installCompletion } from "../completion/install";
import { emit, fail, ok, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";
import { colorDiff, createStyle, type Style } from "../style";
import { type HostOutcome } from "../upgrade/shared";
import { offerFirstSeal } from "../upgrade/seal-offer";
import { type GrantDeps } from "./grant";
import { refreshYtrackSkill, workitHosts } from "../upgrade/ytrack-skill";

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

/** Test seams: the setup itself and the terminal the seal offer asks on. */
export type SetupVerbDeps = {
  setup?: (argv: string[], io: Io) => Promise<number>;
  terminal?: GrantDeps;
};

export async function run(argv: string[], io: Io, deps: SetupVerbDeps = {}): Promise<number> {
  const code = await (deps.setup ?? runSetup)(argv, io);
  // Existing users: the one-time seal offer at the user's own terminal (#819);
  // never for a script's --yes or a --dry-run.
  if (code === 0 && !argv.includes("--yes") && !argv.includes("--dry-run"))
    await offerFirstSeal(io, deps.terminal);
  return code;
}

async function runSetup(argv: string[], io: Io): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") return emit(io, fail("invalid_input", args, { unblock: USAGE }));
  const plan = planHostPermissions({
    hosts: args.hosts,
    shell: args.shell,
    env: io.env,
    ...(io.env.HOME ? { home: io.env.HOME } : {}),
  });
  const say = io.json ? io.stderr : io.stdout;
  // --json sends the diff to stderr for a person to read: color follows that stream.
  const style = createStyle({
    stream: io.json ? io.terminals?.stderr : io.terminals?.stdout,
    env: io.env,
  });
  for (const note of plan.notes) say(`${note}\n`);
  for (const blocked of plan.blocked) say(`${style.warn("blocked:")} ${blocked}\n`);
  for (const change of plan.changes) say(`${colorDiff(permissionDiff(change), style)}\n`);
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
        unblock:
          plan.unblock ?? `workit setup --hosts=${plan.changes.map((c) => c.host).join(",")}`,
      }),
    );
  // The completion script for $SHELL: user files only, never an rc file.
  const completion = () => installCompletion({ env: io.env, version: pkg.version });
  // With YouTrack in use, each selected host with Workit gets the ytrack skill.
  const skill = () => {
    const home = userHome(io.env);
    return refreshYtrackSkill({ hosts: workitHosts(args.hosts, home, io.env), home, env: io.env });
  };
  if (plan.changes.length === 0 && !args.dryRun) {
    const installed = completion();
    const ytrack = skill();
    return emit(
      io,
      ok({ ...summary, written: [], completion: installed, ...(ytrack ? { ytrack } : {}) }),
      () => [
        plan.blocked.length ? "Nothing written." : "Host permissions are up to date.",
        ...completionLines(installed, style),
        ...skillLines(ytrack, style),
      ],
    );
  }
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
        `${style.bold("Write Workit's permission block shown above?")} [y/N] `,
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
  const installed = completion();
  const ytrack = skill();
  const data = {
    ...summary,
    written: entries,
    completion: installed,
    ...(ytrack ? { ytrack } : {}),
  };
  if (failed.length)
    return emit(
      io,
      fail("failed", failed.map((e) => `${e.file}: ${e.detail ?? "failed"}`).join("; "), { data }),
    );
  return emit(io, ok(data), () => [
    ...entries.map((e) => `${style.ok("written")} ${style.path(e.file)}`),
    "Restart the host sessions to load the new permissions. `workit uninstall` removes them.",
    ...completionLines(installed, style),
    ...skillLines(ytrack, style),
  ]);
}

/** The ytrack skill's result, with the command to finish it by hand. */
const skillLines = (row: HostOutcome | null, style: Style): string[] =>
  row
    ? [
        `ytrack ${row.reason}`,
        ...(row.details ?? []).map((dir) => `  ${style.path(dir)}`),
        ...(row.fix ? [`  fix: ${style.command(row.fix)}`] : []),
      ]
    : [];
