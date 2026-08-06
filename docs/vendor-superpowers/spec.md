# Spec: Vendor Superpowers + feature-scoped docs layout

**Branch:** `feature/vendor-superpowers`

## Context

OpenCode loads Superpowers from an unpinned git plugin: `superpowers@git+https://github.com/obra/superpowers.git` (currently 6.1.1). Cursor loads it via its own `session-start` hook and skills. The toolkit already overrides much of the Superpowers behavior (doc contract, visual companion ban, no-worktrees, SDD paths, post-plan menu) through its own bootstrap injection and `wf-*` skills — but the upstream dependency stays unpinned, so every `obra/superpowers` release can change behavior under the user without notice, and the toolkit's overrides are layered on top of a moving target.

Additionally, the workflow docs layout `docs/superpowers/{specs,plans,sdd}/` separates a feature's artifacts across three trees with a dated naming scheme, and the whole tree is gitignored so spec/plan don't travel with the branch. The user wants a feature-scoped layout: `docs/<slug>/` holding `spec.md`, `plan.md`, and `sdd/` together, with spec+plan committed (only `sdd/` gitignored).

Goal: vendor the parts of Superpowers the user actually relies on (the 14 engineering-process skills + minimal bootstrap) into the toolkit as a first-class, versioned copy; remove the external plugin from OpenCode and the Cursor hook (toolkit = single source of truth, updates via script, never by surprise); and migrate the workflow docs to a feature-scoped `docs/<slug>/` layout.

## Goals

1. Copy the 14 Superpowers skills (brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills) into `vendor/superpowers/skills/`.
2. Copy the minimal bootstrap logic (the OpenCode plugin `superpowers.js` adapted to point at the vendored skills dir) into `vendor/superpowers/plugin.js`.
3. Record provenance: `vendor/superpowers/VERSION` (upstream version vendored) and `vendor/superpowers/NOTICE.md` (source, license, update procedure).
4. Provide `scripts/update-superpowers.sh` that fetches upstream, copies skills + plugin, writes VERSION, and reports a diff for a manual commit.
5. Remove `superpowers@git+https://github.com/obra/superpowers.git` from OpenCode config; remove any Cursor-side Superpowers hook dependency. The toolkit's existing bootstrap/contract injection remains the override layer.
6. Keep all existing `wf-*` skills untouched. No renames; two skill folders with distinct roles.
7. **Migrate workflow docs** from `docs/superpowers/{specs,plans,sdd}/YYYY-MM-DD-<slug>...` to `docs/<slug>/{spec.md,plan.md,sdd/}`:
   - `docs/<slug>/spec.md` and `docs/<slug>/plan.md` are **committed** (travel with the branch).
   - `docs/<slug>/sdd/` (progress, briefs, review diffs, `flow.json`) stays **gitignored** (working state).
   - The slug is the directory name; `feature/<slug>` derives from it (no date parsing).
8. Update the contract, all path-bearing tools, tests, and sync to the new layout.

## Non-goals

- Vendoring Superpowers docs, tests, assets, or packaging scripts (the toolkit does not use them).
- Changing the toolkit's contract/override behavior (doc contract, visual companion ban, no-worktrees, SDD paths, post-plan menu) — already shipped and validated.
- Git submodules.
- Changing Superpowers skill contents (vendor as-is; user decides when to update).
- Migrating existing `docs/superpowers/` artifacts on disk (one-time, user-side; the toolkit stops reading the old paths).

## Architecture

### 1. Vendored layout

```
vendor/superpowers/
├── skills/          ← 14 skills copied verbatim from obra/superpowers (each a SKILL.md dir)
├── plugin.js        ← upstream .opencode/plugins/superpowers.js, adapted:
│                      - skills dir resolved to ../../vendor/superpowers/skills
│                      - no dependency on the external package install path
├── VERSION          ← upstream version (e.g. "6.1.1")
└── NOTICE.md        ← source URL, MIT license note, update instructions
```

### 1b. Feature-scoped docs layout

```
docs/<slug>/
├── spec.md          ← committed
├── plan.md          ← committed (links **Spec:** docs/<slug>/spec.md)
└── sdd/             ← gitignored (working state)
    ├── progress.md
    ├── flow.json
    ├── task-<n>-brief.md
    └── review-<a>..<b>.diff
```

Mapping from the old scheme:

| Old | New |
| --- | --- |
| `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` | `docs/<slug>/spec.md` |
| `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` | `docs/<slug>/plan.md` |
| `docs/superpowers/sdd/<slug>/` | `docs/<slug>/sdd/` |
| `flow_path = docs/superpowers/sdd/<slug>/flow.json` | `docs/<slug>/sdd/flow.json` |
| slug derived from filename date | slug = directory name |

`.gitignore`: `docs/superpowers/` rule is replaced by `docs/*/sdd/` (spec.md/plan.md stay tracked). The old `docs/superpowers/` rule is removed (legacy tree is user-side cleanup).

`plugin.js` is kept only for provenance/audit (the toolkit's own `src/plugin.ts` already registers skill paths and injects the bootstrap; the vendored plugin.js is not loaded by OpenCode). The actual loading path is via `src/plugin.ts` skill registration.

### 2. Registration (Toolkit as single source)

`src/plugin.ts` `config` hook already appends `skills/` to `mutable.skills.paths`. Extend it to also append `vendor/superpowers/skills` (guarded against duplicates, same pattern). OpenCode discovers both folders; the vendored skills appear under their original names (brainstorming, writing-plans, …) alongside `wf-*`.

OpenCode config (`opencode.json`): remove the `superpowers@git+https://github.com/obra/superpowers.git` entry from `plugin`.

Cursor: the toolkit's `cursor/hooks/session-start` already injects the workflow contract and is the only hook the plugin copy runs (`hooks-cursor.json`). Verify no leftover Superpowers hook reference remains in the Cursor plugin copy; the vendored skills are registered via the toolkit's skill registration (Cursor reads the same `skills/` + `vendor/superpowers/skills` folders copied by sync-runtime).

### 2b. Path migration in the toolkit

All path-bearing code moves from `docs/superpowers/{specs,plans,sdd}/` to `docs/<slug>/`:

- `docs-validate.ts`: `spec_path`/`plan_path` resolve under `docs/<slug>/`; plan `**Spec:**` link is `docs/<slug>/spec.md`; mirror-path support (`docs/specs/`) is dropped.
- `flow-state.ts`: `flow.json` at `docs/<slug>/sdd/flow.json`.
- `sdd.ts`: `sdd_dir = docs/<slug>/sdd`; `progress.md`, briefs, diffs under it.
- `handoff-context.ts`: resolution becomes "single dir per feature": find `docs/<slug>/plan.md` (+ `spec.md`), message paths `docs/<slug>/…`, slug = dir name; the specs/plans two-tree scan is replaced by a `docs/*/` scan.
- `branch.ts`: slug derives from the `docs/<slug>` dir name (no date prefix stripping); `feature/<slug>`; stash exclude path becomes `:!docs/*/sdd`.
- `plan-tasks.ts`, `tools/flow.ts`, `tools/handoff.ts`, `tools/sdd.ts`, `tools/repo.ts`: same path constants.
- `templates/superpowers-doc-contract.md` and `templates/execution-contract.md`: document layout table updated to the new scheme.
- `sync-runtime.sh`: ensure `vendor/superpowers/skills` and the new docs layout are covered (vendored skills synced for Cursor).
- `.gitignore`: `docs/superpowers/` rule → `docs/*/sdd/` (spec.md/plan.md stay tracked).

### 3. Update script

`scripts/update-superpowers.sh`:

- `--pin <version>` optional (default: latest tag/release).
- Clones `git@github.com:obra/superpowers.git` (or `--https`) into a temp dir, checks out the pin (or `main`), copies `skills/*` → `vendor/superpowers/skills/`, copies `.opencode/plugins/superpowers.js` → `vendor/superpowers/plugin.js` (with the skills-dir adaptation applied), writes `VERSION`, and prints a summary + `git status` for the user to review and commit.
- Never pushes. Never commits automatically.
- Fails loudly if the temp clone or copy fails; leaves the tree untouched on failure.

### 4. Bootstrap / contract

No change. `src/bootstrap.ts` already injects the toolkit contract on the first user turn, which overrides Superpowers defaults. The vendored `using-superpowers` skill remains (it is the entry skill the contracts reference), but the contract text already supersedes its conflicting options.

## Data flow

1. User decides to vendor (this change) or update later: `./scripts/update-superpowers.sh [--pin X.Y.Z]`.
2. Script copies upstream skills + plugin into `vendor/superpowers/`, writes VERSION, reports diff.
3. User reviews, commits, pushes — the toolkit now carries its own copy.
4. OpenCode loads skills from `skills/` + `vendor/superpowers/skills` (registered by `src/plugin.ts`); no external plugin.
5. Cursor loads the same via the synced plugin copy.
6. Workflow artifacts live at `docs/<slug>/{spec.md,plan.md,sdd/}`; `flow.json` state under `sdd/`; spec+plan committed, sdd ignored.

## Error handling

- Update script: any `git clone`/`checkout`/`cp` failure → non-zero exit, clear stderr, no partial writes (copy into temp staging dir first, then `rsync`/`mv` into vendor only on success).
- Missing `vendor/superpowers/` at runtime: `src/plugin.ts` skill registration skips nonexistent dirs (existing pattern: only push the path if it exists, or tolerate absence) — toolkit must still load with only `skills/` present.
- Duplicate skill names between vendored and `wf-*`: none (wf-* names are distinct), but the registration guard prevents double-adding the same path.

## Verification

- `bun run check` green (existing suite + new tests).
- New test: `vendor/superpowers/skills` contains ≥14 SKILL.md files, each with valid YAML frontmatter (`name:` + `description:`).
- New test: `src/plugin.ts` config hook registers both `skills/` and `vendor/superpowers/skills` paths (no duplicates).
- New test: VERSION file exists and matches the upstream version copied.
- Manual smoke (post-merge, user-side): `opencode` shows brainstorming/writing-plans in `/skills`; Cursor agent CLI shows the same; `openCode` still injects the toolkit contract first.
- `scripts/update-superpowers.sh` dry check: runs against upstream clone in temp; asserts VERSION written and skills copied; does not touch git state beyond the vendor dir.
- Docs-layout tests: fixtures create `docs/<slug>/{spec.md,plan.md,sdd/}`; `workflow_docs_validate`, `workflow_flow_status`, `workflow_sdd_context`, and handoff resolution all pass against the new layout; old `docs/superpowers/` paths are absent from all sources (grep check).

## Compatibility

- Existing projects: the skills/contract behavior is unchanged (same skills, same contract); the **docs layout is a breaking path change** — any workflow started under the old `docs/superpowers/` layout is not auto-migrated (user-side one-time cleanup; the toolkit stops reading old paths).
- The `using-superpowers` skill is vendored as-is; its references to "superpowers plugin" remain textually but the toolkit contract (injected after it) is authoritative.
- Sync-runtime for Cursor copies `cursor/` and (already) `skills/`; the vendored skills must be included in the synced copy so Cursor sees them — extend sync-runtime's rsync include list if needed.

## Out of scope (tracked separately)

- Any change to the toolkit contract or skill contents.
- Vendoring future upstream docs/tests.
