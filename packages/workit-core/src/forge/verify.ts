// `workit verify-delivery` (design §2.1 S11): did the requested endpoint really
// happen? Each answer is an observation of the remote, never of local state:
// a local commit does not prove a push, a push does not prove a PR, and a
// "merged" claim needs the forge to say so.
//
//   pushed    the push remote's branch tip equals the expected SHA (ls-remote)
//   pr        the PR/MR exists, is open or merged, and its head is that SHA
//   merged    the forge reports the PR/MR merged; when workit merged it, the
//             recorded merge commit is reachable from the base's remote tip
//   released  the tag exists on the remote (pointing at --sha when given),
//             and the npm version is published (gitHead == the tag's commit)
//
// Read-only on the repository (fetches by object id move no ref). A delivered
// answer is appended to the ledger as an observed `delivery.verified` row.
import { spawnSync } from "node:child_process";
import {
  aheadBehind,
  currentBranch,
  fetchRefs,
  hasCommit,
  pushRemoteName,
  pushUrl,
  redactRemote,
  remoteNames,
  remoteRefTip,
  resolveRef,
} from "../git/rev";
import { appendObserved, readLedger, type LedgerActor } from "../ledger";
import { selectPr } from "./report";
import type { ResolvedForge } from "./resolve";
import { redactText } from "./redact";
import { failure, success, type ForgeResult } from "./types";

export type DeliveryEndpoint = "pushed" | "pr" | "merged" | "released";

export type Observation = {
  kind:
    | "remote_tip"
    | "pr_state"
    | "pr_head"
    | "merge_on_base"
    | "tag"
    | "npm_version"
    | "npm_git_head";
  expected: string | null;
  observed: string | null;
  ok: boolean;
  note?: string;
};

export type DeliveryReport = {
  expect: DeliveryEndpoint;
  branch: string | null;
  sha: string | null;
  pr: number | null;
  delivered: boolean;
  observations: Observation[];
  recorded?: { id: string } | { error: string };
};

/** Runs `npm view …` (injected in tests). */
export type NpmRunner = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export const systemNpm: NpmRunner = (args) => {
  const result = spawnSync("npm", [...args], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "(absent)");

function finish(
  cwd: string,
  report: Omit<DeliveryReport, "delivered">,
  actor: LedgerActor,
): DeliveryReport {
  const delivered =
    report.observations.length > 0 && report.observations.every((entry) => entry.ok);
  const out: DeliveryReport = { ...report, delivered };
  if (delivered) {
    const row = appendObserved(cwd, {
      type: "delivery.verified",
      actor,
      branch: report.branch,
      head: report.sha,
      ...(report.pr === null ? {} : { pr: report.pr }),
      expect: report.expect,
      observations: report.observations.map((entry) => ({
        kind: entry.kind,
        observed: entry.observed,
      })),
    });
    out.recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
  }
  return out;
}

/** The pushed-branch observation: remote tip vs the expected (default: local) SHA. */
export function verifyPushed(
  cwd: string,
  input: { branch?: string | null; sha?: string | null; actor: LedgerActor },
): ForgeResult<DeliveryReport> {
  const branch = input.branch ?? currentBranch(cwd);
  if (!branch) return failure("invalid_input", "HEAD is detached; pass --branch <name>");
  const sha = input.sha ?? resolveRef(cwd, `refs/heads/${branch}`);
  if (!sha) return failure("not_found", `branch ${branch} has no local commit; pass --sha <sha>`);
  const remote = pushRemoteName(cwd, branch);
  if (!remote) return failure("not_found", "no push remote is configured for this branch");
  const url = pushUrl(cwd, remote);
  if (!url) return failure("blocked", `remote "${remote}" has no single push URL`);
  const tip = remoteRefTip(cwd, url, `refs/heads/${branch}`);
  if (!tip.ok) return failure(tip.code, tip.error);
  const observation: Observation = {
    kind: "remote_tip",
    expected: sha,
    observed: tip.sha,
    ok: tip.sha !== null && tip.sha.startsWith(sha),
  };
  if (!observation.ok) {
    const counts = tip.sha && hasCommit(cwd, tip.sha) ? aheadBehind(cwd, tip.sha, sha) : null;
    observation.note =
      tip.sha === null
        ? `${branch} does not exist on ${redactRemote(url)}: nothing was pushed`
        : counts
          ? `${counts.ahead} local commit(s) not on ${remote}/${branch}${counts.behind ? `, ${counts.behind} remote commit(s) not local` : ""}`
          : `${remote}/${branch} is at ${short(tip.sha)}, expected ${short(sha)}`;
  }
  return success(
    finish(
      cwd,
      { expect: "pushed", branch, sha, pr: null, observations: [observation] },
      input.actor,
    ),
  );
}

/** The PR/MR exists, is open or merged, and its head is the expected SHA. */
export function verifyPr(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr?: number | null; branch?: string | null; sha?: string | null; actor: LedgerActor },
): ForgeResult<DeliveryReport> {
  const number = selectPr(cwd, resolved, { pr: input.pr ?? null, branch: input.branch ?? null });
  if (!number.ok) {
    if (number.code !== "not_found") return number;
    const branch = input.branch ?? currentBranch(cwd);
    return success(
      finish(
        cwd,
        {
          expect: "pr",
          branch,
          sha: input.sha ?? null,
          pr: null,
          observations: [
            { kind: "pr_state", expected: "open", observed: null, ok: false, note: number.error },
          ],
        },
        input.actor,
      ),
    );
  }
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  const pr = status.data;
  const sha = input.sha ?? resolveRef(cwd, `refs/heads/${pr.head.branch}`) ?? pr.head.sha;
  const observations: Observation[] = [
    { kind: "pr_state", expected: "open|merged", observed: pr.state, ok: pr.state !== "closed" },
    {
      kind: "pr_head",
      expected: sha,
      observed: pr.head.sha,
      ok: pr.head.sha.startsWith(sha),
      ...(pr.head.sha.startsWith(sha)
        ? {}
        : { note: `the PR head is ${short(pr.head.sha)}; push ${short(sha)} (workit git push)` }),
    },
  ];
  return success(
    finish(
      cwd,
      { expect: "pr", branch: pr.head.branch, sha, pr: pr.number, observations },
      input.actor,
    ),
  );
}

/** The forge reports the PR/MR merged, and a recorded merge commit is on the base. */
export function verifyMerged(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr?: number | null; branch?: string | null; actor: LedgerActor },
): ForgeResult<DeliveryReport> {
  const number = selectPr(cwd, resolved, { pr: input.pr ?? null, branch: input.branch ?? null });
  if (!number.ok) return number;
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  const pr = status.data;
  const observations: Observation[] = [
    { kind: "pr_state", expected: "merged", observed: pr.state, ok: pr.state === "merged" },
  ];
  if (pr.state === "merged") {
    const ledger = readLedger(cwd);
    const row = ledger.ok
      ? ledger.value.rows.findLast(
          (entry) =>
            entry.type === "pr.merged" && entry.pr === pr.number && entry.observer === "workit_cli",
        )
      : undefined;
    const mergeSha = typeof row?.mergeSha === "string" ? row.mergeSha : null;
    if (mergeSha) {
      const tip = remoteRefTip(cwd, resolved.baseRemote, `refs/heads/${pr.base}`);
      if (!tip.ok) return failure(tip.code, tip.error);
      let onBase = false;
      let note: string | undefined;
      if (tip.sha) {
        for (const sha of [mergeSha, tip.sha])
          if (!hasCommit(cwd, sha)) fetchRefs(cwd, resolved.baseRemote, [sha]);
        const counts =
          hasCommit(cwd, mergeSha) && hasCommit(cwd, tip.sha)
            ? aheadBehind(cwd, tip.sha, mergeSha)
            : null;
        onBase = counts !== null && counts.ahead === 0;
        if (!counts) note = "the merge commit or the base tip could not be fetched";
      } else note = `${pr.base} does not exist on the remote`;
      observations.push({
        kind: "merge_on_base",
        expected: mergeSha,
        observed: tip.sha,
        ok: onBase,
        ...(note
          ? { note }
          : onBase
            ? {}
            : { note: `${short(mergeSha)} is not reachable from ${pr.base}` }),
      });
    }
  }
  return success(
    finish(
      cwd,
      { expect: "merged", branch: pr.head.branch, sha: pr.head.sha, pr: pr.number, observations },
      input.actor,
    ),
  );
}

/** `@scope/name@1.2.3` → name + version (version may be absent). */
export function parsePackageSpec(spec: string): { name: string; version: string | null } | null {
  const value = spec.trim();
  if (!value || value.startsWith("-")) return null;
  const at = value.lastIndexOf("@");
  if (at > 0) return { name: value.slice(0, at), version: value.slice(at + 1) || null };
  return { name: value, version: null };
}

type NpmView = { version?: unknown; gitHead?: unknown };

const npmView = (stdout: string): NpmView | null => {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const value = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    return value && typeof value === "object" ? (value as NpmView) : null;
  } catch {
    return null;
  }
};

export function verifyReleased(
  cwd: string,
  input: { tag?: string | null; pkg?: string | null; sha?: string | null; actor: LedgerActor },
  npm: NpmRunner = systemNpm,
): ForgeResult<DeliveryReport> {
  if (!input.tag && !input.pkg)
    return failure("invalid_input", "released needs --tag <tag> and/or --package <name[@version]>");
  const observations: Observation[] = [];
  let tagSha: string | null = null;
  if (input.tag) {
    if (input.tag.startsWith("-")) return failure("invalid_input", "--tag must not start with -");
    const remote = remoteNames(cwd).includes("origin") ? "origin" : pushRemoteName(cwd);
    if (!remote) return failure("not_found", "no remote is configured");
    const tip = remoteRefTip(cwd, remote, `refs/tags/${input.tag}`);
    if (!tip.ok) return failure(tip.code, tip.error);
    tagSha = tip.sha;
    const expected = input.sha ?? null;
    observations.push({
      kind: "tag",
      expected: expected ?? input.tag,
      observed: tip.sha,
      ok: tip.sha !== null && (expected === null || tip.sha.startsWith(expected)),
      ...(tip.sha === null ? { note: `tag ${input.tag} is not on ${remote}` } : {}),
    });
  }
  if (input.pkg) {
    const spec = parsePackageSpec(input.pkg);
    if (!spec) return failure("invalid_input", "--package must be <name> or <name>@<version>");
    const version = spec.version ?? (input.tag ? input.tag.replace(/^v(?=\d)/u, "") : null);
    if (!version)
      return failure("invalid_input", "--package needs a version (<name>@<version>) or --tag");
    const viewed = npm(["view", `${spec.name}@${version}`, "version", "gitHead", "--json"]);
    if (
      viewed.status !== 0 &&
      !/E404|404 Not Found|is not in this registry|No match found/iu.test(viewed.stderr)
    )
      return failure(
        "unavailable",
        `npm view ${spec.name}@${version} failed: ${redactText(viewed.stderr).trim().split("\n")[0]?.slice(0, 200) ?? ""}`,
      );
    const observed = viewed.status === 0 ? npmView(viewed.stdout) : null;
    const observedVersion = typeof observed?.version === "string" ? observed.version : null;
    observations.push({
      kind: "npm_version",
      expected: `${spec.name}@${version}`,
      observed: observedVersion ? `${spec.name}@${observedVersion}` : null,
      ok: observedVersion === version,
      ...(observedVersion === version ? {} : { note: `${spec.name}@${version} is not published` }),
    });
    const gitHead = typeof observed?.gitHead === "string" ? observed.gitHead : null;
    if (gitHead && tagSha)
      observations.push({
        kind: "npm_git_head",
        expected: tagSha,
        observed: gitHead,
        ok: gitHead === tagSha,
      });
  }
  return success(
    finish(
      cwd,
      {
        expect: "released",
        branch: null,
        sha: tagSha ?? input.sha ?? null,
        pr: null,
        observations,
      },
      input.actor,
    ),
  );
}
