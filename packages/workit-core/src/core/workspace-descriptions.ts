// The editor descriptions of workspaces.json, applied to the workspaces
// schemas only when the editor JSON Schema is generated (config-schemas.ts).
// The schemas themselves (workspaces.ts) carry none: every hook loads them,
// and ~13 KB of help text in each hook bundle would never be read.
// nonBlank, branchPreset and commitPreset are shared between fields, so a
// description is never registered on a schema workspaces.ts exports: withDocs
// rebuilds the path to each described field and registers a copy (described()).
import { workspacesFileSchema } from "./workspaces";
import { described, type ZodMiniType } from "./zod-mini";

/** A field's description, its object's field descriptions, or its array/record item's. */
type Doc = string | { text?: string; fields?: Record<string, Doc>; item?: Doc };

const BRANCH_POLICY_FIELDS: Record<string, Doc> = {
  preset:
    "The branch model: gitflow, github-flow, trunk-based or custom (allowed/protected set by hand).",
  developBranch: "The integration branch gitflow uses (default develop).",
  prefixes: "The branch prefix per kind (feature/, bugfix/, release/, hotfix/).",
  allowed: "Branch name globs a new branch must match (`feature/*`).",
  protected: "Branches nobody commits or pushes to directly.",
  integration: "How work reaches its base: `pr` (default) opens a PR, `merge` merges locally.",
};

const COMMIT_POLICY_FIELDS: Record<string, Doc> = {
  preset: "The commit message flavor, e.g. conventional.",
  pattern: "A regular expression every commit subject must match.",
};

/** The `roles` of both `models` keys; config-schemas.ts puts it on the editor definition. */
export const MODEL_ROLES_DESCRIPTION =
  "Per role (decider, implementer, verifier, reviewer, explore, babysit, default for a general-purpose spawn): a model name, `{ model, effort }`, or one of those per host (claude_code, opencode, codex, codex_cli, codex_desktop, cursor, pi, default). The implementer takes one per tier (mundane, standard, hard).";

const WORKSPACE: Doc = {
  fields: {
    name: "The workspace's unique name.",
    glob: "The directories this entry covers, an absolute path glob with * and ** (`/home/you/work/**`); the narrowest match wins.",
    vcs: {
      text: "The forge this workspace's repositories live on.",
      fields: {
        provider: "The forge: github or gitlab.",
        defaultTargetBranch: "The branch PRs target by default.",
        tokenFile: "A file holding the forge token for this workspace.",
        account: "The forge login delivery runs as; grants need it to reach the forge.",
        host: "A self-hosted forge's host name.",
      },
    },
    autoApprove: "Legacy (≤4.x) standing approvals, read once as autonomy grants; use `autonomy`.",
    defaultEndpoint:
      "Where an unnamed request stops: commit (default), pr, green or merged. Set with `workit grant set`, like grants.",
    verification:
      "How a normal-risk behavior change is verified: proportional (default), self or independent. Set with `workit grant set`, like grants.",
    delegation:
      "Who does the work: `inline-first` (default) keeps the lead working itself and refuses a slice without a reason to delegate; `lead-orchestrates` allows slices without one.",
    changelog:
      "The Keep a Changelog step before a PR opens: `off` (default), `update` (an existing CHANGELOG.md needs an Unreleased entry from a user-facing PR) or `create` (the entry is required, creating the file). `workit pr create` enforces it.",
    docs: "The docs refresh the ship skill does before a PR opens: `off` (default) or `when-user-facing`.",
    changelogPath:
      "Where the changelog lives, repo-relative: one path or glob, or a list (a monorepo with one changelog per package; any of them satisfies the gate). Default CHANGELOG.md at the repo root.",
    prTemplate:
      "Which template a PR description fills: `auto` (default: the repo's GitHub/GitLab template, else Workit's), `repo` (the repo's, refused when it has none), `workit` (Workit's Summary/Evidence/Merge danger) or a repo-relative path to one `.md` file.",
    releaseNotes:
      "The release notes `workit release finish` publishes on the forge release: `auto` (default: the draft when there is one, else the notes built from the version's changelog section), `off` (no forge release) or `review` (finish refuses until `workit release notes approve`). A release track overrides it.",
    trailers:
      "Whether commits get the `Workit-Session:` trailer (default true). With false, authorship lives in the ledger only.",
    deleteBranch:
      "Whether `workit pr merge` deletes the head branch after a merge (default true); `--keep-branch` opts out for one merge.",
    cleanup:
      "What happens when work finishes: `auto` (default) removes the delivered branch's clean Workit worktree and local branch, switches a clean checkout on it back to the trunk, and stops the processes registered inside them; `keep` removes and stops nothing. A value Workit does not know reads as `keep`.",
    feedback:
      '`workit feedback` for this workspace: `off` hides its contract line and makes the verb refuse; `{ "account": "<login>" }` names the GitHub login it posts with; workspaces inside this one inherit it.',
    liveSessionGuard:
      "Whether the live-session guard denies edits in a checkout another live agent session owns (default true).",
    shared:
      "Whether this workspace's repos are shared with a team that must not see Workit named (default false): `workit pr create` and `workit pr edit` then warn, never block, when the PR title, body or a new doc names it.",
    fanout: {
      text: "Fanout settings.",
      fields: {
        tierModels: "The model per slice TIER (mundane, standard, hard), as one name or per host.",
        deps: "How `workit fanout worktree create` gives a slice worktree node_modules: `install` (default: its own frozen install of its lockfile) or `link` (links into the main checkout's installed packages, for a repo too slow to install per slice). `--deps` overrides it.",
        installTimeout:
          "How long the own install may run before its process tree is killed and the worktree is linked instead: a duration such as `90s` or `10m` (default `5m`). `--install-timeout` overrides it.",
      },
    },
    models: {
      text: "Model and effort per role and host (roles), the lead's own advisory model (lead), how a role model applies (enforce: advise, the default, or strict) and, under strict, whether a model the lead names on a spawn wins (allowLeadOverride, default false); the same key at the top of workspaces.json is the global default.",
      fields: { roles: MODEL_ROLES_DESCRIPTION },
    },
    resources:
      "Heavy-check limits on this machine: slots, scope, heavy, light, memoryMax, cpuQuota, wait.",
    remotes:
      "Remote URLs this entry owns: a checkout pushing to or opening PRs on one never exceeds this entry's grants, wherever the folder is (`owner/*` claims a whole owner). Only the user changes it, in their own terminal.",
    externalRepos:
      "Repositories outside this workspace's own forge owners that `workit issue create|comment|close --repo` may write to: `owner/name`, or `owner/*` for a whole owner. Only the user changes it, in their own terminal.",
    additiveRiskPaths:
      "Risk-path globs whose purely additive edits follow the review lane of the rest of the diff. Only the user sets it; it counts only while sealed.",
    autonomy: {
      text: "Autonomy grants (D15): only ever set here, by the user, with `workit grant set`.",
      fields: Object.fromEntries(
        ["push", "pr", "merge", "release", "rerun"].map((kind) => [
          kind,
          `The ${kind} grant: true, false, or "verified" (only after a verdict).`,
        ]),
      ),
    },
    youtrack: {
      text: "YouTrack settings for this workspace.",
      fields: {
        baseUrl: "This workspace's YouTrack URL.",
        link_issues: "Legacy alias of `issues: { provider: youtrack, link: true }`.",
        writes:
          "ask (default): each workit youtrack write waits for the user's yes. auto: posts without asking, behind WORKIT_YT_WRITE=1.",
        autoHosts:
          "With writes auto: the only YouTrack hosts (`acme.youtrack.cloud`) a write may reach without asking. A raw ytrack write must name one with --host; a write elsewhere asks. Only the user widens it, in their own terminal (`workit workspace seal`).",
      },
    },
    issues: {
      text: "The issue tracker PRs link to (any forge with any tracker).",
      fields: {
        provider: "The issue tracker PRs link to.",
        link: "Derive the issue from the branch name.",
        relation: "How a PR names its issue: `closes` (default) or `refs`.",
        backlink: "Post the PR URL on each linked issue after the PR is opened.",
        link_on_pr: "Legacy alias of `link`.",
        repo: "The GitHub/GitLab repository (owner/name) that holds the issues; default the PR's own.",
        host: "That repository's host; default the PR's host, or the tracker's public one.",
      },
    },
    branchPolicy: {
      text: "Which branches may be created and which are protected.",
      fields: BRANCH_POLICY_FIELDS,
    },
    commitPolicy: { text: "The commit message rules.", fields: COMMIT_POLICY_FIELDS },
    defaultProfile: "The profile used when none is named; must be a key of `profiles`.",
    profiles: {
      text: "Named branch/commit policy variants of this workspace.",
      item: {
        fields: {
          branchPolicy: { text: "This profile's branch policy.", fields: BRANCH_POLICY_FIELDS },
          commitPolicy: { text: "This profile's commit policy.", fields: COMMIT_POLICY_FIELDS },
        },
      },
    },
    releaseTracks: {
      text: "Named release tracks: production and integration branches, naming and versioning.",
      item: {
        fields: {
          strategy: "The branch model this track follows.",
          productionBranch: "The branch releases land on (main).",
          integrationBranch: "The branch work integrates into (develop).",
          naming: "Branch name templates per kind, e.g. `feature/{name}`.",
          baseBranch: "The branch new work starts from.",
          mergeBackBranches: "Branches a finished release or hotfix is merged back into.",
          pullRequestTarget: "The branch PRs target.",
          tagNamespace: "A prefix for this track's release tags.",
          versionSource: "Where the version comes from: package-json, git-tag or manual.",
          requiredChecks: "CI checks that must pass before a release.",
          critical:
            "Fields an older Workit must not ignore: when one is unknown or malformed, Workit fails closed.",
          releaseNotes: "This track's release notes mode, over the workspace's `releaseNotes`.",
        },
      },
    },
    releasePackages:
      "Packages released from this repository's own release line under their own tag namespace (`pkg-a@0.1.0`): keyed by package name, each `{ tagNamespace?, changelogPath? }` (default namespace `<name>@`). `workit release package <name> <version>` tags and publishes one.",
  },
};

const WORKSPACES_FILE: Doc = {
  fields: {
    workspaces: {
      text: "Workspace entries, each mapping a path glob to its forge, policies and grants.",
      item: WORKSPACE,
    },
    models: {
      text: "The global default model and effort per role and host (roles), the lead's own advisory model (lead), how a role model applies (enforce: advise, the default, or strict) and, under strict, whether a model the lead names on a spawn wins (allowLeadOverride, default false).",
      fields: { roles: MODEL_ROLES_DESCRIPTION },
    },
    feedback: {
      text: "`workit feedback` defaults for every workspace.",
      fields: {
        account:
          "The GitHub login `workit feedback --post` uses when no workspace names one; never the workspace's work account by default.",
      },
    },
  },
};

type Def = Record<string, unknown> & { type: string };
const defOf = (schema: ZodMiniType): Def => schema._zod.def as unknown as Def;
const rebuild = <T extends ZodMiniType>(schema: T, patch: Record<string, unknown>): T =>
  schema.clone({ ...defOf(schema), ...patch } as T["_zod"]["def"]);

/** `schema` (an optional, object, array or record) with its fields or item described. */
const withInner = <T extends ZodMiniType>(schema: T, doc: Exclude<Doc, string>, at: string): T => {
  const def = defOf(schema);
  if (def.type === "optional")
    return rebuild(schema, { innerType: withInner(def.innerType as ZodMiniType, doc, at) });
  if (def.type === "object" && doc.fields) {
    const shape = { ...(def.shape as Record<string, ZodMiniType>) };
    for (const [key, field] of Object.entries(doc.fields)) {
      if (!shape[key]) throw new Error(`workspace-descriptions: no field ${at}.${key}`);
      shape[key] = withDocs(shape[key], field, `${at}.${key}`);
    }
    return rebuild(schema, { shape });
  }
  if (def.type === "array" && doc.item !== undefined)
    return rebuild(schema, { element: withDocs(def.element as ZodMiniType, doc.item, `${at}[]`) });
  if (def.type === "record" && doc.item !== undefined)
    return rebuild(schema, {
      valueType: withDocs(def.valueType as ZodMiniType, doc.item, `${at}{}`),
    });
  throw new Error(`workspace-descriptions: cannot describe the ${def.type} at ${at}`);
};

const withDocs = <T extends ZodMiniType>(schema: T, doc: Doc, at: string): T => {
  if (typeof doc === "string") return described(schema, doc);
  const inner = doc.fields || doc.item !== undefined ? withInner(schema, doc, at) : schema;
  return doc.text === undefined ? inner : described(inner, doc.text);
};

/** workspacesFileSchema with the editor descriptions, for config-schemas.ts only. */
export const describedWorkspacesFileSchema = (): typeof workspacesFileSchema =>
  withDocs(workspacesFileSchema, WORKSPACES_FILE, "workspaces.json");
