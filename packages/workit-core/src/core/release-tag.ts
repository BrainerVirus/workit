// `workit release tag <vX.Y.Z>` and `workit release notes edit <tag>
// --from-changelog` (#895): a repository that releases by pushing a version
// tag (goreleaser, cargo-dist, a release workflow on `push: tags`) on
// github-flow, with no release branch. The tag goes on the fetched remote
// trunk (never moving a local branch) once its CI is green, the tag is new
// and the changelog has the version's section; the push itself is
// `workit git push --release`. The notes edit backfills a published
// release's body from its changelog section between markers, idempotently.
import { appendObserved, type LedgerActor } from "../ledger";
import { apiJson, apiWrite } from "../forge/exec";
import type { ResolvedForge } from "../forge/resolve";
import { failure, success, type ForgeResult, type RefChecks } from "../forge/types";
import { git, gitError, releaseLinesOf } from "../git/ops";
import { changelogSection } from "../git/release";
import {
  fetchRefs,
  parseRemoteUrl,
  pushRemoteName,
  pushUrl,
  remoteRefTip,
  resolveRef,
} from "../git/rev";
import { resolveChangelogPaths } from "./changelog-gate";
import { workspaceChangelog } from "./workspaces";

const VERSION = /^\d[0-9A-Za-z._+-]{0,99}$/u;

export type ReleaseTagPlan = {
  tag: string;
  version: string;
  tagPrefix: string;
  /** The trunk the tag is cut from (the release line's production branch). */
  production: string;
  remote: string;
  /** What the tag goes on, as named (default `<remote>/<production>`). */
  at: string;
  target: string;
  /** The fetched remote trunk tip. */
  trunkTip: string;
  /** The version's changelog section at the target; null when the repo keeps no changelog. */
  changelog: string | null;
  changelogFiles: string[];
  /** The push remote is a local path: no forge, so no CI to read. */
  local: boolean;
};

/** `v1.2.3` on the workspace's release line: its prefix and the version after it. */
export function releaseTagVersion(
  cwd: string,
  tag: string,
): ForgeResult<{ version: string; tagPrefix: string; production: string }> {
  const line = releaseLinesOf(cwd)[0];
  const version = tag.startsWith(line.tagPrefix) ? tag.slice(line.tagPrefix.length) : "";
  if (!VERSION.test(version) || version.includes("..") || version.endsWith(".lock"))
    return failure(
      "invalid_input",
      `${JSON.stringify(tag)} is not a release tag of this repository (${line.tagPrefix}<version>, e.g. ${line.tagPrefix}1.2.3)`,
    );
  if (!git(cwd, ["check-ref-format", `refs/tags/${tag}`]).ok)
    return failure("invalid_input", `${tag} is not a valid tag name`);
  return success({ version, tagPrefix: line.tagPrefix, production: line.production });
}

const rollFix = (version: string, tag: string): string =>
  `roll the Unreleased entries into a "## [${version}] - <date>" section on a branch and merge it through a PR, then rerun: workit release tag ${tag}`;

/**
 * Preflight of `workit release tag`: fetch the remote trunk, resolve the ref
 * (default the fetched trunk tip), refuse an existing tag (here or on the
 * remote) and, when the repository keeps a changelog, a missing section.
 * Nothing changes here except the fetched remote-tracking ref.
 */
export function planReleaseTag(
  cwd: string,
  input: { tag: string; at?: string | null },
): ForgeResult<ReleaseTagPlan> {
  const tag = input.tag.trim();
  const parsed = releaseTagVersion(cwd, tag);
  if (!parsed.ok) return parsed;
  const { version, tagPrefix, production } = parsed.data;
  const remote = pushRemoteName(cwd, production);
  const raw = remote ? pushUrl(cwd, remote) : null;
  if (!remote || !raw)
    return failure(
      "not_found",
      "no push remote with a single push URL is configured for this repository",
      "git remote add origin <url>",
    );
  const fetched = fetchRefs(cwd, remote, [
    `+refs/heads/${production}:refs/remotes/${remote}/${production}`,
  ]);
  if (!fetched.ok) return failure(fetched.code, fetched.error);
  const trunkTip = resolveRef(cwd, `refs/remotes/${remote}/${production}`);
  if (!trunkTip)
    return failure("not_found", `${remote}/${production} does not exist; push the trunk first`);
  const at = input.at?.trim() || `${remote}/${production}`;
  if (at.startsWith("-")) return failure("invalid_input", `--at ${at} is not a ref`);
  const target = resolveRef(cwd, at);
  if (!target) return failure("not_found", `${at} is not a commit here`);
  const local = parseRemoteUrl(raw)?.protocol === "file";
  // The forge reports CI on a branch tip only, so on a forge remote the tag
  // goes on the trunk tip, whose CI is the one read.
  if (target !== trunkTip && !local)
    return failure(
      "blocked",
      `at_not_tip: ${at} (${target.slice(0, 12)}) is not the tip of ${remote}/${production} (${trunkTip.slice(0, 12)}); CI is read on the trunk tip, so a release tag goes there`,
      `workit release tag ${tag}  # tags the trunk tip once its CI is green; to release an older commit, revert what follows it on ${production} through a PR first`,
    );
  if (target !== trunkTip && !git(cwd, ["merge-base", "--is-ancestor", target, trunkTip]).ok)
    return failure(
      "blocked",
      `not_on_trunk: ${at} (${target.slice(0, 12)}) is not on ${remote}/${production}; a release tag goes on a commit the trunk has`,
      `workit release tag ${tag}  # the trunk tip, once the release commit is merged`,
    );
  if (resolveRef(cwd, `refs/tags/${tag}`))
    return failure(
      "blocked",
      `tag_exists: ${tag} already exists locally; a release tag never moves`,
      `workit git push --release ${tag}  # when it is the right commit and not pushed yet; else tag the next version`,
    );
  const tip = remoteRefTip(cwd, raw, `refs/tags/${tag}`);
  if (!tip.ok) return failure(tip.code, tip.error);
  if (tip.sha)
    return failure(
      "blocked",
      `tag_exists: ${remote} already has ${tag} at ${tip.sha.slice(0, 12)}; a release tag never moves`,
      `tag the next version instead: workit release tag ${tagPrefix}<next version>`,
    );
  const changelogFiles = resolveChangelogPaths(cwd, workspaceChangelog(cwd).paths, target);
  const changelog = changelogFiles.length ? changelogSection(cwd, target, version) : null;
  if (changelogFiles.length && changelog === null)
    return failure(
      "blocked",
      `changelog_section_missing: ${changelogFiles.join(", ")} at ${at} (${target.slice(0, 12)}) has no "## [${version}]" section`,
      rollFix(version, tag),
    );
  return success({
    tag,
    version,
    tagPrefix,
    production,
    remote,
    at,
    target,
    trunkTip,
    changelog,
    changelogFiles,
    local,
  });
}

export type CiVerdict =
  | { green: true; passing: number }
  | {
      green: false;
      reason: "ci_red" | "ci_pending" | "ci_unknown";
      error: string;
      unblock: string;
    };

/**
 * Whether `checks` (the forge's checks on the trunk tip) clear `target` for a
 * release: they must describe that very commit, report at least one check,
 * and none may fail or still run (a required check, when the forge says which,
 * must pass). `rerun` is the call that retries (its `--at`, when given); a
 * pending or not yet reported CI retries it with `--wait`, which waits for CI
 * itself (#912).
 */
export function releaseCiVerdict(
  checks: RefChecks,
  plan: Pick<ReleaseTagPlan, "tag" | "target" | "remote" | "production" | "at">,
  rerun = `workit release tag ${plan.tag}`,
): CiVerdict {
  const where = `${plan.at} (${plan.target.slice(0, 12)})`;
  const waits = `Retry as: ${rerun} --wait  # waits for CI on ${plan.production}, then tags`;
  if (checks.sha && checks.sha !== plan.target)
    return {
      green: false,
      reason: "ci_unknown",
      error: `ci_unknown: the forge reports CI for ${plan.remote}/${plan.production} at ${checks.sha.slice(0, 12)}, not ${where}; the trunk moved while it was read`,
      unblock: `${rerun}  # again: it fetches the new trunk tip`,
    };
  const failing = checks.checks.filter(
    (check) => check.state === "failing" || (check.required === true && check.state === "skipped"),
  );
  if (failing.length)
    return {
      green: false,
      reason: "ci_red",
      error: `ci_red: CI on ${where} is red (${failing.map((check) => check.name).join(", ")}); a release tag goes only on a green commit`,
      unblock: `workit ci rerun --ref ${plan.production} --failed --reason flake  # when it is a flake; else fix the trunk, then: ${rerun}`,
    };
  const pending = checks.checks.filter((check) => check.state === "pending");
  if (pending.length)
    return {
      green: false,
      reason: "ci_pending",
      error: `ci_pending: CI on ${where} is still running (${pending.map((check) => check.name).join(", ")})`,
      unblock: waits,
    };
  const passing = checks.checks.filter((check) => check.state === "passing").length;
  if (!passing)
    return {
      green: false,
      reason: "ci_unknown",
      error: `ci_unknown: no CI has reported on ${where}; a release tag goes only on a green commit`,
      unblock: waits,
    };
  return { green: true, passing };
}

/** The annotated tag on the plan's target (message: the changelog section), recorded. */
export function createReleaseTag(
  cwd: string,
  plan: ReleaseTagPlan,
  actor: LedgerActor,
): ForgeResult<void> {
  const tagged = git(cwd, [
    "tag",
    "-a",
    "--cleanup=verbatim",
    plan.tag,
    "-m",
    plan.changelog ? `${plan.tag}\n\n${plan.changelog}` : `Release ${plan.tag}`,
    plan.target,
  ]);
  if (!tagged.ok) return failure("failed", `git tag ${plan.tag} failed: ${gitError(tagged)}`);
  appendObserved(cwd, {
    type: "release.tagged",
    actor,
    version: plan.version,
    tag: plan.tag,
    head: plan.target,
    at: plan.at,
  });
  return success(undefined);
}

/**
 * After a refused push, delete the tag this run made while the remote
 * provably lacks it, so a rerun is not blocked by tag_exists.
 */
export function dropReleaseTag(cwd: string, plan: ReleaseTagPlan): boolean {
  const raw = pushUrl(cwd, plan.remote);
  if (raw) {
    const tip = remoteRefTip(cwd, raw, `refs/tags/${plan.tag}`);
    if (!tip.ok || tip.sha) return false;
  }
  return git(cwd, ["tag", "-d", plan.tag]).ok;
}

// ---------------------------------------------------------------------------
// the release workflow and the forge release

export type WorkflowRun = {
  id: number;
  name: string;
  state: "passing" | "failing" | "pending";
  url: string | null;
};

const FAILED_RUN = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "startup_failure",
  "action_required",
]);
const FAILED_PIPELINE = new Set(["failed", "canceled"]);
const PASSED_PIPELINE = new Set(["success", "skipped", "manual"]);

const project = (repo: string): string => `projects/${encodeURIComponent(repo)}`;
const encodeRef = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/** The CI runs the tag push started: GitHub Actions runs on the tag, GitLab tag pipelines. */
export function tagWorkflowRuns(resolved: ResolvedForge, tag: string): ForgeResult<WorkflowRun[]> {
  const { forge, runner } = resolved;
  if (forge.kind === "github") {
    type Runs = {
      workflow_runs?: Array<{
        id: number;
        name?: string | null;
        head_branch?: string | null;
        status?: string | null;
        conclusion?: string | null;
        html_url?: string | null;
      }>;
    };
    const read = apiJson<Runs>(
      runner,
      "gh",
      forge.apiHost,
      [
        "api",
        `repos/${forge.repo}/actions/runs?branch=${encodeURIComponent(tag)}&event=push&per_page=20`,
      ],
      `workflow runs on ${tag}`,
    );
    if (!read.ok) return read;
    return success(
      (read.data.workflow_runs ?? [])
        .filter((entry) => !entry.head_branch || entry.head_branch === tag)
        .map((entry) => ({
          id: entry.id,
          name: entry.name ?? `run ${entry.id}`,
          state:
            entry.status !== "completed"
              ? "pending"
              : FAILED_RUN.has(entry.conclusion ?? "")
                ? "failing"
                : "passing",
          url: entry.html_url ?? null,
        })),
    );
  }
  const read = apiJson<Array<{ id: number; status?: string; web_url?: string | null }>>(
    runner,
    "glab",
    forge.apiHost,
    ["api", `${project(forge.repo)}/pipelines?ref=${encodeURIComponent(tag)}&per_page=20`],
    `pipelines on ${tag}`,
  );
  if (!read.ok) return read;
  return success(
    read.data.map((entry) => ({
      id: entry.id,
      name: `pipeline ${entry.id}`,
      state: FAILED_PIPELINE.has(entry.status ?? "")
        ? "failing"
        : PASSED_PIPELINE.has(entry.status ?? "")
          ? "passing"
          : "pending",
      url: entry.web_url ?? null,
    })),
  );
}

export type ReleaseBody = { id: number | null; body: string; url: string | null };

/** A published release's body (GitHub body, GitLab description), or null when none exists. */
export function readReleaseBody(
  resolved: ResolvedForge,
  tag: string,
): ForgeResult<ReleaseBody | null> {
  const { forge, runner } = resolved;
  const read =
    forge.kind === "github"
      ? apiJson<{ id?: number; body?: string | null; html_url?: string | null }>(
          runner,
          "gh",
          forge.apiHost,
          ["api", `repos/${forge.repo}/releases/tags/${encodeRef(tag)}`],
          `release ${tag}`,
        )
      : apiJson<{ description?: string | null; _links?: { self?: string } }>(
          runner,
          "glab",
          forge.apiHost,
          ["api", `${project(forge.repo)}/releases/${encodeURIComponent(tag)}`],
          `release ${tag}`,
        );
  if (!read.ok) return read.code === "not_found" ? success(null) : read;
  const data = read.data as {
    id?: number;
    body?: string | null;
    description?: string | null;
    html_url?: string | null;
    _links?: { self?: string };
  };
  return success({
    id: data.id ?? null,
    body: data.body ?? data.description ?? "",
    url: data.html_url ?? data["_links"]?.self ?? null,
  });
}

/** Replace a published release's body; the body rides stdin (argv has a size limit). */
export function writeReleaseBody(
  resolved: ResolvedForge,
  tag: string,
  release: ReleaseBody,
  body: string,
): ForgeResult<void> {
  const { forge, runner } = resolved;
  if (forge.kind === "github" && release.id === null)
    return failure("failed", `the forge did not say which release ${tag} is (no id)`);
  const written =
    forge.kind === "github"
      ? apiWrite<unknown>(
          runner,
          "gh",
          forge.apiHost,
          ["api", "-X", "PATCH", `repos/${forge.repo}/releases/${release.id}`, "--input", "-"],
          `release ${tag}`,
          undefined,
          JSON.stringify({ body }),
        )
      : apiWrite<unknown>(
          runner,
          "glab",
          forge.apiHost,
          [
            "api",
            "-X",
            "PUT",
            `${project(forge.repo)}/releases/${encodeURIComponent(tag)}`,
            "--input",
            "-",
          ],
          `release ${tag}`,
          undefined,
          JSON.stringify({ description: body }),
        );
  return written.ok ? success(undefined) : written;
}

// ---------------------------------------------------------------------------
// notes edit --from-changelog

const START = (tag: string) => `<!-- workit:changelog ${tag} -->`;
const END = "<!-- /workit:changelog -->";

/** The changelog block a release body carries, between Workit's markers. */
export const changelogBlock = (tag: string, section: string): string =>
  `${START(tag)}\n${section.trim()}\n${END}`;

/**
 * The release body with `block` in place of the one between the markers, or
 * prepended when there is none. Running it again on its own output changes
 * nothing. A start marker without its end marker is refused: where the old
 * block ends is unknown, and prepending would leave two.
 */
export function mergeReleaseBody(
  existing: string,
  tag: string,
  block: string,
): ForgeResult<string> {
  const start = existing.indexOf(START(tag));
  if (start < 0) {
    const rest = existing.trim();
    return success(rest ? `${block}\n\n${rest}` : block);
  }
  const end = existing.indexOf(END, start);
  if (end < 0)
    return failure(
      "blocked",
      `release_body_unterminated: the body of release ${tag} has ${START(tag)} but no ${END} after it; nothing was edited`,
      `add ${END} where the old changelog block ends (or delete the start marker) in the release on the forge, then rerun: workit release notes edit ${tag} --from-changelog`,
    );
  return success(`${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`);
}

/**
 * The version's changelog section for an existing tag: at the tag's own
 * commit, else on the fetched remote trunk (a later changelog that gained the
 * section, a backfill). The remote's tag is fetched into a scratch ref, never
 * over a local tag: a local tag on another commit is refused, as is a fetch
 * that fails. Null without a section.
 */
export function tagChangelogSection(
  cwd: string,
  tag: string,
  version: string,
): ForgeResult<{ section: string; ref: string } | null> {
  const line = releaseLinesOf(cwd)[0];
  const remote = pushRemoteName(cwd, line.production);
  const own = `refs/tags/${tag}`;
  // Where to look, in order: the tag's commit, then the remote trunk.
  const refs: Array<{ rev: string; ref: string }> = [{ rev: own, ref: own }];
  if (remote) {
    const scratch = `refs/workit/release-tag/${tag}`;
    const trunk = `refs/remotes/${remote}/${line.production}`;
    const fetched = fetchRefs(cwd, remote, [
      `+refs/heads/${line.production}:${trunk}`,
      `+refs/tags/${tag}:${scratch}`,
    ]);
    const theirs = fetched.ok ? resolveRef(cwd, scratch) : null;
    git(cwd, ["update-ref", "-d", scratch]);
    if (!fetched.ok || !theirs)
      return failure(
        fetched.ok ? "not_found" : fetched.code,
        `could not fetch ${tag} and ${line.production} from ${remote}${fetched.ok ? "" : `: ${fetched.error}`}; nothing was edited`,
        `git ls-remote ${remote} refs/tags/${tag}  # the release's tag must be on ${remote}; then rerun: workit release notes edit ${tag} --from-changelog`,
      );
    const mine = resolveRef(cwd, own);
    if (mine && mine !== theirs)
      return failure(
        "blocked",
        `tag_differs: the local tag ${tag} is on ${mine.slice(0, 12)} but ${remote} has it on ${theirs.slice(0, 12)}; nothing was edited`,
        `git tag -d ${tag}  # the remote's tag is the published one; then rerun: workit release notes edit ${tag} --from-changelog`,
      );
    refs.splice(0, 1, { rev: theirs, ref: own }, { rev: trunk, ref: trunk });
  }
  for (const { rev, ref } of refs) {
    if (!resolveRef(cwd, rev)) continue;
    const section = changelogSection(cwd, rev, version);
    if (section) return success({ section, ref });
  }
  return success(null);
}
