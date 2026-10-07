// Shared plumbing for the forge verbs (`pr`, `ci`, `git push`, `verify-delivery`):
// flag parsing, forge resolution + identity check, envelope mapping, and the
// human rendering of a PR status document.
import type { ForgeRunner } from "@brainervirus/workit-core/src/forge/exec";
import type { PrStatusDoc } from "@brainervirus/workit-core/src/forge/report";
import {
  checkIdentity,
  resolveForge,
  type ResolvedForge,
} from "@brainervirus/workit-core/src/forge/resolve";
import type { ForgeResult } from "@brainervirus/workit-core/src/forge/types";
import type { NpmRunner } from "@brainervirus/workit-core/src/forge/verify";
import { vcsConfig } from "@brainervirus/workit-core/src/core/vcs-config";
export { parseDuration } from "@brainervirus/workit-core/src/duration";
import { emit, fail, type Io } from "../output";

/** Test seams: a recorded-fixture runner, a virtual clock and a fake npm. */
export const forgeDeps: {
  runner: ForgeRunner | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  npm: NpmRunner | undefined;
} = {
  runner: undefined,
  npm: undefined,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export type FlagSpec = Record<string, "value" | "boolean" | "list">;

export type ParsedFlags = {
  values: Record<string, string>;
  booleans: Set<string>;
  lists: Record<string, string[]>;
  positionals: string[];
};

/** `--name value`, `--name=value`, booleans, repeatable lists; unknown flags are errors. */
export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags | string {
  const parsed: ParsedFlags = { values: {}, booleans: new Set(), lists: {}, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") continue;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (!kind) return `unknown option --${name}`;
    if (kind === "boolean") {
      if (eq >= 0) return `--${name} takes no value`;
      parsed.booleans.add(name);
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--")))
      return `--${name} requires a value`;
    if (kind === "list") (parsed.lists[name] ??= []).push(value);
    else parsed.values[name] = value;
  }
  return parsed;
}

const MAX_REASON = 500;

/** `--unverified --reason <why>`: the reason is required with it and only valid with it. */
export function unverifiedFlag(flags: ParsedFlags): { reason: string } | null | string {
  const reason = flags.values.reason?.trim();
  if (!flags.booleans.has("unverified"))
    return reason === undefined ? null : "--reason is only used with --unverified";
  if (!reason) return "--unverified needs --reason <why the user asked for it>";
  return reason.length > MAX_REASON ? `--reason is capped at ${MAX_REASON} characters` : { reason };
}

export function positiveInt(value: string | undefined, flag: string): number | null | string {
  if (value === undefined) return null;
  return /^[1-9]\d{0,8}$/u.test(value) ? Number(value) : `${flag} must be a positive integer`;
}

/**
 * The release track's PR target when tracks are configured (core vcsConfig),
 * for `branch` or the checkout. A track problem (an unknown --track, a
 * critical field, an undetermined line) is an error, never a silent fall back
 * to `main`; a broken vcs.json keeps the legacy fallback. `tracked` says
 * whether release tracks decided the trunk.
 */
export function releaseTrunk(
  io: Io,
  track: string | null,
  branch: string | null,
): { trunk: string | null; tracked: boolean } | { error: string } {
  const resolved = vcsConfig("resolve", io.cwd, {
    track,
    ...(branch ? { branch } : {}),
  });
  if (resolved.ok === false)
    return track !== null || String(resolved.configPath ?? "").endsWith("workspaces.json")
      ? { error: String(resolved.error) }
      : { trunk: null, tracked: false };
  if (resolved.releaseTrack?.blocking) return { error: String(resolved.releaseTrack.blocking) };
  return {
    trunk: String(resolved.defaultTargetBranch ?? "") || null,
    tracked: Boolean(resolved.releaseTrack),
  };
}

export const usage = (io: Io, message: string, line: string): number =>
  emit(io, fail("invalid_input", message, { unblock: line }));

export const forgeFail = (
  io: Io,
  result: Extract<ForgeResult<unknown>, { ok: false }>,
  data?: Record<string, unknown>,
): number => emit(io, fail(result.code, result.error, { data, unblock: result.unblock }));

/** Resolve the forge from the push remote and verify the effective account. */
export function connect(
  io: Io,
  branch?: string | null,
): ForgeResult<ResolvedForge & { identity: NonNullable<PrStatusDoc["identity"]> }> {
  const resolved = resolveForge(io.cwd, {
    branch,
    env: io.env,
    runner: forgeDeps.runner,
    now: forgeDeps.now,
  });
  if (!resolved.ok) return resolved;
  const identity = checkIdentity(resolved.data);
  if (!identity.ok) return identity;
  return {
    ok: true,
    data: {
      ...resolved.data,
      identity: {
        login: identity.data.login,
        credential: resolved.data.credential,
        ...(identity.data.note ? { note: identity.data.note } : {}),
      },
    },
  };
}

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "?");

export function renderStatus(doc: PrStatusDoc): string[] {
  const noun = doc.forge === "github" ? `PR #${doc.number}` : `MR !${doc.number}`;
  const lines = [
    `${noun} ${doc.state}${doc.draft ? " (draft)" : ""}: ${doc.headRepo ? `${doc.headRepo}:` : ""}${doc.head.branch} -> ${doc.base}  ${doc.url}`,
  ];
  const local =
    doc.head.localSha === null
      ? "not checked out"
      : doc.head.pushed
        ? "local matches"
        : `local ${short(doc.head.localSha)} differs`;
  lines.push(`head ${short(doc.head.sha)} (${local})`);
  const behind = doc.behindBase;
  const behindText = !behind
    ? ""
    : behind.behind === null
      ? ` · behind ${doc.base}: unknown (${behind.error ?? "unavailable"})`
      : ` · behind ${doc.base}: ${behind.behind}, ahead ${behind.ahead}`;
  lines.push(
    `mergeable ${doc.mergeable} · conflicts ${doc.conflicts ? "yes" : "no"}${doc.rebaseRequired ? " · rebase required" : ""}${behindText}`,
  );
  const checks = doc.checks;
  lines.push(
    `checks ${checks.state}: ${checks.failing.length} failing, ${checks.pending.length} pending, ${checks.passing} passing`,
  );
  for (const check of checks.failing) {
    lines.push(
      `  x ${check.name} (${check.conclusion ?? "failed"}${check.required === false ? ", optional" : ""})${check.rerunsOnHead ? ` [rerun ${check.rerunsOnHead}x on this head]` : ""}${check.url ? `  ${check.url}` : ""}`,
    );
    for (const value of check.logTail) lines.push(`      ${value}`);
    if (check.logError) lines.push(`      (log unavailable: ${check.logError})`);
  }
  if (checks.pending.length) lines.push(`  pending: ${checks.pending.join(", ")}`);
  if (checks.missingRequired === null)
    lines.push("  required checks: unknown (branch protection not readable)");
  else if (checks.missingRequired.length)
    lines.push(`  required, not reported yet: ${checks.missingRequired.join(", ")}`);
  const threads = doc.reviews.unresolvedThreads;
  lines.push(
    `reviews ${doc.reviews.decision ?? "none"} · ${threads.length} unresolved thread${threads.length === 1 ? "" : "s"}`,
  );
  for (const thread of threads)
    lines.push(
      `  - ${thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""} ` : ""}@${thread.author ?? "?"}${thread.isBot ? " (bot)" : ""}: ${thread.body}`,
    );
  if (doc.truncated) lines.push("(lists truncated at the page cap)");
  if (doc.blockers.length) lines.push(`blockers: ${doc.blockers.join(", ")}`);
  if (doc.identity?.note) lines.push(`identity: ${doc.identity.note}`);
  if (doc.babysit) lines.push(`babysit: ${doc.babysit}`);
  lines.push(`next: ${doc.next}`);
  return lines;
}
