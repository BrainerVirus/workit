// `workit git branch|commit|push` (design §2.1 S11). Flag parsing, the forge
// identity check and the grant seam; the rules live in core git/ops.ts.
//
//   workit git branch <name> | --kind feature|bugfix|hotfix --slug <s>  [--base <b>] [--carry]
//   workit git commit -m <msg> [--all | [--] <paths…>]
//   workit git push [--set-upstream] [--force-with-lease [--expect <sha>]]
import { requireGrant } from "@brainervirus/workit-core/src/autonomy";
import {
  executePush,
  gitBranch,
  gitCommit,
  pushPreflight,
  type BranchOutcome,
  type CommitOutcome,
  type PushOutcome,
} from "@brainervirus/workit-core/src/git/ops";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { connect, forgeFail, parseFlags, usage } from "./forge-common";

const BRANCH_USAGE =
  "workit git branch <name> | --kind feature|bugfix|hotfix --slug <s>  [--base <b>] [--carry] [--json]";
const COMMIT_USAGE = "workit git commit -m <msg> [--all | [--] <paths…>] [--json]";
const PUSH_USAGE =
  "workit git push [--set-upstream] [--force-with-lease [--expect <sha>]] [--json]";
const USAGE = "workit git branch|commit|push ... (workit help git)";

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "(none)");

async function branch(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { base: "value", kind: "value", slug: "value", carry: "boolean" });
  if (typeof flags === "string") return usage(io, flags, BRANCH_USAGE);
  const { kind, slug } = flags.values;
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, BRANCH_USAGE);
  if ((kind === undefined) !== (slug === undefined))
    return usage(io, "--kind and --slug go together", BRANCH_USAGE);
  if (kind !== undefined && !["feature", "bugfix", "hotfix"].includes(kind))
    return usage(io, "--kind must be feature, bugfix or hotfix", BRANCH_USAGE);
  if (kind !== undefined && flags.positionals.length)
    return usage(io, "pass a name or --kind/--slug, not both", BRANCH_USAGE);
  const name = kind !== undefined ? `${kind}/${slug}` : flags.positionals[0];
  if (!name) return usage(io, "missing branch name", BRANCH_USAGE);
  const result = gitBranch(io.cwd, {
    name,
    base: flags.values.base ?? null,
    carry: flags.booleans.has("carry"),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: BranchOutcome) => [
    `switched to new branch ${data.branch} from ${data.baseRef} (${short(data.baseSha)})${data.carried ? ", carrying uncommitted changes" : ""}`,
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

/** `-m` (repeatable, joined like git), `--all`/`-a`, paths positionally or after `--`. */
function parseCommit(
  argv: readonly string[],
): { messages: string[]; all: boolean; paths: string[] } | string {
  const out = { messages: [] as string[], all: false, paths: [] as string[] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      out.paths.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json") continue;
    if (arg === "-a" || arg === "--all") {
      out.all = true;
      continue;
    }
    if (arg === "-m" || arg === "--message") {
      const value = argv[++index];
      if (value === undefined) return `${arg} requires a message`;
      out.messages.push(value);
      continue;
    }
    if (arg.startsWith("--message=")) {
      out.messages.push(arg.slice("--message=".length));
      continue;
    }
    if (arg.startsWith("-m") && arg.length > 2) {
      out.messages.push(arg.slice(2));
      continue;
    }
    if (arg.startsWith("-")) return `unknown option ${arg}`;
    out.paths.push(arg);
  }
  return out;
}

async function commit(argv: string[], io: Io): Promise<number> {
  const parsed = parseCommit(argv);
  if (typeof parsed === "string") return usage(io, parsed, COMMIT_USAGE);
  if (!parsed.messages.length) return usage(io, "missing -m <msg>", COMMIT_USAGE);
  if (parsed.all && parsed.paths.length)
    return usage(io, "pass --all or paths, not both", COMMIT_USAGE);
  const result = gitCommit(io.cwd, {
    message: parsed.messages.join("\n\n"),
    all: parsed.all,
    paths: parsed.paths,
    actor: actorFromEnv(io.env),
    env: io.env,
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: CommitOutcome) => [
    `${data.branch} ${short(data.sha)} ${data.message.split("\n", 1)[0]} (${data.files.length} file${data.files.length === 1 ? "" : "s"})`,
    ...(data.leftDirty ? [`${data.leftDirty} change(s) left uncommitted`] : []),
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
    ...(data.session
      ? []
      : ["note: WORKIT_SESSION_ID is unset; this commit has no session author"]),
  ]);
}

async function push(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--force") || argv.includes("-f"))
    return usage(
      io,
      "workit never force-pushes blindly; use --force-with-lease (the lease is the tip workit last recorded)",
      PUSH_USAGE,
    );
  const normalized = argv.map((arg) => (arg === "-u" ? "--set-upstream" : arg));
  const flags = parseFlags(normalized, {
    "set-upstream": "boolean",
    "force-with-lease": "boolean",
    expect: "value",
  });
  if (typeof flags === "string") return usage(io, flags, PUSH_USAGE);
  if (flags.positionals.length)
    return usage(
      io,
      `unexpected argument ${flags.positionals[0]} (workit pushes the current branch)`,
      PUSH_USAGE,
    );
  const expect = flags.values.expect ?? null;
  if (expect !== null && !flags.booleans.has("force-with-lease"))
    return usage(io, "--expect only applies with --force-with-lease", PUSH_USAGE);
  if (expect !== null && !/^[0-9a-f]{40,64}$/u.test(expect))
    return usage(io, "--expect must be a full commit sha", PUSH_USAGE);

  const plan = pushPreflight(io.cwd);
  if (!plan.ok) return forgeFail(io, plan);
  // A forge remote: the credential must be the workspace account (S10); a
  // local path has no account to check.
  if (!plan.data.local) {
    const connected = connect(io, plan.data.branch);
    if (!connected.ok) return forgeFail(io, connected);
  }
  const grant = requireGrant(io.cwd, "push", { forge: !plan.data.local });
  if (!grant.allowed)
    return emit(
      io,
      fail("blocked", grant.error, { unblock: grant.unblock, data: { reason: grant.reason } }),
    );
  const result = executePush(io.cwd, plan.data, {
    forceWithLease: flags.booleans.has("force-with-lease"),
    expect,
    setUpstream: flags.booleans.has("set-upstream"),
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return forgeFail(io, result, { branch: plan.data.branch, sha: plan.data.sha });
  return emit(io, ok(result.data), (data: PushOutcome) => [
    data.pushed
      ? `pushed ${data.branch} ${short(data.previous)} -> ${short(data.sha)} to ${data.remote}${data.forced ? " (force-with-lease)" : ""}; remote tip verified`
      : `${data.remote}/${data.branch} is already at ${short(data.sha)}; remote tip verified`,
    ...(data.upstream ? [`upstream: ${data.remote}/${data.branch}`] : []),
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "branch") return branch(rest, io);
  if (sub === "commit") return commit(rest, io);
  if (sub === "push") return push(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown git subcommand "${sub}"` : "missing git subcommand",
    USAGE,
  );
}
