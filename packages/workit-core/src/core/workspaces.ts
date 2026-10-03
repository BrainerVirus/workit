import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  COMMIT_PRESETS,
  PRESETS,
  configDir,
  isConfigObject,
  resolveBranchPolicy as resolveConfiguredBranchPolicy,
  resolveCommitPolicy as resolveConfiguredCommitPolicy,
  type BranchPreset,
  type ToolkitConfig,
} from "./config";
import type { CommitFlavorPreset } from "./commit-flavors";

export type VcsProvider = "gitlab" | "github";

export type IntegrationMode = "pr" | "merge";

const nonBlank = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const branchPreset = z.custom<BranchPreset>(
  (value) => typeof value === "string" && Object.hasOwn(PRESETS, value),
  "unsupported branch preset",
);
const commitPreset = z.custom<CommitFlavorPreset>(
  (value) => typeof value === "string" && COMMIT_PRESETS.includes(value),
  "unsupported commit preset",
);
const workspaceBranchPolicySchema = z
  .object({
    preset: branchPreset,
    developBranch: nonBlank.optional(),
    prefixes: z
      .object({
        feature: nonBlank,
        bugfix: nonBlank,
        release: nonBlank,
        hotfix: nonBlank,
      })
      .passthrough()
      .optional(),
    allowed: z.array(nonBlank).optional(),
    protected: z.array(nonBlank).optional(),
    integration: z.enum(["pr", "merge"]).optional(),
  })
  .strict();
const workspaceCommitPolicySchema = z
  .object({ preset: commitPreset, pattern: z.string().optional() })
  .strict();
const workspaceProfileSchema = z
  .object({
    branchPolicy: workspaceBranchPolicySchema.optional(),
    commitPolicy: workspaceCommitPolicySchema.optional(),
  })
  .strict()
  .refine((profile) => profile.branchPolicy !== undefined || profile.commitPolicy !== undefined, {
    message: "a profile must define branchPolicy or commitPolicy",
  });
const versionSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("package-json"),
      path: nonBlank,
      field: nonBlank,
    })
    .strict(),
  z.object({ kind: z.literal("git-tag") }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);
const releaseTrackSchema = z
  .object({
    strategy: branchPreset,
    productionBranch: nonBlank,
    integrationBranch: nonBlank,
    naming: z.object({ feature: nonBlank, release: nonBlank, hotfix: nonBlank }).strict(),
    baseBranch: nonBlank,
    mergeBackBranches: z.array(nonBlank),
    pullRequestTarget: nonBlank,
    tagNamespace: z.string(),
    versionSource: versionSourceSchema,
    requiredChecks: z.array(nonBlank),
  })
  .strict()
  .superRefine((track, context) => {
    for (const [field, values] of [
      ["mergeBackBranches", track.mergeBackBranches],
      ["requiredChecks", track.requiredChecks],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [field], message: "entries must be unique" });
      }
    }
    if (
      track.versionSource.kind === "package-json" &&
      (path.posix.isAbsolute(track.versionSource.path.replaceAll("\\", "/")) ||
        /^[A-Za-z]:\//u.test(track.versionSource.path.replaceAll("\\", "/")) ||
        track.versionSource.path.replaceAll("\\", "/").split("/").includes(".."))
    ) {
      context.addIssue({
        code: "custom",
        path: ["versionSource", "path"],
        message: "must stay inside the repository",
      });
    }
  });
const workspaceConfigSchema = z
  .object({
    name: nonBlank,
    glob: nonBlank,
    vcs: z
      .object({
        provider: z.enum(["gitlab", "github"]),
        defaultTargetBranch: nonBlank.optional(),
        tokenFile: nonBlank.optional(),
        account: nonBlank.optional(),
      })
      .passthrough()
      .optional(),
    autoApprove: z.union([z.boolean(), z.array(nonBlank)]).optional(),
    youtrack: z
      .object({ baseUrl: nonBlank.optional(), link_issues: z.boolean().optional() })
      .passthrough()
      .optional(),
    issues: z
      .object({ provider: z.literal("github").optional(), link_on_pr: z.boolean().optional() })
      .passthrough()
      .optional(),
    branchPolicy: workspaceBranchPolicySchema.optional(),
    commitPolicy: workspaceCommitPolicySchema.optional(),
    defaultProfile: nonBlank.optional(),
    profiles: z.record(nonBlank, workspaceProfileSchema).optional(),
    releaseTracks: z.record(nonBlank, releaseTrackSchema).optional(),
  })
  .passthrough()
  .superRefine((workspace, context) => {
    if (workspace.issues && workspace.vcs?.provider !== "github") {
      context.addIssue({
        code: "custom",
        path: ["issues"],
        message: `GitHub issue linking requires the github provider, got ${workspace.vcs?.provider ?? "unset"}`,
      });
    }
    if (
      workspace.defaultProfile !== undefined &&
      !Object.hasOwn(workspace.profiles ?? {}, workspace.defaultProfile)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `does not name a configured profile`,
      });
    }
  });
const workspacesFileSchema = z
  .object({ workspaces: z.array(workspaceConfigSchema).optional() })
  .passthrough()
  .superRefine((file, context) => {
    const names = new Set<string>();
    for (const [index, workspace] of (file.workspaces ?? []).entries()) {
      if (names.has(workspace.name)) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "name"],
          message: `duplicate workspace name ${JSON.stringify(workspace.name)}`,
        });
      }
      names.add(workspace.name);
    }
  });

export type WorkspaceBranchPolicy = z.infer<typeof workspaceBranchPolicySchema>;
export type WorkspaceCommitPolicy = z.infer<typeof workspaceCommitPolicySchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
export type ReleaseTrack = z.infer<typeof releaseTrackSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export type WorkspaceProfileResolution =
  | {
      status: "resolved";
      profileName: string | null;
      workspace: WorkspaceConfig;
      provenance: { branchPolicy: string; commitPolicy: string };
    }
  | { status: "invalid"; error: string };

export type ReleaseTrackSelection =
  | { status: "selected"; name: string; track: ReleaseTrack }
  | { status: "not_configured" }
  | { status: "choice_required"; choices: string[] }
  | { status: "invalid"; error: string };

export type WorkspacePolicyResolution = {
  status: "resolved";
  workspace: WorkspaceConfig | null;
  profileName: string | null;
  branchPolicy: ReturnType<typeof resolveConfiguredBranchPolicy>;
  commitPolicy: ReturnType<typeof resolveConfiguredCommitPolicy>;
  provenance: { branchPolicy: string; commitPolicy: string };
};

export const workspacesPath = (): string => path.join(configDir(), "workspaces.json");

// RL-01: typed workspaces reader. Missing is a legitimate unconfigured state
// (empty list); malformed JSON is reported with the exact path so risky
// consumers (wizard/installer/doctor) can block instead of silently resetting.
export type WorkspacesResult = {
  status: "missing" | "valid" | "malformed" | "invalid";
  path: string;
  entries: WorkspaceConfig[];
  document?: Record<string, unknown>;
  revision?: string;
  error?: string;
};

export const workspacesRevision = (contents: string | null): string =>
  createHash("sha256")
    .update(contents ?? "<missing>")
    .digest("hex");

export const validateWorkspacesDocument = (parsed: unknown, file: string): WorkspacesResult => {
  if (!isConfigObject(parsed)) {
    return { status: "malformed", path: file, entries: [], error: `${file} is not a JSON object` };
  }
  const validated = workspacesFileSchema.safeParse(parsed, { reportInput: true });
  if (!validated.success) {
    const detail = validated.error.issues
      .map((issue) => {
        const field = String(issue.path[issue.path.length - 1] ?? "");
        const attempted =
          ["provider", "preset", "strategy"].includes(field) && typeof issue.input === "string"
            ? ` (${JSON.stringify(issue.input)})`
            : "";
        return `${issue.path.map(String).join(".") || "workspaces"}: ${issue.message}${attempted}`;
      })
      .join("; ");
    return {
      status: "invalid",
      path: file,
      entries: [],
      error: `${file} has invalid workspace configuration: ${detail}`,
    };
  }
  for (const [index, workspace] of (validated.data.workspaces ?? []).entries()) {
    const glob = validateWorkspaceGlob(workspace.glob);
    if (!glob.ok) {
      return {
        status: "invalid",
        path: file,
        entries: [],
        error: `${file} workspaces.${index}.glob: ${glob.error}`,
      };
    }
  }
  return {
    status: "valid",
    path: file,
    entries: validated.data.workspaces ?? [],
    document: parsed as Record<string, unknown>,
  };
};

export const readWorkspacesResult = (dir: string = configDir()): WorkspacesResult => {
  const file = path.join(dir, "workspaces.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing", path: file, entries: [], revision: workspacesRevision(null) };
    return {
      status: "malformed",
      path: file,
      entries: [],
      error: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "malformed",
      path: file,
      entries: [],
      revision: workspacesRevision(raw),
      error: `${file} is not valid JSON`,
    };
  }
  return { ...validateWorkspacesDocument(parsed, file), revision: workspacesRevision(raw) };
};

/** Parse the workspaces.json list under an explicit config dir; [] when missing/malformed. */
export const loadWorkspacesFrom = (dir: string): WorkspaceConfig[] =>
  readWorkspacesResult(dir).entries;

// ponytail: only globstar (`**`) is supported; if more minimatch parity is needed
// (char classes, braces, `?`), swap this matcher for the minimatch dependency.
const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // **/ matches zero or more segments; a leading **/ also consumes the leading slash
          if (out === "") out += "/?";
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          // trailing ** also matches the bare parent: /x/y/** -> /x/y and /x/y/deep.
          // (?:/.*)? only when the prefix ends with / (POSIX absolute); otherwise
          // the trailing ** must match any remainder, e.g. a bare ** against a
          // drive-letter cwd like D:/a/x.
          if (i + 2 >= glob.length) {
            if (out.endsWith("/")) {
              out = out.slice(0, -1);
              out += "(?:/.*)?";
            } else {
              out += ".*";
            }
          } else {
            out += ".*";
          }
          i++;
        }
      } else {
        out += "[^/]*";
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
};

/** Shared authoritative workspace matcher (WZ-12): the wizard's pattern
 *  preview and resolveWorkspaceFrom both route through it. */
export const matchWorkspace = (glob: string, target: string): boolean =>
  globToRegExp(glob.replaceAll("\\", "/")).test(target.replaceAll("\\", "/"));

// RL-08: the matcher above implements `*` and `**` only. Classic glob
// metacharacters it would otherwise store as literals (char classes, `?`,
// brace expansion) are rejected at write time so a saved pattern never
// silently matches nothing (Task 15 advisory: unsupported patterns were
// accepted and shown as "no match").
const UNSUPPORTED_GLOB = /[?[\]{}]/;

// B3: `!`-negation and extglob prefixes (@(...), +(...), *(...)) are the same
// no-match trap — the matcher stores them as literals, so `!**` or `@(a|b)`
// silently matches nothing. Reject them at write time too; the Task 15 match
// preview still routes through matchWorkspace (literals -> no match) and is
// unchanged.
const UNSUPPORTED_EXTGLOB = /[@+*]\(|!/;

export type GlobValidation = { ok: true } | { ok: false; error: string };

export const validateWorkspaceGlob = (glob: string): GlobValidation => {
  const trimmed = glob.trim();
  if (!trimmed) return { ok: false, error: "workspace pattern is required" };
  const m = UNSUPPORTED_GLOB.exec(trimmed);
  if (m) {
    return {
      ok: false,
      error: `unsupported glob character ${JSON.stringify(m[0])} in workspace pattern ${JSON.stringify(glob)} — the matcher supports * and ** only (e.g. /work/**)`,
    };
  }
  const ext = UNSUPPORTED_EXTGLOB.exec(trimmed);
  if (ext) {
    const token = ext[0];
    const kind = token === "!" ? "negation (!)" : `extglob (${token})`;
    return {
      ok: false,
      error: `unsupported glob ${kind} in workspace pattern ${JSON.stringify(glob)} — the matcher supports * and ** only (e.g. /work/**)`,
    };
  }
  return { ok: true };
};

const realpathOf = (p: string): string => {
  // realpathSync.native goes through libuv, which expands Windows 8.3 short
  // names (C:\Users\RUNNER~1 -> C:\Users\runneradmin); the plain realpathSync
  // keeps them, so a git-derived long path would miss a glob written with the
  // short form (GitHub runner TMP uses the short name).
  const real = realpathSync.native ?? realpathSync;
  try {
    return real(p);
  } catch {
    return p;
  }
};

// Rebuild a glob with the realpath of its static prefix, so a config glob
// written with the logical path also matches a canonical target (and vice
// versa). The glob metacharacters themselves are left untouched.
const canonicalGlob = (glob: string): string => {
  const m = /[*?[\]{]/.exec(glob);
  const prefix = m ? glob.slice(0, m.index) : glob;
  const rest = m ? glob.slice(m.index) : "";
  if (!prefix) return glob;
  const real = realpathOf(prefix.replace(/\/+$/, "") || "/");
  return real + (prefix.endsWith("/") ? "/" : "") + rest;
};

const globSpecificity = (glob: string): number =>
  glob
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && !/[*?[\]{]/.test(segment)).length;

const selectWorkspaceMatch = <T extends { name: string; glob: string }>(
  matches: T[],
  cwd: string,
  workspaceName?: string,
): T | undefined => {
  if (workspaceName !== undefined) {
    const named = matches.filter((entry) => entry.name === workspaceName);
    if (named.length === 1) return named[0];
    if (named.length > 1)
      throw new Error(`ambiguous workspace ${JSON.stringify(workspaceName)} for ${cwd}`);
    if (matches.length > 0) {
      throw new Error(
        `workspace ${JSON.stringify(workspaceName)} does not match ${cwd}; matching choices: ${matches.map((entry) => entry.name).join(", ")}`,
      );
    }
    throw new Error(`workspace ${JSON.stringify(workspaceName)} does not match ${cwd}`);
  }

  if (matches.length < 2) return matches[0];
  const highestSpecificity = Math.max(...matches.map((entry) => globSpecificity(entry.glob)));
  const mostSpecific = matches.filter(
    (entry) => globSpecificity(entry.glob) === highestSpecificity,
  );
  if (mostSpecific.length > 1) {
    throw new Error(
      `ambiguous workspace for ${cwd}; choose one of: ${mostSpecific.map((entry) => entry.name).join(", ")}`,
    );
  }
  return mostSpecific[0];
};

/** Shared pure workspace matcher for draft previews and disk-backed resolution. */
export const resolveWorkspaceFromEntries = <T extends { name: string; glob: string }>(
  cwd: string,
  entries: readonly T[],
  workspaceName?: string,
): T | null => {
  // macOS/Windows tmpdir symlinks (/var -> /private/var): git's
  // --show-toplevel returns the realpath while config globs are usually
  // written with the logical path, so a workspace would silently stop
  // matching on macOS. Match both forms on each side; on Linux both forms
  // are identical so behavior is unchanged.
  const targets = [cwd, realpathOf(cwd)].map((p) => p.replaceAll("\\", "/"));
  const matches: T[] = [];
  for (const ws of entries) {
    const glob = ws.glob.replaceAll("\\", "/");
    const canonical = canonicalGlob(glob);
    let matched = false;
    for (const target of targets) {
      if (
        matchWorkspace(glob, target) ||
        (canonical !== glob && matchWorkspace(canonical, target))
      ) {
        matched = true;
        break;
      }
    }
    if (matched) matches.push(ws);
  }
  return selectWorkspaceMatch(matches, cwd, workspaceName) ?? null;
};

/** Match a cwd against the workspaces.json under an explicit config dir. */
export const resolveWorkspaceFrom = (
  cwd: string,
  dir: string,
  workspaceName?: string,
): WorkspaceConfig | null => {
  const result = readWorkspacesResult(dir);
  if (result.status === "malformed" || result.status === "invalid") throw new Error(result.error);
  return resolveWorkspaceFromEntries(cwd, result.entries, workspaceName);
};

export const resolveWorkspace = (
  cwd: string,
  workspaceName = process.env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
): WorkspaceConfig | null => resolveWorkspaceFrom(cwd, configDir(), workspaceName);

type RuntimeWorkspacePolicy = "branch" | "commit" | "vcs";
type RuntimeWorkspaceCandidate = {
  name: string;
  glob: string;
  defaultProfile?: string;
  profiles?: Record<string, Record<string, unknown>>;
  branchPolicy?: WorkspaceBranchPolicy;
  commitPolicy?: WorkspaceCommitPolicy;
  vcs?: WorkspaceConfig["vcs"];
  youtrack?: unknown;
  issues?: unknown;
};

const runtimeWorkspacePolicySchema = (kind: RuntimeWorkspacePolicy) => {
  const key = kind === "branch" ? "branchPolicy" : kind === "commit" ? "commitPolicy" : "vcs";
  const policySchema =
    kind === "branch"
      ? workspaceBranchPolicySchema
      : kind === "commit"
        ? workspaceCommitPolicySchema
        : z
            .object({
              provider: z.enum(["gitlab", "github"]),
              defaultTargetBranch: nonBlank.optional(),
              account: nonBlank.optional(),
            })
            .passthrough();
  const profileSchema = z.object({ [key]: policySchema.optional() }).passthrough();
  const entrySchema = z
    .object({
      name: nonBlank,
      glob: nonBlank,
      [key]: policySchema.optional(),
      defaultProfile: nonBlank.optional(),
      profiles: z.record(nonBlank, profileSchema).optional(),
    })
    .passthrough();
  return entrySchema;
};

export type RuntimeWorkspaceVcs = Pick<
  RuntimeWorkspaceCandidate,
  "name" | "branchPolicy" | "vcs" | "youtrack" | "issues"
>;

export const resolveRuntimeWorkspaceVcs = (cwd: string): RuntimeWorkspaceVcs | null =>
  resolveRuntimeWorkspaceCandidate(cwd, "vcs");

const runtimeWorkspaceIndexSchema = z
  .object({
    workspaces: z.array(z.object({ name: nonBlank, glob: nonBlank }).passthrough()).optional(),
  })
  .passthrough();

const resolveRuntimeWorkspaceCandidate = (
  cwd: string,
  kind: RuntimeWorkspacePolicy,
): RuntimeWorkspaceCandidate | null => {
  const file = path.join(configDir(), "workspaces.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const validated = runtimeWorkspaceIndexSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "workspaces"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${file} has invalid workspace matching data: ${detail}`);
  }
  const entries = validated.data.workspaces;
  for (const entry of entries ?? []) {
    const glob = validateWorkspaceGlob(entry.glob);
    if (!glob.ok) throw new Error(`${file} workspace ${entry.name}: ${glob.error}`);
  }
  const targets = [cwd, realpathOf(cwd)].map((value) => value.replaceAll("\\", "/"));
  const matches = (entries ?? []).filter((entry) => {
    const glob = entry.glob.replaceAll("\\", "/");
    const canonical = canonicalGlob(glob);
    return targets.some(
      (target) =>
        matchWorkspace(glob, target) || (canonical !== glob && matchWorkspace(canonical, target)),
    );
  });
  const workspaceName = process.env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined;
  const selected = selectWorkspaceMatch(matches, cwd, workspaceName);
  if (!selected) return null;
  const policy = runtimeWorkspacePolicySchema(kind).safeParse(selected);
  if (!policy.success) {
    const detail = policy.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "workspace"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${file} has invalid ${kind} policy configuration: ${detail}`);
  }
  return policy.data as RuntimeWorkspaceCandidate;
};

export const resolveRuntimeWorkspacePolicy = (
  cwd: string,
  kind: RuntimeWorkspacePolicy,
  requestedProfile?: string,
): {
  policy: WorkspaceBranchPolicy | WorkspaceCommitPolicy | undefined;
  source: string;
} => {
  const candidate = resolveRuntimeWorkspaceCandidate(cwd, kind);
  if (!candidate) return { policy: undefined, source: "user-default" };
  const key = kind === "branch" ? "branchPolicy" : "commitPolicy";
  const profileName = requestedProfile?.trim() || candidate.defaultProfile;
  if (
    candidate.defaultProfile &&
    !Object.hasOwn(candidate.profiles ?? {}, candidate.defaultProfile)
  )
    throw new Error(
      `workspace ${JSON.stringify(candidate.name)} has no profile ${JSON.stringify(candidate.defaultProfile)}`,
    );
  const profile = profileName ? candidate.profiles?.[profileName] : undefined;
  if (profileName && !profile)
    throw new Error(
      `workspace ${JSON.stringify(candidate.name)} has no profile ${JSON.stringify(profileName)}`,
    );
  const profilePolicy = profile?.[key] as WorkspaceBranchPolicy | WorkspaceCommitPolicy | undefined;
  const workspacePolicy = candidate[key];
  return {
    policy: profilePolicy ?? workspacePolicy,
    source: profilePolicy
      ? `profile:${profileName}`
      : workspacePolicy
        ? `workspace:${candidate.name}`
        : "user-default",
  };
};

export const resolveWorkspaceProfile = (
  workspace: WorkspaceConfig,
  requestedProfile?: string,
): WorkspaceProfileResolution => {
  const profileName = requestedProfile ?? workspace.defaultProfile ?? null;
  const profile = profileName ? workspace.profiles?.[profileName] : undefined;
  if (profileName && !profile) {
    return {
      status: "invalid",
      error: `workspace ${JSON.stringify(workspace.name)} has no profile ${JSON.stringify(profileName)}`,
    };
  }
  const effectiveWorkspace = profile
    ? {
        ...workspace,
        ...(profile.branchPolicy ? { branchPolicy: profile.branchPolicy } : {}),
        ...(profile.commitPolicy ? { commitPolicy: profile.commitPolicy } : {}),
      }
    : workspace;
  return {
    status: "resolved",
    profileName,
    workspace: effectiveWorkspace,
    provenance: {
      branchPolicy: profile?.branchPolicy
        ? `profile:${profileName}`
        : workspace.branchPolicy
          ? `workspace:${workspace.name}`
          : "user-default",
      commitPolicy: profile?.commitPolicy
        ? `profile:${profileName}`
        : workspace.commitPolicy
          ? `workspace:${workspace.name}`
          : "user-default",
    },
  };
};

export const resolveWorkspacePolicy = (
  config: ToolkitConfig,
  workspace: WorkspaceConfig | null,
  profileName?: string,
): WorkspacePolicyResolution | { status: "invalid"; error: string } => {
  const selected = workspace
    ? resolveWorkspaceProfile(workspace, profileName)
    : {
        status: "resolved" as const,
        profileName: null,
        workspace: null,
        provenance: { branchPolicy: "user-default", commitPolicy: "user-default" },
      };
  if (selected.status === "invalid") return selected;
  return {
    status: "resolved",
    workspace: selected.workspace,
    profileName: selected.profileName,
    branchPolicy: resolveConfiguredBranchPolicy(config, selected.workspace),
    commitPolicy: resolveConfiguredCommitPolicy(config, selected.workspace),
    provenance: selected.provenance,
  };
};

export const selectReleaseTrack = (
  workspace: WorkspaceConfig,
  requestedTrack?: string,
): ReleaseTrackSelection => {
  const tracks = workspace.releaseTracks ?? {};
  const choices = Object.keys(tracks).toSorted();
  if (requestedTrack === undefined) {
    if (choices.length === 0) return { status: "not_configured" };
    if (choices.length > 1) return { status: "choice_required", choices };
    const name = choices[0];
    return { status: "selected", name, track: tracks[name] };
  }
  if (!Object.hasOwn(tracks, requestedTrack)) {
    return {
      status: "invalid",
      error: `workspace ${JSON.stringify(workspace.name)} has no release track ${JSON.stringify(requestedTrack)}`,
    };
  }
  return { status: "selected", name: requestedTrack, track: tracks[requestedTrack] };
};
