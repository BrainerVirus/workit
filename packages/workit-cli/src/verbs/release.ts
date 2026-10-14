// `workit release start|finish|publish` (#290): a git-flow release or hotfix
// without the git-flow binary. The rules live in core git/release.ts; the
// push reuses `workit git push --release` and `workit pr create` in process,
// so their grant, identity and verification checks apply unchanged.
//
//   workit release start <version> [--hotfix] [--track <t>]
//   workit release finish [<version>] [--track <t>] [--dry-run]
//   workit release publish [<version>]
import { requireGrant } from "@brainervirus/workit-core/src/autonomy";
import { verifyReleased } from "@brainervirus/workit-core/src/forge/verify";
import {
  deleteRemoteBranch,
  executePush,
  pushPreflight,
} from "@brainervirus/workit-core/src/git/ops";
import {
  finishLocally,
  planReleaseFinish,
  recordReleaseStep,
  releaseStart,
  releaseToPublish,
  switchToRelease,
  type FinishPlan,
} from "@brainervirus/workit-core/src/git/release";
import { parseRemoteUrl, pushUrl } from "@brainervirus/workit-core/src/git/rev";
import { actorFromEnv, appendObserved } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Envelope, type Io } from "../output";
import { connect, forgeDeps, forgeFail, parseFlags, pushIdentity, usage } from "./forge-common";

const START_USAGE = "workit release start <version> [--hotfix] [--track <t>] [--json]";
const FINISH_USAGE = "workit release finish [<version>] [--track <t>] [--dry-run] [--json]";
const PUBLISH_USAGE = "workit release publish [<version>] [--json]";
const USAGE = "workit release start|finish|publish ... (workit help release)";

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "(none)");

/** Run another verb in process and read its JSON envelope. */
async function subVerb(
  load: () => Promise<{ run: (argv: string[], io: Io) => Promise<number> }>,
  argv: string[],
  io: Io,
): Promise<Envelope> {
  let out = "";
  let err = "";
  const verb = await load();
  await verb.run(argv, {
    ...io,
    json: true,
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
  });
  try {
    return JSON.parse(out) as Envelope;
  } catch {
    return fail("failed", (out + err).trim() || `${argv.join(" ")} printed nothing`);
  }
}

const blocked = (io: Io, grant: { error: string; unblock: string; reason: string }) =>
  emit(
    io,
    fail("blocked", grant.error, { unblock: grant.unblock, data: { reason: grant.reason } }),
  );

async function start(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { hotfix: "boolean", track: "value" });
  if (typeof flags === "string") return usage(io, flags, START_USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? "pass one version" : "missing <version>",
      START_USAGE,
    );
  const result = releaseStart(io.cwd, {
    version: flags.positionals[0],
    hotfix: flags.booleans.has("hotfix"),
    track: flags.values.track ?? null,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data) => [
    `started ${data.branch} from ${data.base} (${short(data.baseSha)}), local only; it will be tagged ${data.tag}`,
    `next: commit the version bump, changelog and docs on ${data.branch} (workit git commit), then: workit release finish`,
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

const isLocalRemote = (cwd: string, remote: string | null): boolean => {
  const url = remote ? pushUrl(cwd, remote) : null;
  return !url || parseRemoteUrl(url)?.protocol === "file";
};

/** What a finish will do, step by step, from the plan's state. */
const stepsOf = (plan: FinishPlan) => [
  { step: `merge ${plan.branch} into ${plan.production} (--no-ff)`, done: plan.state.merged },
  { step: `tag ${plan.tag} (annotated)`, done: plan.state.tagged },
  ...plan.mergeBack.map((name) => ({
    step: `merge ${plan.tag} into ${name} (--no-ff)`,
    done: plan.state.mergedBack[name] === true,
  })),
  { step: `delete local ${plan.branch}`, done: plan.state.branchDeleted },
  {
    step: `push ${[plan.production, ...plan.mergeBack, plan.tag].join(", ")} (atomic, fast-forward only)`,
    done: false,
  },
  { step: `forge release ${plan.tag}`, done: false },
  { step: `verify ${plan.tag} on the remote`, done: false },
];

/** Outside git-flow the trunk moves only through review: push the branch and open the release PR. */
async function releasePr(io: Io, plan: FinishPlan, dryRun: boolean): Promise<number> {
  const title = `chore(release): ${plan.version}`;
  if (dryRun)
    return emit(
      io,
      ok({
        ...plan,
        steps: [`push ${plan.branch}`, `open a PR ${plan.branch} -> ${plan.production}: ${title}`],
      }),
      () => [
        `would push ${plan.branch} and open a release PR into ${plan.production} (not git-flow: the trunk moves only through review)`,
      ],
    );
  const switched = switchToRelease(io.cwd, plan);
  if (!switched.ok) return forgeFail(io, switched);
  const pushed = await subVerb(() => import("./git"), ["push", "--set-upstream"], io);
  if (!pushed.ok) return emit(io, pushed);
  const pr = await subVerb(
    () => import("./pr"),
    [
      "create",
      "--base",
      plan.production,
      "--title",
      title,
      `--body=${plan.changelog ?? `Release ${plan.version}`}`,
    ],
    io,
  );
  if (!pr.ok) return emit(io, pr);
  recordReleaseStep(io.cwd, actorFromEnv(io.env), plan, {
    type: "release.pr_opened",
    branch: plan.branch,
    pr: (pr.data as { number?: number }).number ?? null,
  });
  return emit(io, ok({ ...plan, pr: pr.data }), () => [
    `opened the release PR ${String((pr.data as { url?: string }).url ?? "")} into ${plan.production}`,
    `next: once it merges, tag the merged commit ${plan.tag} and: workit git push --release ${plan.tag}`,
  ]);
}

async function finish(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { track: "value", "dry-run": "boolean" });
  if (typeof flags === "string") return usage(io, flags, FINISH_USAGE);
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, FINISH_USAGE);
  const dryRun = flags.booleans.has("dry-run");
  const planned = planReleaseFinish(io.cwd, {
    version: flags.positionals[0] ?? null,
    track: flags.values.track ?? null,
  });
  if (!planned.ok) return forgeFail(io, planned);
  const plan = planned.data;
  if (!plan.gitflow) {
    if (!dryRun && plan.state.branchDeleted)
      return emit(io, fail("not_found", `${plan.branch} is gone; nothing to open a PR from`));
    return releasePr(io, plan, dryRun);
  }
  const actor = actorFromEnv(io.env);
  const local = isLocalRemote(io.cwd, plan.remote);
  const release = requireGrant(io.cwd, "release");
  const push = requireGrant(io.cwd, "push", { forge: !local });
  const steps = stepsOf(plan);
  if (dryRun) {
    const missing = [release, push].find((grant) => !grant.allowed);
    const data = { ...plan, steps, grants: { release: release.allowed, push: push.allowed } };
    if (missing && !missing.allowed)
      return emit(io, fail("blocked", missing.error, { unblock: missing.unblock, data }));
    return emit(io, ok(data), () => [
      `finish ${plan.branch} -> ${plan.production} as ${plan.tag}:`,
      ...steps.map((entry) => `  ${entry.done ? "done" : "todo"}  ${entry.step}`),
    ]);
  }
  if (!release.allowed) return blocked(io, release);
  if (!push.allowed) return blocked(io, push);
  const resume = `workit release finish ${plan.version}${plan.track ? ` --track ${plan.track}` : ""}`;
  const merged = finishLocally(io.cwd, plan, actor);
  if (!merged.ok) return forgeFail(io, merged, { step: "merge", resume });
  const notes = [...plan.notes];
  const pushed = await subVerb(
    () => import("./git"),
    [
      "push",
      ...[plan.production, ...plan.mergeBack, plan.tag].flatMap((ref) => ["--release", ref]),
    ],
    io,
  );
  if (!pushed.ok) return emit(io, { ...pushed, data: { ...pushed.data, step: "push", resume } });
  // A published release branch goes too, as git-flow does (only at the tip it had).
  if (plan.published && plan.remote) {
    const removed = deleteRemoteBranch(io.cwd, plan.remote, plan.branch, plan.published);
    notes.push(
      removed.ok
        ? `deleted ${plan.remote}/${plan.branch}`
        : `kept ${plan.remote}/${plan.branch}: ${removed.error}`,
    );
    if (removed.ok)
      recordReleaseStep(io.cwd, actor, plan, {
        type: "release.remote_branch_deleted",
        branch: plan.branch,
        head: plan.published,
      });
  }
  let forgeRelease: { url: string | null; created: boolean } | null = null;
  if (local) notes.push(`${plan.remote ?? "the remote"} is a local path: no forge release`);
  else {
    const connected = connect(io);
    if (!connected.ok) return forgeFail(io, connected, { step: "forge-release", resume });
    const forge = connected.data.forge;
    const found = forge.findRelease(plan.tag);
    if (!found.ok) return forgeFail(io, found, { step: "forge-release", resume });
    if (found.data) forgeRelease = { url: found.data.url, created: false };
    else {
      const created = forge.createRelease({
        tag: plan.tag,
        name: plan.tag,
        body: plan.changelog ?? `Release ${plan.version}`,
      });
      if (!created.ok) return forgeFail(io, created, { step: "forge-release", resume });
      forgeRelease = { url: created.data.url, created: true };
    }
    recordReleaseStep(io.cwd, actor, plan, {
      type: "release.forge_released",
      branch: plan.production,
      url: forgeRelease.url,
      created: forgeRelease.created,
    });
  }
  const verified = verifyReleased(io.cwd, { tag: plan.tag, actor }, forgeDeps.npm);
  if (!verified.ok) return forgeFail(io, verified, { step: "verify", resume });
  if (!verified.data.delivered)
    return emit(
      io,
      fail("failed", `release_unverified: ${plan.tag} is not on ${plan.remote ?? "the remote"}`, {
        data: { step: "verify", resume, report: verified.data },
        unblock: resume,
      }),
    );
  recordReleaseStep(io.cwd, actor, plan, {
    type: "release.finished",
    branch: plan.branch,
    head: merged.data.tagTarget,
  });
  return emit(
    io,
    ok({ ...plan, ran: merged.data.ran, push: pushed.data, forgeRelease, notes }),
    () => [
      `finished ${plan.branch}: ${plan.production} and ${plan.mergeBack.join(", ")} merged, ${plan.tag} tagged on ${short(merged.data.tagTarget)}`,
      `pushed ${[plan.production, ...plan.mergeBack, plan.tag].join(", ")} to ${plan.remote ?? "the remote"}; remote tips verified`,
      ...(forgeRelease
        ? [
            `forge release ${plan.tag}${forgeRelease.created ? " created" : " already there"}${forgeRelease.url ? `: ${forgeRelease.url}` : ""}`,
          ]
        : []),
      ...notes.map((note) => `note: ${note}`),
    ],
  );
}

/** The one path that pushes a release branch: only when the user asks for it. */
async function publish(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {});
  if (typeof flags === "string") return usage(io, flags, PUBLISH_USAGE);
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, PUBLISH_USAGE);
  const located = releaseToPublish(io.cwd, flags.positionals[0] ?? null);
  if (!located.ok) return forgeFail(io, located);
  const plan = pushPreflight(io.cwd, { branch: located.data.branch });
  if (!plan.ok) return forgeFail(io, plan);
  const identity = plan.data.local ? null : pushIdentity(io, plan.data.branch);
  if (identity && !identity.ok) return forgeFail(io, identity);
  const checked = identity?.data ?? null;
  const grant = requireGrant(io.cwd, "push", { forge: checked?.forge != null });
  if (!grant.allowed) return blocked(io, grant);
  const actor = actorFromEnv(io.env);
  const result = executePush(io.cwd, plan.data, {
    setUpstream: true,
    actor,
    ...(checked ? { identity: { ...checked } } : {}),
  });
  if (!result.ok) return forgeFail(io, result);
  appendObserved(io.cwd, {
    type: "release.published",
    actor,
    version: located.data.version,
    branch: located.data.branch,
    head: result.data.sha,
  });
  return emit(io, ok({ ...result.data, version: located.data.version }), (data) => [
    `published ${data.branch} (${short(data.sha)}) to ${data.remote}; remote tip verified`,
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "start") return start(rest, io);
  if (sub === "finish") return finish(rest, io);
  if (sub === "publish") return publish(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-")
      ? `unknown release subcommand "${sub}"`
      : "missing release subcommand",
    USAGE,
  );
}
