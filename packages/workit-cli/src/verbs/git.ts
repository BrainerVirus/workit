// `workit git branch|commit|push` (design §2.1 S11). Flag parsing, the forge
// identity check and the grant seam; the rules live in core git/ops.ts.
//
//   workit git branch <name> | --kind feature|bugfix|release|hotfix --slug <s>  [--base <b>] [--track <t>] [--carry]
//   workit git commit (-m <msg> | -F <file|->) [--trailer "K: v"]… [--amend [--no-edit]] [--allow-empty] [--all | [--] <paths…>]
//   workit git trailers  (prints on|off: whether this workspace writes Workit-Session trailers)
//   workit git push [--set-upstream] [--force-with-lease [--expect <sha>]]
//   workit git push --release <main|develop|v-tag>…  (repeatable)
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireGrant } from "@brainervirus/workit-core/src/autonomy";
import {
  allowedKinds,
  BRANCH_KINDS,
  branchPolicySnapshotFor,
  suggestBranchName,
  type BranchKind,
} from "@brainervirus/workit-core/src/core/branch";
import {
  executePush,
  executeReleasePush,
  gitBranch,
  gitCommit,
  pushPreflight,
  releasePushPreflight,
  type BranchOutcome,
  type CommitOutcome,
  type ReleasePushOutcome,
} from "@brainervirus/workit-core/src/git/ops";
import { workspaceTrailers } from "@brainervirus/workit-core/src/core/workspaces";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { ensureImplicitTask } from "./implicit-task";
import { emit, fail, ok, type Io } from "../output";
import { forgeFail, parseFlags, pushIdentity, usage } from "./forge-common";

const BRANCH_USAGE =
  "workit git branch <name> | --kind feature|bugfix|release|hotfix --slug <s>  [--base <b>] [--track <t>] [--carry] [--json]";
const COMMIT_USAGE =
  "workit git commit -m|--message <msg>… | -F|--file <file|-> [--trailer <key: value>]… [--amend [--no-edit]] [--allow-empty] [-a|--all | [--] <paths…>] [--json]";
const PUSH_USAGE =
  "workit git push [--set-upstream] [--force-with-lease [--expect <sha>] [--overwrite-unintegrated]] [--release <main|develop|v-tag>[,…]] [--json]";
const USAGE = "workit git branch|commit|push|trailers ... (workit help git)";

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "(none)");

/**
 * The closest kind this workspace's policy allows (`chore` -> feature in
 * git-flow), or, when the policy names kinds `--kind` cannot spell (a custom
 * `task/*`) or none (github-flow), the name to pass instead.
 */
function kindHint(cwd: string, kind: string): string {
  let kinds: string[] = [...BRANCH_KINDS];
  try {
    kinds = allowedKinds(branchPolicySnapshotFor(cwd).namePolicy.allowed);
  } catch {}
  const spellable = kinds.filter((name) => (BRANCH_KINDS as readonly string[]).includes(name));
  if (spellable.length)
    return `did you mean --kind ${suggestBranchName(`${kind}/x`, spellable)?.split("/")[0]}?`;
  const named = suggestBranchName(`${kind}/<slug>`, kinds);
  return named
    ? `this workspace allows ${kinds.map((name) => `${name}/`).join(", ")}: pass a name, e.g. workit git branch ${named}`
    : `this workspace allows any non-protected name: pass one, e.g. workit git branch ${kind}/<slug>`;
}

async function branch(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    base: "value",
    kind: "value",
    slug: "value",
    track: "value",
    carry: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, BRANCH_USAGE);
  const { kind, slug } = flags.values;
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, BRANCH_USAGE);
  if ((kind === undefined) !== (slug === undefined))
    return usage(io, "--kind and --slug go together", BRANCH_USAGE);
  if (kind !== undefined && !(BRANCH_KINDS as readonly string[]).includes(kind))
    return usage(
      io,
      `--kind must be ${BRANCH_KINDS.join(", ")}; ${kindHint(io.cwd, kind)}`,
      BRANCH_USAGE,
    );
  if (kind !== undefined && flags.positionals.length)
    return usage(io, "pass a name or --kind/--slug, not both", BRANCH_USAGE);
  if (kind === undefined && !flags.positionals[0])
    return usage(io, "missing branch name", BRANCH_USAGE);
  // --kind/--slug names come from the release track's naming (core).
  const result = gitBranch(io.cwd, {
    ...(kind !== undefined ? { kind: kind as BranchKind, slug } : { name: flags.positionals[0] }),
    base: flags.values.base ?? null,
    track: flags.values.track ?? null,
    carry: flags.booleans.has("carry"),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: BranchOutcome) => [
    `switched to new branch ${data.branch} from ${data.baseRef} (${short(data.baseSha)})${data.carried ? ", carrying uncommitted changes" : ""}`,
    ...(data.releaseTrack?.name
      ? [`release track: ${data.releaseTrack.name} (${data.releaseTrack.detail})`]
      : []),
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

type CommitArgs = {
  messages: string[];
  files: string[];
  trailers: string[];
  all: boolean;
  amend: boolean;
  noEdit: boolean;
  allowEmpty: boolean;
  paths: string[];
};

const COMMIT_SWITCHES: Record<
  string,
  keyof Pick<CommitArgs, "all" | "amend" | "noEdit" | "allowEmpty">
> = {
  "-a": "all",
  "--all": "all",
  "--amend": "amend",
  "--no-edit": "noEdit",
  "--allow-empty": "allowEmpty",
};

/**
 * `-m` (repeatable, joined like git), `-F`/`--file` (`-` reads stdin),
 * `--trailer` (repeatable),
 * `--amend`, `--no-edit`, `--allow-empty`, `--all`/`-a`, paths positionally
 * or after `--`.
 */
function parseCommit(argv: readonly string[]): CommitArgs | string {
  const out: CommitArgs = {
    messages: [],
    files: [],
    trailers: [],
    all: false,
    amend: false,
    noEdit: false,
    allowEmpty: false,
    paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      out.paths.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json") continue;
    const flag = COMMIT_SWITCHES[arg];
    if (flag) {
      out[flag] = true;
      continue;
    }
    const valued = (
      [
        ["-m", "--message", out.messages],
        ["-F", "--file", out.files],
        [null, "--trailer", out.trailers],
      ] as const
    ).find(
      ([shortName, longName]) =>
        arg === shortName ||
        arg === longName ||
        arg.startsWith(`${longName}=`) ||
        (shortName !== null && arg.startsWith(shortName) && arg.length > 2),
    );
    if (valued) {
      const [shortName, longName, into] = valued;
      if (arg === shortName || arg === longName) {
        const value = argv[++index];
        if (value === undefined)
          return `${arg} requires a ${shortName === "-m" ? "message" : shortName === "-F" ? "file" : "Key: value trailer"}`;
        into.push(value);
      } else
        into.push(arg.startsWith(`${longName}=`) ? arg.slice(longName.length + 1) : arg.slice(2));
      continue;
    }
    if (arg.startsWith("-")) return `unknown option ${arg}`;
    out.paths.push(arg);
  }
  return out;
}

/** The commit message from -m or -F (a path relative to the checkout, or `-` for stdin). */
function commitMessage(parsed: CommitArgs, io: Io): string | { error: string } {
  if (parsed.messages.length && parsed.files.length) return { error: "pass -m or -F, not both" };
  if (parsed.files.length > 1) return { error: "-F takes one file" };
  const [file] = parsed.files;
  if (file === undefined) return parsed.messages.join("\n\n");
  try {
    return file === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(path.resolve(io.cwd, file), "utf8");
  } catch (error) {
    return {
      error: `cannot read -F ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function commit(argv: string[], io: Io): Promise<number> {
  const parsed = parseCommit(argv);
  if (typeof parsed === "string") return usage(io, parsed, COMMIT_USAGE);
  if (parsed.all && parsed.paths.length)
    return usage(io, "pass --all or paths, not both", COMMIT_USAGE);
  if (parsed.noEdit && !parsed.amend)
    return usage(io, "--no-edit only applies with --amend", COMMIT_USAGE);
  const given = parsed.messages.length + parsed.files.length > 0;
  if (parsed.noEdit && given)
    return usage(io, "--no-edit keeps the message; drop -m/-F or --no-edit", COMMIT_USAGE);
  if (!given && !parsed.noEdit)
    return usage(
      io,
      parsed.amend ? "--amend needs -m/-F or --no-edit" : "missing -m <msg> or -F <file>",
      COMMIT_USAGE,
    );
  const message = given ? commitMessage(parsed, io) : null;
  if (message !== null && typeof message !== "string")
    return usage(io, message.error, COMMIT_USAGE);
  if (message !== null && !message.trim())
    return usage(io, "the commit message is empty", COMMIT_USAGE);
  const result = gitCommit(io.cwd, {
    message,
    all: parsed.all,
    paths: parsed.paths,
    amend: parsed.amend,
    allowEmpty: parsed.allowEmpty,
    trailers: parsed.trailers,
    actor: actorFromEnv(io.env),
    env: io.env,
  });
  if (!result.ok) return forgeFail(io, result);
  await ensureImplicitTask(io);
  return emit(io, ok(result.data), (data: CommitOutcome) => [
    `${data.branch} ${short(data.sha)} ${data.message.split("\n", 1)[0]} (${data.files.length ? `${data.files.length} file${data.files.length === 1 ? "" : "s"}` : "empty commit"})${data.amended ? `, amends ${short(data.amended)}` : ""}`,
    ...(data.leftDirty ? [`${data.leftDirty} change(s) left uncommitted`] : []),
    ...data.notes.map((note) => `note: ${note}`),
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
    "overwrite-unintegrated": "boolean",
    expect: "value",
    release: "list",
  });
  if (typeof flags === "string") return usage(io, flags, PUSH_USAGE);
  // A comma list (--release main,develop,v1.2.0) or a repeated flag, or both.
  const release = flags.lists.release?.flatMap((value) =>
    value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (release) {
    if (flags.booleans.size || flags.values.expect !== undefined || flags.positionals.length)
      return usage(
        io,
        "--release takes only ref names (a comma list or a repeated flag: --release main,v1.2.0)",
        PUSH_USAGE,
      );
    return releasePush(release, io);
  }
  if (flags.positionals.length)
    return usage(
      io,
      `unexpected argument ${flags.positionals[0]} (workit pushes the current branch)`,
      PUSH_USAGE,
    );
  const expect = flags.values.expect ?? null;
  if (
    (expect !== null || flags.booleans.has("overwrite-unintegrated")) &&
    !flags.booleans.has("force-with-lease")
  )
    return usage(
      io,
      "--expect and --overwrite-unintegrated only apply with --force-with-lease",
      PUSH_USAGE,
    );
  if (expect !== null && !/^[0-9a-f]{7,64}$/u.test(expect))
    return usage(io, "--expect must be a commit sha (at least 7 hex digits)", PUSH_USAGE);

  const plan = pushPreflight(io.cwd);
  if (!plan.ok) return forgeFail(io, plan);
  // A forge remote: the credential should be the workspace account (S10).
  // Best effort (B1): only a forge that names another account blocks; a slow,
  // down or unknown forge pushes with git and says why the check was skipped.
  const identity = plan.data.local ? null : pushIdentity(io, plan.data.branch);
  if (identity && !identity.ok) return forgeFail(io, identity);
  const checked = identity?.data ?? null;
  const grant = requireGrant(io.cwd, "push", { forge: checked?.forge != null });
  if (!grant.allowed)
    return emit(
      io,
      fail("blocked", grant.error, {
        unblock: grant.unblock,
        data: { reason: grant.reason },
      }),
    );
  const result = executePush(io.cwd, plan.data, {
    forceWithLease: flags.booleans.has("force-with-lease"),
    overwriteUnintegrated: flags.booleans.has("overwrite-unintegrated"),
    expect,
    setUpstream: flags.booleans.has("set-upstream"),
    actor: actorFromEnv(io.env),
    ...(checked ? { identity: { ...checked } } : {}),
  });
  if (!result.ok)
    return forgeFail(io, result, {
      branch: plan.data.branch,
      sha: plan.data.sha,
    });
  const warnings =
    checked?.status === "skipped"
      ? [
          `identity check skipped: ${checked.reason}${checked.unblock ? ` (to restore it: ${checked.unblock})` : ""}`,
        ]
      : [];
  for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
  const envelope = ok({ ...result.data, identity: checked });
  return emit(io, warnings.length ? { ...envelope, warnings } : envelope, (data) => [
    data.pushed
      ? `pushed ${data.branch} ${short(data.previous)} -> ${short(data.sha)} to ${data.remote}${data.forced ? " (force-with-lease)" : ""}; remote tip verified`
      : `nothing to push: ${data.remote}/${data.branch} is already at ${short(data.sha)}`,
    ...(data.upstream ? [`upstream: ${data.remote}/${data.branch}`] : []),
  ]);
}

/**
 * `--release`: finish a git-flow release or hotfix by pushing the production
 * and develop branches and the release tag (`v*` or git-flow's configured prefix), which `workit git push` refuses.
 * Needs the `release` grant (never a default) and the `push` grant.
 */
async function releasePush(names: string[], io: Io): Promise<number> {
  const plan = releasePushPreflight(io.cwd, names);
  if (!plan.ok) return forgeFail(io, plan);
  const release = requireGrant(io.cwd, "release");
  if (!release.allowed)
    return emit(
      io,
      fail("blocked", release.error, {
        unblock: release.unblock,
        data: { reason: release.reason },
      }),
    );
  const firstBranch = plan.data.refs.find((ref) => ref.kind === "branch")?.name;
  const identity = plan.data.local ? null : pushIdentity(io, firstBranch ?? plan.data.refs[0].name);
  if (identity && !identity.ok) return forgeFail(io, identity);
  const checked = identity?.data ?? null;
  const pushGrant = requireGrant(io.cwd, "push", { forge: checked?.forge != null });
  if (!pushGrant.allowed)
    return emit(
      io,
      fail("blocked", pushGrant.error, {
        unblock: pushGrant.unblock,
        data: { reason: pushGrant.reason },
      }),
    );
  const result = executeReleasePush(io.cwd, plan.data, {
    actor: actorFromEnv(io.env),
    grant: release.source,
    ...(checked ? { identity: { ...checked } } : {}),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok({ ...result.data, identity: checked }), (data: ReleasePushOutcome) => [
    ...data.refs.map((ref) =>
      ref.pushed
        ? `pushed ${ref.name} ${short(ref.previous)} -> ${short(ref.sha)} to ${data.remote}; remote tip verified`
        : `nothing to push: ${data.remote} ${ref.name} is already at ${short(ref.sha)}`,
    ),
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
  ]);
}

/**
 * `workit git trailers`: `on` or `off`, whether commits in this workspace
 * carry the Workit-Session trailer. The session hook's helper asks this.
 */
function trailers(argv: string[], io: Io): number {
  const extra = argv.find((arg) => arg !== "--json");
  if (extra !== undefined) return usage(io, `unexpected argument ${extra}`, "workit git trailers");
  const state = workspaceTrailers(io.cwd);
  return emit(io, ok(state), (data) => (data.enabled ? "on" : "off"));
}

const READ_ONLY = new Set(["status", "diff", "log", "fetch", "show", "blame"]);

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== undefined && READ_ONLY.has(sub))
    return usage(
      io,
      `workit git has no ${sub}`,
      `read-only git is fine raw: \`git -C ${io.cwd} ${sub}\``,
    );
  if (sub === "branch") return branch(rest, io);
  if (sub === "commit") return commit(rest, io);
  if (sub === "push") return push(rest, io);
  if (sub === "trailers") return trailers(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown git subcommand "${sub}"` : "missing git subcommand",
    USAGE,
  );
}
