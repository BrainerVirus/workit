import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import * as z from "./zod-mini";
import {
  COMMIT_PRESETS,
  PRESETS,
  configDir,
  isConfigObject,
  readConfig,
  resolveBranchPolicy as resolveConfiguredBranchPolicy,
  resolveCommitPolicy as resolveConfiguredCommitPolicy,
  type BranchPreset,
  type ToolkitConfig,
} from "./config";
import type { CommitFlavorPreset } from "./commit-flavors";
import { repoBranchPreset } from "./branch-policy";
import { remotePattern } from "./remotes";
import { parseDuration } from "../duration";

export type VcsProvider = "gitlab" | "github";

export type IntegrationMode = "pr" | "merge";

export const nonBlank = z
  .string()
  .check(z.refine((value) => value.trim().length > 0, "must not be blank"));
export const branchPreset = z.custom<BranchPreset>(
  (value) => typeof value === "string" && Object.hasOwn(PRESETS, value),
  "unsupported branch preset",
);
export const commitPreset = z.custom<CommitFlavorPreset>(
  (value) => typeof value === "string" && COMMIT_PRESETS.includes(value),
  "unsupported commit preset",
);
const workspaceBranchPolicySchema = z.strictObject({
  preset: branchPreset,
  developBranch: z.optional(nonBlank),
  prefixes: z.optional(
    z.looseObject({
      feature: nonBlank,
      bugfix: nonBlank,
      release: nonBlank,
      hotfix: nonBlank,
    }),
  ),
  allowed: z.optional(z.array(nonBlank)),
  protected: z.optional(z.array(nonBlank)),
  integration: z.optional(z.enum(["pr", "merge"])),
});
const workspaceCommitPolicySchema = z.strictObject({
  preset: commitPreset,
  pattern: z.optional(z.string()),
});
const workspaceProfileSchema = z
  .strictObject({
    branchPolicy: z.optional(workspaceBranchPolicySchema),
    commitPolicy: z.optional(workspaceCommitPolicySchema),
  })
  .check(
    z.refine(
      (profile) => profile.branchPolicy !== undefined || profile.commitPolicy !== undefined,
      { message: "a profile must define branchPolicy or commitPolicy" },
    ),
  );
const versionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("package-json"),
    path: nonBlank,
    field: nonBlank,
  }),
  z.strictObject({ kind: z.literal("git-tag") }),
  z.strictObject({ kind: z.literal("manual") }),
]);
// Only the production and integration branches are required: runtime
// (core/release-tracks.ts) defaults the rest. Unknown keys pass through (D17:
// a newer Workit's field must not invalidate the file for an older one); a
// track lists the ones an older reader must not ignore in `critical`.
export const releaseTrackSchema = z
  .looseObject({
    strategy: z.optional(branchPreset),
    productionBranch: nonBlank,
    integrationBranch: nonBlank,
    naming: z.optional(
      z.looseObject({
        feature: z.optional(nonBlank),
        release: z.optional(nonBlank),
        hotfix: z.optional(nonBlank),
      }),
    ),
    baseBranch: z.optional(nonBlank),
    mergeBackBranches: z.optional(z.array(nonBlank)),
    pullRequestTarget: z.optional(nonBlank),
    tagNamespace: z.optional(z.string()),
    versionSource: z.optional(versionSourceSchema),
    requiredChecks: z.optional(z.array(nonBlank)),
    critical: z.optional(z.array(nonBlank)),
    // Read leniently (workspaceReleaseNotes).
    releaseNotes: z.optional(z.unknown()),
  })
  .check(
    z.superRefine((track, context) => {
      for (const [field, values] of [
        ["mergeBackBranches", track.mergeBackBranches ?? []],
        ["requiredChecks", track.requiredChecks ?? []],
      ] as const) {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "entries must be unique",
          });
        }
      }
      if (
        track.versionSource?.kind === "package-json" &&
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
    }),
  );
// Read leniently (core/role-models.ts); one instance so the editor schema can name it.
export const modelRoles = z.optional(z.unknown());
export const workspaceConfigSchema = z
  .looseObject({
    name: nonBlank,
    glob: nonBlank,
    vcs: z.optional(
      z.looseObject({
        provider: z.enum(["gitlab", "github"]),
        defaultTargetBranch: z.optional(nonBlank),
        tokenFile: z.optional(nonBlank),
        account: z.optional(nonBlank),
        // Read leniently (forge/resolve.ts).
        host: z.optional(z.unknown()),
      }),
    ),
    autoApprove: z.optional(z.union([z.boolean(), z.array(nonBlank)])),
    // Read leniently (autonomy.ts endpointOf): an unknown value reads as commit.
    defaultEndpoint: z.optional(z.unknown()),
    verification: z.optional(z.enum(["proportional", "self", "independent"])),
    // Read leniently (workspaceDelegation): an unknown value reads as unset.
    delegation: z.optional(z.unknown()),
    // Read leniently (workspaceChangelog): an unknown value reads as off.
    changelog: z.optional(z.unknown()),
    // Read leniently like `changelog`.
    docs: z.optional(z.unknown()),
    // Read leniently like `changelog`.
    changelogPath: z.optional(z.unknown()),
    // Read leniently (workspacePrTemplate): an unknown value reads as auto.
    prTemplate: z.optional(z.unknown()),
    // Read leniently (workspaceReleaseNotes): an unknown value reads as auto.
    releaseNotes: z.optional(z.unknown()),
    trailers: z.optional(z.boolean()),
    deleteBranch: z.optional(z.boolean()),
    // Read leniently (workspaceCleanup): an unknown value reads as keep.
    cleanup: z.optional(z.unknown()),
    // Read leniently (workspaceFeedback): an unknown value reads as on.
    feedback: z.optional(z.unknown()),
    liveSessionGuard: z.optional(z.boolean()),
    shared: z.optional(z.boolean()),
    // tierModels is read leniently (workspaceTierModel), deps and installTimeout
    // too (workspaceFanoutDeps).
    fanout: z.optional(
      z.looseObject({
        tierModels: z.optional(z.unknown()),
        deps: z.optional(z.unknown()),
        installTimeout: z.optional(z.unknown()),
      }),
    ),
    // roles is read leniently (core/role-models.ts).
    models: z.optional(z.looseObject({ roles: modelRoles })),
    // Read leniently (core/resources.ts): an unknown or malformed field warns.
    resources: z.optional(z.unknown()),
    remotes: z.optional(
      z.array(
        nonBlank.check(
          z.refine(
            (pattern) => remotePattern(pattern) !== null,
            "is not a remote URL (https://host/owner/repo, git@host:owner/repo, a path, or owner/*)",
          ),
        ),
      ),
    ),
    externalRepos: z.optional(
      z.array(
        nonBlank.check(
          z.regex(
            /^[\w-]+(?:\/\w[\w.-]*)*\/(?:\w[\w.-]*|\*)$/u,
            "is owner/name, group/project or owner/* on the checkout's forge host, without the host",
          ),
        ),
      ),
    ),
    additiveRiskPaths: z.optional(z.array(nonBlank)),
    autonomy: z.optional(
      z.looseObject(
        Object.fromEntries(
          ["push", "pr", "merge", "release", "rerun"].map((kind) => [
            kind,
            z.optional(z.union([z.boolean(), z.literal("verified")])),
          ]),
        ),
      ),
    ),
    youtrack: z.optional(
      z.looseObject({
        baseUrl: z.optional(nonBlank),
        link_issues: z.optional(z.boolean()),
        writes: z.optional(z.enum(["ask", "auto"])),
        autoHosts: z.optional(z.array(nonBlank)),
      }),
    ),
    // relation, repo and host are read leniently (vcs-config.ts issueTrackerOf, D17).
    issues: z.optional(
      z.looseObject({
        provider: z.optional(z.enum(["github", "gitlab", "youtrack"])),
        link: z.optional(z.boolean()),
        relation: z.optional(z.unknown()),
        backlink: z.optional(z.boolean()),
        link_on_pr: z.optional(z.boolean()),
        repo: z.optional(z.unknown()),
        host: z.optional(z.unknown()),
      }),
    ),
    branchPolicy: z.optional(workspaceBranchPolicySchema),
    commitPolicy: z.optional(workspaceCommitPolicySchema),
    defaultProfile: z.optional(nonBlank),
    profiles: z.optional(z.record(nonBlank, workspaceProfileSchema)),
    releaseTracks: z.optional(z.record(nonBlank, releaseTrackSchema)),
    // Read leniently (core/release-packages.ts): a bad entry is reported and ignored.
    releasePackages: z.optional(z.unknown()),
  })
  .check(
    z.superRefine((workspace, context) => {
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
    }),
  );
export const workspacesFileSchema = z
  .looseObject({
    workspaces: z.optional(z.array(workspaceConfigSchema)),
    models: z.optional(z.looseObject({ roles: modelRoles })),
    feedback: z.optional(
      z.looseObject({
        account: z.optional(nonBlank),
      }),
    ),
  })
  .check(
    z.superRefine((file, context) => {
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
    }),
  );

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
    return {
      status: "malformed",
      path: file,
      entries: [],
      error: `${file} is not a JSON object`,
    };
  }
  const validated = workspacesFileSchema.safeParse(parsed, {
    reportInput: true,
  });
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
  // The schema has no transforms, so the parsed entries hold the same values;
  // returning them (not zod's output) keeps the user's key order, so a write
  // that leaves an entry alone keeps it byte-for-byte (#444).
  const document = parsed as Record<string, unknown>;
  return {
    status: "valid",
    path: file,
    entries: (document.workspaces as WorkspaceConfig[] | undefined) ?? [],
    document,
  };
};

export const readWorkspacesResult = (dir: string = configDir()): WorkspacesResult => {
  const file = path.join(dir, "workspaces.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        status: "missing",
        path: file,
        entries: [],
        revision: workspacesRevision(null),
      };
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
  return {
    ...validateWorkspacesDocument(parsed, file),
    revision: workspacesRevision(raw),
  };
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

/** A workspaces.json problem for the user to fix; CLI verbs report it as `blocked`. */
export class WorkspaceConfigError extends Error {
  override name = "WorkspaceConfigError";
}

type Probe = { main: string | null; superproject: string | null };
const probes = new Map<string, Probe | null>();

/**
 * What git says about the checkout at `cwd`: its main checkout when it is a
 * linked worktree, its superproject when it is a submodule; null when no
 * `.git` sits at or above it (no repository, git is not asked). An Error when
 * git did not answer (missing, broken gitdir, timeout): callers fail closed
 * (#540), and a failure is never cached.
 */
const probeCheckout = (cwd: string): Probe | null | Error => {
  const cached = probes.get(cwd);
  if (cached !== undefined) return cached;
  let dir = path.resolve(cwd);
  while (!existsSync(path.join(dir, ".git"))) {
    // Git's own discovery: a folder holding HEAD, objects and refs is a
    // repository with no work tree (bare, or bare-style with borrowed
    // internals, #552). Only the git directory of a checkout git can name
    // (cwd inside `<checkout>/.git`) keeps grants, capped at that checkout.
    if (["HEAD", "objects", "refs"].every((name) => existsSync(path.join(dir, name)))) {
      const real = realpathOf(dir);
      const owner = ownInternals(real) === true ? gitDirOwner(real) : null;
      if (owner === null)
        return Error(`${cwd} is in a repository with no work tree at ${real}: no grants apply`);
      const probe = { main: owner, superproject: null };
      probes.set(cwd, probe);
      return probe;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  // The repository at cwd, not one an inherited GIT_DIR/GIT_WORK_TREE names.
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[name];
  const git = (args: string[]): string | null => {
    const run = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return run.status === 0 ? run.stdout : null;
  };
  const failed = Error(`git could not tell what checkout ${cwd} is`);
  const [gitDir, common, superproject] = (
    git([
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-superproject-working-tree",
    ]) ?? ""
  )
    .trim()
    .split(/\r?\n/u);
  if (!gitDir || !common) return failed;
  let main: string | null = null;
  if (path.resolve(gitDir) === path.resolve(common)) {
    // Its own repository only when `.git` here is that directory itself: a
    // `gitdir:` file or a symlink into another checkout's repository is capped
    // at that checkout (#548); an owner that cannot be named caps at nothing.
    const real = realpathOf(common);
    if (!ownGitDir(path.join(dir, ".git"), real)) {
      const owner = gitDirOwner(real);
      if (owner === null)
        return Error(`${cwd} uses the repository at ${real}, owned by no checkout workit can name`);
      if (owner !== realpathOf(dir)) main = owner;
    }
    // Its refs, objects and config must be its own too (#552): borrowed ones
    // cap at the checkout that owns them, or at nothing.
    const lender = ownInternals(real);
    if (lender === false)
      return Error(`${cwd} borrows git internals from outside ${real} that no checkout owns`);
    if (lender !== true && lender !== realpathOf(dir)) {
      if (main !== null && main !== lender)
        return Error(`${cwd} mixes the repositories of ${main} and ${lender}`);
      main = lender;
    }
  } else {
    // The first `worktree` entry is the main one, also with --separate-git-dir
    // (where the common dir is not <main>/.git); a bare repo lists its own path.
    const list = git(["worktree", "list", "--porcelain"]);
    if (list === null) return failed;
    main =
      /^worktree (.+)$/mu.exec(list)?.[1]?.trim() ||
      (path.basename(common) === ".git" ? path.dirname(common) : common);
  }
  const probe = { main, superproject: superproject || null };
  probes.set(cwd, probe);
  return probe;
};

/** Is `dotGit` a real directory (not a symlink) that is the repository at `real`? */
const ownGitDir = (dotGit: string, real: string): boolean => {
  try {
    return lstatSync(dotGit).isDirectory() && realpathOf(dotGit) === real;
  } catch {
    return false;
  }
};

// What decides the repository git acts on; hooks and info cannot change refs,
// objects or the remote, so a shared hooks folder keeps the grants.
const INTERNALS = ["refs", "objects", "config", "packed-refs", "commondir"];

/**
 * Whether the git directory at `real` owns what git reads through it (#552):
 * true when every present INTERNALS entry resolves inside it; the one checkout
 * (gitDirOwner) whose git directory the borrowed ones resolve into; false
 * when one resolves elsewhere, dangles, or they name several checkouts.
 */
const ownInternals = (real: string): true | string | false => {
  let lender: string | null = null;
  for (const name of INTERNALS) {
    const at = path.join(real, name);
    try {
      lstatSync(at);
    } catch {
      continue;
    }
    let resolved: string;
    try {
      resolved = (realpathSync.native ?? realpathSync)(at);
    } catch {
      return false;
    }
    const rel = path.relative(real, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) continue;
    const owner = path.basename(resolved) === name ? gitDirOwner(path.dirname(resolved)) : null;
    if (owner === null || (lender !== null && lender !== owner)) return false;
    lender = owner;
  }
  return lender ?? true;
};

/**
 * The checkout a git directory belongs to: `<checkout>/.git`, or the
 * superproject of `<checkout>/.git/modules/<name>` (also through one of its
 * linked worktrees, `.git/worktrees/<w>/modules/<name>`); null for anything else
 * (a `--separate-git-dir`, a bare repository).
 */
const gitDirOwner = (real: string): string | null => {
  const parts = real.split(/[\\/]/u);
  const at = parts.lastIndexOf(".git");
  if (at < 1) return null;
  const rest = parts.slice(at + 1);
  const module = rest[0] === "modules" || (rest[0] === "worktrees" && rest[2] === "modules");
  return rest.length === 0 || module ? parts.slice(0, at).join(path.sep) || path.sep : null;
};

/**
 * The main checkout of the linked worktree at `cwd` (null when cwd is not a
 * linked worktree, or git did not answer). A worktree outside every glob
 * (~/.codex/worktrees/…, ../x, /tmp) belongs to the workspace of the checkout
 * it was added from (B2).
 */
const mainCheckoutOf = (cwd: string): string | null => {
  const probe = probeCheckout(cwd);
  return probe instanceof Error ? null : (probe?.main ?? null);
};

/**
 * Every checkout whose grants cap the one at `cwd` (#540): a linked
 * worktree's main checkout, a submodule's superproject, and theirs in turn.
 * An Error when git did not answer for one of them.
 */
export const checkoutsAbove = (cwd: string, seen = new Set<string>()): string[] | Error => {
  const probe = probeCheckout(cwd);
  if (probe instanceof Error) return probe;
  const out: string[] = [];
  for (const above of [probe?.main, probe?.superproject])
    if (above && !seen.has(above)) {
      seen.add(above);
      const rest = checkoutsAbove(above, seen);
      if (rest instanceof Error) return rest;
      out.push(above, ...rest);
    }
  return out;
};

/**
 * The entries whose glob matches cwd (its logical and real path); for a linked
 * worktree that matches none, the entries matching its main checkout.
 */
const matchingEntries = <T extends { glob: string }>(cwd: string, entries: readonly T[]): T[] => {
  const match = (where: string): T[] => {
    const targets = [where, realpathOf(where)].map((value) => value.replaceAll("\\", "/"));
    return entries.filter((entry) => {
      const glob = entry.glob.replaceAll("\\", "/");
      const canonical = canonicalGlob(glob);
      return targets.some(
        (target) =>
          matchWorkspace(glob, target) || (canonical !== glob && matchWorkspace(canonical, target)),
      );
    });
  };
  const direct = match(cwd);
  if (direct.length) return direct;
  const main = mainCheckoutOf(cwd);
  return main ? match(main) : direct;
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

/** The literal path segments of a glob; the most specific matching glob wins. */
export const globSpecificity = (glob: string): number =>
  glob
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && !/[*?[\]{]/.test(segment)).length;

/** The literal directory a glob starts from: `/home/u/work/**` -> `/home/u/work`. */
export const globRoot = (glob: string): string => {
  const normalized = glob.replaceAll("\\", "/");
  const wild = /[*?[\]{]/.exec(normalized);
  const prefix = wild ? normalized.slice(0, wild.index) : normalized;
  return prefix.replace(/\/+$/u, "") || "/";
};

/** The text of a glob before its first wildcard, in both its logical and real form. */
const literalPrefixes = (glob: string): string[] => {
  const normalized = glob.replaceAll("\\", "/");
  const prefixOf = (value: string) => {
    const wild = /[*?[\]{]/.exec(value);
    return wild ? value.slice(0, wild.index) : value;
  };
  return [
    ...new Set([prefixOf(normalized), prefixOf(canonicalGlob(normalized).replaceAll("\\", "/"))]),
  ];
};

/**
 * Whether two globs might match a common path. Every path a glob matches
 * starts with its literal prefix, so globs whose prefixes are not one a text
 * prefix of the other never overlap; anything else is treated as overlapping
 * (conservative: #444's verbs refuse or clamp rather than risk a raise).
 */
const globsMayOverlap = (a: string, b: string): boolean =>
  literalPrefixes(a).some((pa) =>
    literalPrefixes(b).some((pb) => pa.startsWith(pb) || pb.startsWith(pa)),
  );

/** Every entry whose glob may match a path `glob` matches. */
export const overlappingEntries = <T extends { name: string; glob: string }>(
  glob: string,
  entries: readonly T[],
): T[] => entries.filter((entry) => globsMayOverlap(entry.glob, glob));

/** One path segment as a regex: `*` stays inside the segment, anything else is literal. */
const segmentRegExp = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

/** Whether two path-glob segment lists can name a common path (a globstar ends the comparison). */
const segmentsIntersect = (a: readonly string[], b: readonly string[]): boolean => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x.includes("**") || y.includes("**")) return true;
    const [xWild, yWild] = [x.includes("*"), y.includes("*")];
    if (xWild && yWild) continue;
    if (xWild ? !segmentRegExp(x).test(y) : yWild ? !segmentRegExp(y).test(x) : x !== y)
      return false;
  }
  // One glob ends first: the shorter one names a folder that holds the other.
  return true;
};

/**
 * Whether two globs really can match a common folder, segment by segment: a
 * stricter reading than `globsMayOverlap`, for what the verbs print (the
 * safety decisions still use the conservative one). Compared in logical and
 * real form, so a symlinked root cannot hide an overlap.
 */
export const globsIntersect = (a: string, b: string): boolean => {
  const split = (glob: string) => glob.replaceAll("\\", "/").split("/").filter(Boolean);
  const forms = (glob: string) => [glob, canonicalGlob(glob.replaceAll("\\", "/"))];
  return forms(a).some((fa) => forms(b).some((fb) => segmentsIntersect(split(fa), split(fb))));
};

/** Every entry whose glob can really match a folder `glob` matches. */
export const intersectingEntries = <T extends { name: string; glob: string }>(
  glob: string,
  entries: readonly T[],
): T[] => entries.filter((entry) => globsIntersect(entry.glob, glob));

export type WorkspaceOverlap = {
  /** The entry nested inside (or tied with) `outer`. */
  inner: string;
  outer: string;
  /** Where both match: the inner glob's root. */
  at: string;
  /** The entry selected there; null when the globs tie (ambiguous). */
  winner: string | null;
};

/** Pairs of entries whose globs both match some directory, and which one wins. */
export const workspaceOverlaps = (
  entries: readonly { name: string; glob: string }[],
): WorkspaceOverlap[] => {
  const out: WorkspaceOverlap[] = [];
  for (const [i, a] of entries.entries())
    for (const b of entries.slice(i + 1)) {
      const aInB = matchWorkspace(b.glob, globRoot(a.glob));
      const bInA = matchWorkspace(a.glob, globRoot(b.glob));
      if (!aInB && !bInA && !globsMayOverlap(a.glob, b.glob)) continue;
      const [inner, outer] =
        aInB && !bInA
          ? [a, b]
          : bInA && !aInB
            ? [b, a]
            : globSpecificity(a.glob) >= globSpecificity(b.glob)
              ? [a, b]
              : [b, a];
      const si = globSpecificity(inner.glob);
      const so = globSpecificity(outer.glob);
      out.push({
        inner: inner.name,
        outer: outer.name,
        at: globRoot(inner.glob),
        winner: si === so ? null : si > so ? inner.name : outer.name,
      });
    }
  return out;
};

/** Every entry whose glob matches cwd (its logical and real path, or its main checkout). */
export const workspaceMatches = <T extends { name: string; glob: string }>(
  cwd: string,
  entries: readonly T[],
): T[] => matchingEntries(cwd, entries);

const selectWorkspaceMatch = <T extends { name: string; glob: string }>(
  matches: T[],
  cwd: string,
  workspaceName?: string,
): T | undefined => {
  if (workspaceName !== undefined) {
    const named = matches.filter((entry) => entry.name === workspaceName);
    if (named.length === 1) return named[0];
    if (named.length > 1)
      throw new WorkspaceConfigError(
        `ambiguous workspace ${JSON.stringify(workspaceName)} for ${cwd}`,
      );
    if (matches.length > 0) {
      throw new WorkspaceConfigError(
        `workspace ${JSON.stringify(workspaceName)} does not match ${cwd}; matching choices: ${matches.map((entry) => entry.name).join(", ")}`,
      );
    }
    throw new WorkspaceConfigError(
      `workspace ${JSON.stringify(workspaceName)} does not match ${cwd}`,
    );
  }

  if (matches.length < 2) return matches[0];
  const highestSpecificity = Math.max(...matches.map((entry) => globSpecificity(entry.glob)));
  const mostSpecific = matches.filter(
    (entry) => globSpecificity(entry.glob) === highestSpecificity,
  );
  if (mostSpecific.length > 1) {
    throw new WorkspaceConfigError(
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
  const matches = matchingEntries(cwd, entries);
  return selectWorkspaceMatch(matches, cwd, workspaceName) ?? null;
};

/** Match a cwd against the workspaces.json under an explicit config dir. */
export const resolveWorkspaceFrom = (
  cwd: string,
  dir: string,
  workspaceName?: string,
): WorkspaceConfig | null => {
  const result = readWorkspacesResult(dir);
  if (result.status === "malformed" || result.status === "invalid")
    throw new WorkspaceConfigError(result.error);
  return resolveWorkspaceFromEntries(cwd, result.entries, workspaceName);
};

export const resolveWorkspace = (
  cwd: string,
  workspaceName = process.env.WORKIT_WORKSPACE_NAME?.trim() || undefined,
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
        : z.looseObject({
            provider: z.enum(["gitlab", "github"]),
            defaultTargetBranch: z.optional(nonBlank),
            account: z.optional(nonBlank),
          });
  const profileSchema = z.looseObject({ [key]: z.optional(policySchema) });
  const entrySchema = z.looseObject({
    name: nonBlank,
    glob: nonBlank,
    [key]: z.optional(policySchema),
    defaultProfile: z.optional(nonBlank),
    profiles: z.optional(z.record(nonBlank, profileSchema)),
  });
  return entrySchema;
};

export type RuntimeWorkspaceVcs = Pick<
  RuntimeWorkspaceCandidate,
  "name" | "branchPolicy" | "vcs" | "youtrack" | "issues"
>;

export const resolveRuntimeWorkspaceVcs = (cwd: string): RuntimeWorkspaceVcs | null =>
  resolveRuntimeWorkspaceCandidate(cwd, "vcs");

const runtimeWorkspaceIndexSchema = z.looseObject({
  workspaces: z.optional(z.array(z.looseObject({ name: nonBlank, glob: nonBlank }))),
});

/** The workspaces.json entry matching cwd, checked only for name/glob (D17). */
const matchRuntimeWorkspace = (
  cwd: string,
  dir: string = configDir(),
): {
  file: string;
  selected: Record<string, unknown> & { name: string };
  /** Every entry whose glob matches cwd, the selected one included. */
  matches: Array<Record<string, unknown> & { name: string; glob: string }>;
} | null => {
  const file = path.join(dir, "workspaces.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceConfigError(
      `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceConfigError(`${file} is not valid JSON`);
  }
  const validated = runtimeWorkspaceIndexSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "workspaces"}: ${issue.message}`)
      .join("; ");
    throw new WorkspaceConfigError(`${file} has invalid workspace matching data: ${detail}`);
  }
  const entries = validated.data.workspaces;
  for (const entry of entries ?? []) {
    const glob = validateWorkspaceGlob(entry.glob);
    if (!glob.ok) throw new WorkspaceConfigError(`${file} workspace ${entry.name}: ${glob.error}`);
  }
  const matches = matchingEntries(cwd, entries ?? []);
  const workspaceName = process.env.WORKIT_WORKSPACE_NAME?.trim() || undefined;
  const selected = selectWorkspaceMatch(matches, cwd, workspaceName);
  return selected ? { file, selected, matches } : null;
};

/**
 * The raw `releaseTracks` of the workspace matching cwd, unvalidated: the
 * runtime reads them leniently (core/release-tracks.ts) so one malformed track
 * is reported instead of disabling every command.
 */
export const resolveRuntimeReleaseTracks = (
  cwd: string,
): { workspace: string; releaseTracks: unknown } | null => {
  const matched = matchRuntimeWorkspace(cwd);
  return matched
    ? {
        workspace: matched.selected.name,
        releaseTracks: matched.selected.releaseTracks,
      }
    : null;
};

type RuntimeEntry = Record<string, unknown> & { name: string };

/**
 * The workspace selected for cwd and the entry a setting comes from: the
 * selected workspace when `has(entry)`, else the nearest enclosing workspace
 * that also matches cwd (a repo workspace nested in `work`). Read leniently:
 * no workspace, or an unreadable workspaces.json, reads as null.
 */
const inheritedSetting = (
  cwd: string,
  dir: string | undefined,
  has: (entry: RuntimeEntry) => boolean,
): { workspace: string; source: RuntimeEntry | null } | null => {
  let matched: ReturnType<typeof matchRuntimeWorkspace>;
  try {
    matched = matchRuntimeWorkspace(cwd, dir);
  } catch {
    return null;
  }
  if (!matched) return null;
  const { selected, matches } = matched;
  const enclosing = matches
    .filter((entry) => entry !== selected)
    .toSorted((a, b) => globSpecificity(b.glob) - globSpecificity(a.glob));
  return {
    workspace: selected.name,
    source: [selected, ...enclosing].find(has) ?? null,
  };
};

/**
 * The raw `releasePackages` of cwd's workspace, unvalidated, inherited like
 * `changelogPath`: the runtime reads it leniently (core/release-packages.ts).
 */
export const resolveRuntimeReleasePackages = (
  cwd: string,
  dir?: string,
): { workspace: string; releasePackages: unknown } | null => {
  const found = inheritedSetting(cwd, dir, (entry) => entry.releasePackages !== undefined);
  return found?.source
    ? { workspace: found.source.name, releasePackages: found.source.releasePackages }
    : null;
};

/** Whether `pr merge` deletes the head branch by default: true unless a covering entry sets `deleteBranch: false`. */
export const workspaceDeleteBranch = (cwd: string, dir?: string): boolean =>
  inheritedSetting(cwd, dir, (entry) => typeof entry.deleteBranch === "boolean")?.source
    ?.deleteBranch !== false;

/**
 * Whether commits in cwd's workspace carry the `Workit-Session:` trailer.
 * The selected workspace's own `trailers` wins; unset, it inherits from the
 * nearest enclosing workspace that also matches cwd, and defaults to true.
 * No workspace, or an unreadable workspaces.json, keeps the trailer. `from`
 * names the entry the value came from (null for the default).
 */
export const workspaceTrailers = (
  cwd: string,
  dir?: string,
): { enabled: boolean; workspace: string | null; from: string | null } => {
  const found = inheritedSetting(cwd, dir, (entry) => typeof entry.trailers === "boolean");
  return {
    enabled: found?.source?.trailers !== false,
    workspace: found?.workspace ?? null,
    from: found?.source?.name ?? null,
  };
};

export const CLEANUP_MODES = ["auto", "keep"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/**
 * The workspace's `cleanup` mode (default `auto`), inherited like `trailers`.
 * `keep` leaves every worktree, branch and process of finished work in place.
 * A value this version does not know reads as keep (fail closed: nothing is
 * removed on a typo) and is returned as `invalid`; an unreadable
 * workspaces.json reads as auto. `from` names the entry the value came from.
 */
export const workspaceCleanup = (
  cwd: string,
  dir?: string,
): { mode: CleanupMode; from: string | null; invalid?: unknown } => {
  const found = inheritedSetting(cwd, dir, (entry) => entry.cleanup !== undefined);
  const value = found?.source?.cleanup;
  const from = found?.source?.name ?? null;
  if (value === undefined || value === "auto") return { mode: "auto", from };
  return value === "keep" ? { mode: "keep", from } : { mode: "keep", from, invalid: value };
};

export const FANOUT_DEPS_MODES = ["install", "link"] as const;
export type FanoutDepsMode = (typeof FANOUT_DEPS_MODES)[number];

/**
 * The workspace's `fanout.deps` and `fanout.installTimeout` (in ms), each
 * inherited like `trailers`; null when no covering entry sets it. A value this
 * version does not read is skipped (the default applies, never an error) and
 * named in `issues`. `from` names the entry each value came from.
 */
export const workspaceFanoutDeps = (
  cwd: string,
  dir?: string,
): {
  deps: FanoutDepsMode | null;
  installTimeoutMs: number | null;
  from: { deps: string | null; installTimeout: string | null };
  issues: string[];
} => {
  const field = (entry: RuntimeEntry, key: "deps" | "installTimeout"): unknown =>
    (entry.fanout as { deps?: unknown; installTimeout?: unknown } | undefined)?.[key];
  const issues: string[] = [];
  const depsEntry = inheritedSetting(
    cwd,
    dir,
    (entry) => field(entry, "deps") !== undefined,
  )?.source;
  const rawDeps = depsEntry ? field(depsEntry, "deps") : undefined;
  let deps: FanoutDepsMode | null = null;
  if (depsEntry && (FANOUT_DEPS_MODES as readonly unknown[]).includes(rawDeps))
    deps = rawDeps as FanoutDepsMode;
  else if (depsEntry)
    issues.push(
      `workspace ${depsEntry.name} fanout.deps ${JSON.stringify(rawDeps)} is not ${FANOUT_DEPS_MODES.join(" or ")}; ignored`,
    );
  const timeoutEntry = inheritedSetting(
    cwd,
    dir,
    (entry) => field(entry, "installTimeout") !== undefined,
  )?.source;
  const rawTimeout = timeoutEntry ? field(timeoutEntry, "installTimeout") : undefined;
  const parsed = typeof rawTimeout === "string" ? parseDuration(rawTimeout) : null;
  let installTimeoutMs: number | null = null;
  if (timeoutEntry && parsed !== null && parsed > 0) installTimeoutMs = parsed;
  else if (timeoutEntry)
    issues.push(
      `workspace ${timeoutEntry.name} fanout.installTimeout ${JSON.stringify(rawTimeout)} is not a duration such as "90s" or "10m"; ignored`,
    );
  return {
    deps,
    installTimeoutMs,
    from: {
      deps: deps ? (depsEntry?.name ?? null) : null,
      installTimeout: installTimeoutMs === null ? null : (timeoutEntry?.name ?? null),
    },
    issues,
  };
};

/**
 * Whether the live-session guard runs for cwd's workspace (`liveSessionGuard`,
 * default true; inherited like `trailers`). An unreadable workspaces.json
 * keeps it on: the guard itself fails open on any state error.
 */
export const workspaceLiveSessionGuard = (cwd: string, dir?: string): boolean =>
  inheritedSetting(cwd, dir, (entry) => typeof entry.liveSessionGuard === "boolean")?.source
    ?.liveSessionGuard !== false;

/**
 * Whether cwd's workspace is `shared` (#879): a team repo where `pr create`
 * and `pr edit` warn when the PR names Workit. Default false, inherited like
 * `trailers`; an unreadable workspaces.json reads as not shared.
 */
export const workspaceShared = (
  cwd: string,
  dir?: string,
): { enabled: boolean; workspace: string | null } => {
  const found = inheritedSetting(cwd, dir, (entry) => typeof entry.shared === "boolean");
  return { enabled: found?.source?.shared === true, workspace: found?.workspace ?? null };
};

export const DELEGATION_MODES = ["inline-first", "lead-orchestrates"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

const isDelegation = (value: unknown): value is DelegationMode =>
  (DELEGATION_MODES as readonly unknown[]).includes(value);

/**
 * The workspace's `delegation` mode, default `inline-first`; inherited like
 * `trailers`. A value this version does not know reads as unset.
 */
export const workspaceDelegation = (cwd: string, dir?: string): DelegationMode => {
  const source = inheritedSetting(cwd, dir, (entry) => isDelegation(entry.delegation))?.source;
  return isDelegation(source?.delegation) ? source.delegation : "inline-first";
};

/** A GitHub login as `workit feedback` takes it; anything else reads as unset. */
const feedbackLogin = (value: unknown): string | null => {
  const account = (value as { account?: unknown } | null)?.account;
  return typeof account === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(account)
    ? account
    : null;
};

/** The entry cwd's `feedback` comes from (inherited like `trailers`), and whether it is off. */
const feedbackSetting = (cwd: string, dir: string | undefined) => {
  const found = inheritedSetting(cwd, dir, (entry) => entry.feedback !== undefined);
  const value = found?.source?.feedback;
  return { found, value, off: value === "off" };
};

/** Whether `workit feedback` is off for cwd's workspace (#777): its contract line is then hidden. */
export const workspaceFeedbackOff = (cwd: string, dir?: string): boolean =>
  feedbackSetting(cwd, dir).off;

/**
 * `workit feedback` for cwd's workspace (#777): `off` as above, and the login
 * it posts with: the nearest entry's `feedback.account`, else the file's
 * top-level `feedback.account`, else null (the verb then asks for
 * --account). An unreadable workspaces.json reads as on with no account.
 */
export const workspaceFeedback = (
  cwd: string,
  dir?: string,
): { off: boolean; account: string | null; workspace: string | null } => {
  const { found, value, off } = feedbackSetting(cwd, dir);
  const read = readWorkspacesResult(dir);
  const global = read.status === "valid" ? feedbackLogin(read.document?.feedback) : null;
  return {
    off,
    account: off ? null : (feedbackLogin(value) ?? global),
    workspace: found?.workspace ?? null,
  };
};

export const CHANGELOG_MODES = ["off", "update", "create"] as const;
export type ChangelogMode = (typeof CHANGELOG_MODES)[number];
export const DOCS_MODES = ["off", "when-user-facing"] as const;
export type DocsMode = (typeof DOCS_MODES)[number];

const isChangelogMode = (value: unknown): value is ChangelogMode =>
  (CHANGELOG_MODES as readonly unknown[]).includes(value);
const isDocsMode = (value: unknown): value is DocsMode =>
  (DOCS_MODES as readonly unknown[]).includes(value);

export const DEFAULT_CHANGELOG_PATH = "CHANGELOG.md";

/**
 * A repo-relative changelog path in `/` form, or null when `value` is not one
 * (absolute, empty, or climbing out with `..`).
 */
export const changelogPathOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parts = value
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (!parts.length || value.trim().startsWith("/") || /^[A-Za-z]:/u.test(value.trim()))
    return null;
  return parts.includes("..") ? null : parts.join("/");
};

/** `changelogPath` as a list of valid paths, or null when any entry is invalid. */
export const changelogPathsOf = (value: unknown): string[] | null => {
  const list = Array.isArray(value) ? value : [value];
  const paths = list.map(changelogPathOf).filter((one) => one !== null);
  return list.length && paths.length === list.length ? paths : null;
};

/**
 * The workspace's changelog and docs steps, both default `off`, and where the
 * changelog lives (default CHANGELOG.md); each is inherited like `trailers`. A
 * value this version does not know reads as the default and is named in
 * `issues`, so `grant show` can say why.
 */
export const workspaceChangelog = (
  cwd: string,
  dir?: string,
): {
  changelog: ChangelogMode;
  docs: DocsMode;
  paths: string[];
  pathConfigured: boolean;
  /** The workspace matching cwd, for a `workit workspace set` hint. */
  workspace: string | null;
  issues: string[];
} => {
  const issues: string[] = [];
  const read = <T extends string>(
    key: "changelog" | "docs",
    valid: (value: unknown) => value is T,
    allowed: readonly string[],
  ): T | "off" => {
    const source = inheritedSetting(cwd, dir, (entry) => entry[key] !== undefined)?.source;
    const value = source?.[key];
    if (value === undefined) return "off";
    if (valid(value)) return value;
    issues.push(
      `${key} ${JSON.stringify(value)} in workspace ${source?.name} is not ${allowed.join("|")}; read as off`,
    );
    return "off";
  };
  const pathSource = inheritedSetting(
    cwd,
    dir,
    (entry) => entry.changelogPath !== undefined,
  )?.source;
  const configured = pathSource ? changelogPathsOf(pathSource.changelogPath) : null;
  if (pathSource && !configured)
    issues.push(
      `changelogPath ${JSON.stringify(pathSource.changelogPath)} in workspace ${pathSource.name} is not a repo-relative path or list of them; read as ${DEFAULT_CHANGELOG_PATH}`,
    );
  return {
    changelog: read("changelog", isChangelogMode, CHANGELOG_MODES),
    docs: read("docs", isDocsMode, DOCS_MODES),
    paths: configured ?? [DEFAULT_CHANGELOG_PATH],
    pathConfigured: configured !== null,
    workspace: inheritedSetting(cwd, dir, () => true)?.workspace ?? null,
    issues,
  };
};

export const PR_TEMPLATE_MODES = ["auto", "repo", "workit"] as const;
export type PrTemplateMode = (typeof PR_TEMPLATE_MODES)[number];

/**
 * A `prTemplate` value in its stored form: a mode, or a repo-relative `.md`
 * path in `/` form; null for anything else (another word, an absolute path,
 * one climbing out with `..`).
 */
export const prTemplateOf = (value: unknown): string | null => {
  if ((PR_TEMPLATE_MODES as readonly unknown[]).includes(value)) return value as PrTemplateMode;
  const file = changelogPathOf(value);
  return file && file.toLowerCase().endsWith(".md") ? file : null;
};

/**
 * The workspace's `prTemplate` (default `auto`), inherited like `trailers`. A
 * value this version does not know reads as auto and is named in `issues`.
 */
export const workspacePrTemplate = (
  cwd: string,
  dir?: string,
): { setting: string; workspace: string | null; issues: string[] } => {
  const source = inheritedSetting(cwd, dir, (entry) => entry.prTemplate !== undefined)?.source;
  const setting = source ? prTemplateOf(source.prTemplate) : null;
  return {
    setting: setting ?? "auto",
    workspace: inheritedSetting(cwd, dir, () => true)?.workspace ?? null,
    issues:
      source && !setting
        ? [
            `prTemplate ${JSON.stringify(source.prTemplate)} in workspace ${source.name} is not ${PR_TEMPLATE_MODES.join("|")} or a repo-relative .md path; read as auto`,
          ]
        : [],
  };
};

export const RELEASE_NOTES_MODES = ["auto", "off", "review"] as const;
export type ReleaseNotesMode = (typeof RELEASE_NOTES_MODES)[number];

export const isReleaseNotesMode = (value: unknown): value is ReleaseNotesMode =>
  (RELEASE_NOTES_MODES as readonly unknown[]).includes(value);

const tracksOf = (entry: RuntimeEntry): Record<string, Record<string, unknown>> => {
  const tracks = entry.releaseTracks;
  return tracks && typeof tracks === "object" && !Array.isArray(tracks)
    ? (tracks as Record<string, Record<string, unknown>>)
    : {};
};

/**
 * The release notes mode for cwd (default `auto`), inherited like `trailers`:
 * the release track's own `releaseTracks.<track>.releaseNotes` wins over the
 * workspace's `releaseNotes`. A value this version does not know reads as
 * auto and is named in `issues`; `tracks` lists the tracks that override it.
 */
export const workspaceReleaseNotes = (
  cwd: string,
  track?: string | null,
  dir?: string,
): {
  mode: ReleaseNotesMode;
  /** Where the mode comes from: the track, the workspace, or the default. */
  from: "track" | "workspace" | "default";
  workspace: string | null;
  /** Tracks that set their own mode. */
  tracks: Record<string, ReleaseNotesMode>;
  issues: string[];
} => {
  const issues: string[] = [];
  const valid = (value: unknown, where: string): ReleaseNotesMode | null => {
    if (isReleaseNotesMode(value)) return value;
    issues.push(
      `releaseNotes ${JSON.stringify(value)} in ${where} is not ${RELEASE_NOTES_MODES.join("|")}; read as auto`,
    );
    return null;
  };
  const workspace = inheritedSetting(cwd, dir, () => true)?.workspace ?? null;
  const trackSource = inheritedSetting(
    cwd,
    dir,
    (entry) => Object.keys(tracksOf(entry)).length > 0,
  )?.source;
  const tracks: Record<string, ReleaseNotesMode> = {};
  for (const [name, config] of Object.entries(trackSource ? tracksOf(trackSource) : {}))
    if (config?.releaseNotes !== undefined) {
      const mode = valid(
        config.releaseNotes,
        `release track ${name} of workspace ${trackSource?.name}`,
      );
      if (mode) tracks[name] = mode;
    }
  const source = inheritedSetting(cwd, dir, (entry) => entry.releaseNotes !== undefined)?.source;
  const own = source ? valid(source.releaseNotes, `workspace ${source.name}`) : null;
  if (track && tracks[track])
    return { mode: tracks[track], from: "track", workspace, tracks, issues };
  return own
    ? { mode: own, from: "workspace", workspace, tracks, issues }
    : { mode: "auto", from: "default", workspace, tracks, issues };
};

/**
 * Where `models.roles` and `fanout.tierModels` can come from for cwd, nearest
 * first: the selected workspace, each enclosing one (most specific first),
 * then the global default at the top of workspaces.json. Read leniently: an
 * unreadable file reads as no sources.
 */
export const modelSources = (
  cwd: string,
  dir?: string,
): Array<{
  name: string;
  global: boolean;
  models: unknown;
  tierModels: unknown;
}> => {
  const out: Array<{
    name: string;
    global: boolean;
    models: unknown;
    tierModels: unknown;
  }> = [];
  try {
    const matched = matchRuntimeWorkspace(cwd, dir);
    if (matched) {
      const enclosing = matched.matches
        .filter((entry) => entry !== matched.selected)
        .toSorted((a, b) => globSpecificity(b.glob) - globSpecificity(a.glob));
      for (const entry of [matched.selected, ...enclosing])
        out.push({
          name: entry.name,
          global: false,
          models: entry.models,
          tierModels: (entry.fanout as { tierModels?: unknown } | undefined)?.tierModels,
        });
    }
  } catch {
    // An unreadable or invalid file: no workspace sources.
  }
  try {
    const document: unknown = JSON.parse(
      readFileSync(path.join(dir ?? configDir(), "workspaces.json"), "utf8"),
    );
    if (document && typeof document === "object" && !Array.isArray(document))
      out.push({
        name: "global",
        global: true,
        models: (document as Record<string, unknown>).models,
        tierModels: undefined,
      });
  } catch {
    // No global default.
  }
  return out;
};

export const hostFamily = (host: string): string => host.replace(/_(?:cli|desktop)$/u, "");

const TIER_KEYS = new Set(["mundane", "standard", "hard"]);
/** The host keys a per-host model value takes (`fanout.tierModels`, `models.roles`). */
export const MODEL_HOST_KEYS = [
  "claude_code",
  "opencode",
  "codex",
  "codex_cli",
  "codex_desktop",
  "cursor",
  "pi",
  "default",
] as const;
const TIER_HOSTS = new Set<string>(MODEL_HOST_KEYS);

/**
 * What `fanout.tierModels` in cwd's workspaces holds that Workit ignores: an
 * unknown tier or host key, or a value that is not a model name. Read
 * leniently (each one is skipped, never an error); `workit grant show`
 * reports them.
 */
export const workspaceTierModelIssues = (cwd: string, dir?: string): string[] => {
  let matched: ReturnType<typeof matchRuntimeWorkspace>;
  try {
    matched = matchRuntimeWorkspace(cwd, dir);
  } catch {
    return [];
  }
  const issues: string[] = [];
  for (const entry of matched?.matches ?? []) {
    const models = (entry.fanout as { tierModels?: unknown } | undefined)?.tierModels;
    if (models === undefined) continue;
    const where = `workspace ${entry.name} fanout.tierModels`;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      issues.push(`${where} is not an object; ignored`);
      continue;
    }
    for (const [tier, value] of Object.entries(models)) {
      if (!TIER_KEYS.has(tier)) issues.push(`${where}.${tier}: unknown tier; ignored`);
      else if (typeof value === "string") {
        if (!value.trim()) issues.push(`${where}.${tier}: empty model name; ignored`);
      } else if (!value || typeof value !== "object" || Array.isArray(value))
        issues.push(`${where}.${tier}: not a model name or a per-host object; ignored`);
      else
        for (const [host, model] of Object.entries(value)) {
          if (!TIER_HOSTS.has(host)) issues.push(`${where}.${tier}.${host}: unknown host; ignored`);
          else if (typeof model !== "string" || !model.trim())
            issues.push(`${where}.${tier}.${host}: not a model name; ignored`);
        }
    }
  }
  return issues;
};

const resolveRuntimeWorkspaceCandidate = (
  cwd: string,
  kind: RuntimeWorkspacePolicy,
): RuntimeWorkspaceCandidate | null => {
  const matched = matchRuntimeWorkspace(cwd);
  if (!matched) return null;
  const { file, selected } = matched;
  const policy = runtimeWorkspacePolicySchema(kind).safeParse(selected);
  if (!policy.success) {
    const detail = policy.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "workspace"}: ${issue.message}`)
      .join("; ");
    throw new WorkspaceConfigError(`${file} has invalid ${kind} policy configuration: ${detail}`);
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
    throw new WorkspaceConfigError(
      `workspace ${JSON.stringify(candidate.name)} has no profile ${JSON.stringify(candidate.defaultProfile)}`,
    );
  const profile = profileName ? candidate.profiles?.[profileName] : undefined;
  if (profileName && !profile)
    throw new WorkspaceConfigError(
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
  /** The preset the checkout's branches imply, used when no policy is configured. */
  repoPreset?: () => BranchPreset | null,
): WorkspacePolicyResolution | { status: "invalid"; error: string } => {
  const selected = workspace
    ? resolveWorkspaceProfile(workspace, profileName)
    : {
        status: "resolved" as const,
        profileName: null,
        workspace: null,
        provenance: {
          branchPolicy: "user-default",
          commitPolicy: "user-default",
        },
      };
  if (selected.status === "invalid") return selected;
  return {
    status: "resolved",
    workspace: selected.workspace,
    profileName: selected.profileName,
    branchPolicy: resolveConfiguredBranchPolicy(config, selected.workspace, repoPreset),
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
  return {
    status: "selected",
    name: requestedTrack,
    track: tracks[requestedTrack],
  };
};

/**
 * The workspace default target before release tracks: the one computation
 * vcsConfig, `workit doctor` and `workit grant show` share (CA-05/CA-02).
 * Explicit workspace vcs.defaultTargetBranch wins; a workspace with its own
 * branchPolicy uses its preset's default (gitflow -> develop, github-flow ->
 * main, trunk-based -> master); otherwise the global vcs.json
 * `defaultTargetBranch` (`globalDefault`), else the effective preset's.
 */
export function workspaceDefaultTarget(cwd: string, globalDefault: unknown): string {
  const ws = resolveRuntimeWorkspaceVcs(cwd);
  const wp = (ws?.branchPolicy ?? {}) as Record<string, unknown>;
  const hasWorkspacePolicy = typeof wp.preset === "string" && Object.hasOwn(PRESETS, wp.preset);
  const selected = resolveRuntimeWorkspacePolicy(
    cwd,
    "branch",
    process.env.WORKIT_PROFILE?.trim() || undefined,
  );
  const policyDefault = resolveConfiguredBranchPolicy(
    readConfig(),
    selected.policy ? { branchPolicy: selected.policy as WorkspaceBranchPolicy } : null,
    () => repoBranchPreset(cwd),
  ).defaultTargetBranch;
  return String(
    (ws?.vcs as { defaultTargetBranch?: unknown } | undefined)?.defaultTargetBranch ??
      (hasWorkspacePolicy ? policyDefault : (globalDefault ?? policyDefault)) ??
      "develop",
  );
}
