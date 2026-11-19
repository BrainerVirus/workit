// `workit release tag <vX.Y.Z>` and `workit release notes edit <tag>
// --from-changelog` (#895): the tag-driven release (goreleaser and similar,
// github-flow) without raw git. The rules live in core core/release-tag.ts;
// the push reuses `workit git push --release` in process, so its grant,
// identity and remote-tip checks apply unchanged. No forge release is
// created here: the release workflow the tag starts publishes it, and
// `--wait` first waits for pending CI on the trunk tip (#912), then watches
// that workflow and verifies the release.
import { requireGrant } from "@workit-dev/core/src/autonomy";
import { pushTarget } from "@workit-dev/core/src/core/remotes";
import {
  changelogBlock,
  createReleaseTag,
  dropReleaseTag,
  mergeReleaseBody,
  planReleaseTag,
  readReleaseBody,
  releaseCiVerdict,
  releaseTagVersion,
  tagChangelogSection,
  tagWorkflowRuns,
  writeReleaseBody,
  type WorkflowRun,
} from "@workit-dev/core/src/core/release-tag";
import type { ResolvedForge } from "@workit-dev/core/src/forge/resolve";
import { verifyReleased } from "@workit-dev/core/src/forge/verify";
import { actorFromEnv, appendObserved } from "@workit-dev/core/src/ledger";
import { emit, fail, ok, type Envelope, type Io } from "../output";
import { progressFor } from "../progress";
import {
  announce,
  BACKGROUND_HINT,
  connect,
  forgeDeps,
  forgeFail,
  parseDuration,
  parseFlags,
  usage,
} from "./forge-common";
import { pollBranchChecks } from "./ci-wait";

const TAG_USAGE =
  "workit release tag <vX.Y.Z> [--at <ref>] [--wait [--timeout 30m] [--interval 30s]] [--dry-run] [--json]";
const NOTES_EDIT_USAGE = "workit release notes edit <tag> --from-changelog [--json]";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 30_000;

const short = (sha: string): string => sha.slice(0, 12);

const blocked = (
  io: Io,
  grant: { error: string; unblock: string; reason: string },
  data: Record<string, unknown> = {},
) =>
  emit(
    io,
    fail("blocked", grant.error, {
      unblock: grant.unblock,
      data: { ...data, reason: grant.reason },
    }),
  );

/**
 * `workit git push --release <tag>` run in process, without its forge
 * release, to `remote.name` (the trunk `remote.branch`'s push remote).
 */
export type TagPush = (tag: string, remote: { name: string; branch: string }) => Promise<Envelope>;

type Waited =
  | { ok: true; runs: WorkflowRun[]; release: { url: string | null } }
  | { ok: false; envelope: Envelope };

/** Poll the tag's workflow runs until they pass and the forge release exists, one fails, or time runs out. */
async function waitForRelease(
  io: Io,
  resolved: ResolvedForge,
  tag: string,
  deadline: number,
  intervalMs: number,
): Promise<Waited> {
  const started = forgeDeps.now();
  const unblock = `workit verify-delivery release --tag ${tag}  # the tag; the forge release appears when the workflow on ${tag} finishes`;
  let runs: WorkflowRun[] = [];
  for (;;) {
    const read = tagWorkflowRuns(resolved, tag);
    if (!read.ok) return { ok: false, envelope: fail(read.code, read.error, { data: { tag } }) };
    runs = read.data;
    const failing = runs.filter((entry) => entry.state === "failing");
    if (failing.length)
      return {
        ok: false,
        envelope: fail(
          "failed",
          `release_workflow_failed: ${failing.map((entry) => `${entry.name}${entry.url ? ` (${entry.url})` : ""}`).join(", ")} failed on ${tag}; the tag is pushed`,
          {
            unblock: `workit ci logs --failed  # read why; a rerun of the workflow on ${tag} publishes the release`,
            data: { tag, runs },
          },
        ),
      };
    if (!runs.some((entry) => entry.state === "pending")) {
      const found = resolved.forge.findRelease(tag);
      if (!found.ok)
        return { ok: false, envelope: fail(found.code, found.error, { data: { tag, runs } }) };
      if (found.data) return { ok: true, runs, release: { url: found.data.url } };
    }
    if (forgeDeps.now() >= deadline)
      return {
        ok: false,
        envelope: fail(
          "pending",
          `release_pending: ${runs.length ? `the release workflow on ${tag} ${runs.some((entry) => entry.state === "pending") ? "is still running" : "passed"}` : `no workflow run on ${tag} yet`} and the forge has no release ${tag} after ${Math.round((forgeDeps.now() - started) / 1000)}s (the --timeout covers the CI wait too); the tag is pushed`,
          { unblock, data: { tag, runs } },
        ),
      };
    await forgeDeps.sleep(Math.min(intervalMs, Math.max(0, deadline - forgeDeps.now())));
  }
}

/**
 * `workit release tag <vX.Y.Z>`: under the release grant, on the fetched
 * remote trunk with green CI, a new tag and the changelog section, tag it
 * (annotated, no local branch moves), push it with `workit git push
 * --release` (remote tip verified) and, with --wait, watch the release
 * workflow and verify the forge release.
 */
export async function releaseTag(argv: string[], io: Io, pushTag: TagPush): Promise<number> {
  const flags = parseFlags(argv, {
    at: "value",
    wait: "boolean",
    timeout: "value",
    interval: "value",
    "dry-run": "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, TAG_USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? `unexpected argument ${flags.positionals[1]}` : "missing <tag>",
      TAG_USAGE,
    );
  const wait = flags.booleans.has("wait");
  if (!wait && (flags.values.timeout || flags.values.interval))
    return usage(io, "--timeout and --interval apply to --wait only", TAG_USAGE);
  const timeoutMs = flags.values.timeout ? parseDuration(flags.values.timeout) : DEFAULT_TIMEOUT_MS;
  const intervalMs = flags.values.interval
    ? parseDuration(flags.values.interval)
    : DEFAULT_INTERVAL_MS;
  if (timeoutMs === null || intervalMs === null || intervalMs <= 0)
    return usage(io, "--timeout and --interval take a duration (30s, 20m)", TAG_USAGE);
  const tag = flags.positionals[0];
  // One --timeout for the whole --wait: the CI wait and the release workflow wait share it.
  const started = forgeDeps.now();
  const deadline = started + timeoutMs;
  const dryRun = flags.booleans.has("dry-run");
  // The grant first: nothing is fetched or read for a workspace that never allowed a release.
  const parsed = releaseTagVersion(io.cwd, tag);
  if (!parsed.ok) return forgeFail(io, parsed);
  const release = requireGrant(io.cwd, "release");
  if (!release.allowed) return blocked(io, release, { tag });
  if (wait)
    announce(
      io,
      `release tag ${tag} --wait waits for pending CI on the trunk, then for the release workflow, up to ${Math.round(timeoutMs / 60_000)}m in all; ${BACKGROUND_HINT}`,
    );
  const planned = progressFor(io).runSync(
    "Fetching the trunk and checking the tag",
    () => planReleaseTag(io.cwd, { tag, at: flags.values.at ?? null }),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!planned.ok) return forgeFail(io, planned, { tag });
  const plan = planned.data;
  const scoped = requireGrant(io.cwd, "release", { target: () => pushTarget(io.cwd, plan.remote) });
  if (!scoped.allowed) return blocked(io, scoped, { tag });
  const notes: string[] = [];
  let resolved: ResolvedForge | null = null;
  let ci: { passing: number } | null = null;
  if (plan.local) notes.push(`${plan.remote} is a local path: no forge, so CI was not read`);
  else {
    // The forge of the trunk's push remote: the one fetched and pushed to.
    const connected = connect(io, plan.production);
    if (!connected.ok) return forgeFail(io, connected, { tag, step: "ci" });
    resolved = connected.data;
    const forge = connected.data.forge;
    const trunk = `${plan.remote}/${plan.production}`;
    // --wait: pending (or not yet reported) CI on the target is waited out first.
    const read =
      wait && !dryRun
        ? await progressFor(io).run(
            `Waiting for CI on ${trunk}`,
            async () => {
              const polled = await pollBranchChecks(connected.data, plan.production, {
                sha: plan.target,
                started,
                deadline,
                intervalMs,
              });
              return polled.ok ? { ok: true as const, data: polled.data.checks } : polled;
            },
            (r) => (r.ok ? "done" : "failed"),
          )
        : progressFor(io).runSync(
            `Reading CI on ${trunk}`,
            () => forge.branchChecks(plan.production),
            (r) => (r.ok ? "done" : "failed"),
          );
    if (!read.ok) return forgeFail(io, read, { tag, step: "ci" });
    const checks = read;
    const rerun = [
      `workit release tag ${tag}`,
      ...(["at", "timeout", "interval"] as const).flatMap((name) =>
        flags.values[name] ? [`--${name} ${flags.values[name]}`] : [],
      ),
    ].join(" ");
    const verdict = releaseCiVerdict(checks.data, plan, rerun);
    if (!verdict.green)
      return emit(
        io,
        fail("blocked", `${verdict.error}; nothing was tagged`, {
          unblock: verdict.unblock,
          data: { ...plan, reason: verdict.reason, checks: checks.data.checks, step: "ci" },
        }),
      );
    ci = { passing: verdict.passing };
  }
  const steps = [
    `tag ${tag} (annotated) on ${plan.at} (${short(plan.target)}); no local branch moves`,
    `push ${tag} (workit git push --release; remote tip verified)`,
    wait
      ? `wait for the release workflow on ${tag} and verify the forge release`
      : "the release workflow on the tag publishes the forge release (--wait watches it)",
  ];
  if (dryRun)
    return emit(io, ok({ ...plan, ci, steps, notes }), () => [
      `release tag ${tag}${ci ? ` (CI green on ${short(plan.target)}: ${ci.passing} passing)` : ""}:`,
      ...steps.map((step) => `  todo  ${step}`),
      ...notes.map((note) => `note: ${note}`),
    ]);
  const actor = actorFromEnv(io.env);
  const tagged = createReleaseTag(io.cwd, plan, actor);
  if (!tagged.ok) return forgeFail(io, tagged, { tag, step: "tag" });
  const pushed = await progressFor(io).run(
    `Pushing ${tag}`,
    () => pushTag(tag, { name: plan.remote, branch: plan.production }),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!pushed.ok) {
    const dropped = dropReleaseTag(io.cwd, plan);
    return emit(io, {
      ...pushed,
      ...(dropped
        ? {
            error: `${pushed.error}; deleted the local tag ${tag} this run made (the remote never had it), so a rerun can tag again`,
            unblock: `fix what the push refused, then rerun: workit release tag ${tag}`,
          }
        : { unblock: pushed.unblock ?? `workit git push --release ${tag}` }),
      data: { ...pushed.data, step: "push", ...(dropped ? { untagged: tag } : {}) },
    });
  }
  const verified = verifyReleased(
    io.cwd,
    { tag, sha: plan.target, remote: plan.remote, actor },
    forgeDeps.npm,
  );
  if (!verified.ok) return forgeFail(io, verified, { tag, step: "verify" });
  if (!verified.data.delivered)
    return emit(
      io,
      fail(
        "failed",
        `release_unverified: ${tag} is not on ${plan.remote} at ${short(plan.target)}`,
        {
          data: { tag, step: "verify", report: verified.data },
        },
      ),
    );
  let forgeRelease: { url: string | null; runs: WorkflowRun[] } | null = null;
  if (wait && resolved) {
    const waited = await waitForRelease(io, resolved, tag, deadline, intervalMs);
    if (!waited.ok) return emit(io, waited.envelope);
    forgeRelease = { url: waited.release.url, runs: waited.runs };
    appendObserved(io.cwd, {
      type: "release.forge_released",
      actor,
      version: plan.version,
      tag,
      url: waited.release.url,
      created: false,
    });
  } else if (wait) notes.push("--wait needs a forge remote: nothing to watch");
  return emit(io, ok({ ...plan, ci, push: pushed.data, forgeRelease, notes }), () => [
    `tagged ${tag} on ${plan.at} (${short(plan.target)}) and pushed it to ${plan.remote}; remote tag verified; no local branch moved`,
    ...(forgeRelease
      ? [
          `release workflow passed and the forge release ${tag} exists${forgeRelease.url ? `: ${forgeRelease.url}` : ""}`,
        ]
      : wait
        ? []
        : [`next: the release workflow on ${tag} publishes the forge release (--wait watches it)`]),
    ...notes.map((note) => `note: ${note}`),
  ]);
}

/**
 * `workit release notes edit <tag> --from-changelog`: put the version's
 * changelog section at the top of the published release's body, between
 * Workit's markers (replacing an earlier one), under the release grant.
 * Running it twice changes nothing the second time.
 */
export async function notesEdit(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { "from-changelog": "boolean" });
  if (typeof flags === "string") return usage(io, flags, NOTES_EDIT_USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? `unexpected argument ${flags.positionals[1]}` : "missing <tag>",
      NOTES_EDIT_USAGE,
    );
  if (!flags.booleans.has("from-changelog"))
    return usage(io, "name the source: --from-changelog", NOTES_EDIT_USAGE);
  const tag = flags.positionals[0];
  const parsed = releaseTagVersion(io.cwd, tag);
  if (!parsed.ok) return forgeFail(io, parsed);
  const release = requireGrant(io.cwd, "release");
  if (!release.allowed) return blocked(io, release, { tag });
  const lookup = tagChangelogSection(io.cwd, tag, parsed.data.version);
  if (!lookup.ok) return forgeFail(io, lookup, { tag });
  const found = lookup.data;
  if (!found)
    return emit(
      io,
      fail(
        "blocked",
        `changelog_section_missing: no "## [${parsed.data.version}]" section in the changelog at ${tag} or on the trunk; nothing was edited`,
        {
          unblock: `add the "## [${parsed.data.version}]" section to the changelog through a PR, then rerun: workit release notes edit ${tag} --from-changelog`,
          data: { tag, reason: "changelog_section_missing" },
        },
      ),
    );
  // The forge of the trunk's push remote: the one the tag was read from.
  const connected = connect(io, parsed.data.production);
  if (!connected.ok) return forgeFail(io, connected, { tag });
  const resolved = connected.data;
  const scoped = requireGrant(io.cwd, "release", {
    target: () => pushTarget(io.cwd, resolved.remote),
  });
  if (!scoped.allowed) return blocked(io, scoped, { tag });
  const current = readReleaseBody(resolved, tag);
  if (!current.ok) return forgeFail(io, current, { tag });
  if (!current.data)
    return emit(
      io,
      fail("not_found", `the forge has no published release ${tag}; nothing was edited`, {
        unblock: `rerun once the release workflow on ${tag} published it: workit release notes edit ${tag} --from-changelog`,
        data: { tag },
      }),
    );
  const merged = mergeReleaseBody(current.data.body, tag, changelogBlock(tag, found.section));
  if (!merged.ok) return forgeFail(io, merged, { tag });
  const body = merged.data;
  const changed = body !== current.data.body;
  if (changed) {
    const written = writeReleaseBody(resolved, tag, current.data, body);
    if (!written.ok) return forgeFail(io, written, { tag });
    appendObserved(io.cwd, {
      type: "release.notes_edited",
      actor: actorFromEnv(io.env),
      version: parsed.data.version,
      tag,
      source: found.ref,
      url: current.data.url,
    });
  }
  return emit(io, ok({ tag, changed, source: found.ref, url: current.data.url, body }), () => [
    changed
      ? `release ${tag}: its body now starts with the ${parsed.data.version} changelog section (from ${found.ref})${current.data?.url ? `: ${current.data.url}` : ""}`
      : `release ${tag} already starts with the ${parsed.data.version} changelog section; nothing changed`,
  ]);
}
