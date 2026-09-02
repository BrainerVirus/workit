# Agent Contract

Multi-platform workit: OpenCode, Cursor, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature | OpenCode | Cursor | CLI |
| --- | --- | --- | --- |
| Approval | native `question` tool receipts | AskQuestion policy-only (`attested: false`) | `--confirm` flags / TTY prompts |
| Implementation | subagent-driven via native `task`, delegated status from session parentage (`parentID` = recorded `coordinator_session_id`) | subagent-driven via lease/token: `workit_plan_menu` (subagent-driven) returns a one-time `coordinator_lease`, `workit_delegate` mints a task-scoped `delegation_token` (fail-closed, hash-only) passed by Cursor-native subagents on mutation calls; Inline = `executing-plans` single-agent | n/a (`workit flow` lifecycle only) |
| Lifecycle | `workit_plan_pause`/`resume`/`complete` (receipts) | `workit_plan_pause`/`resume`/`complete` (policy-only) | `workit flow pause\|resume\|complete` |
| Handoff | spawns a native OpenCode session | seeds a handoff prompt for the next agent | `workit handoff` (prints the destination prompt) |
| Tools | native plugin tools | MCP server (`workit_*`) | `workit` commands |
| Skills | `skills.paths` + vendored dirs | plugin `skills/` dirs | n/a |
| Branch policy init | `workit_init_apply action=branch_policy` | same MCP tool | wizard screen |
| Distribution | npm plugin entry (`opencode.json`) | Cursor Marketplace (git-discovered `.cursor-plugin/plugin.json`) | npm bin (`npx`) |

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.
4. Marketplace distribution is host-native: Cursor discovers the plugin from Git (`.cursor-plugin/plugin.json` + tracked skills/rules/assets), OpenCode installs the npm plugin entry, and the CLI ships as an npm bin. The tracked Marketplace artifact is validated in CI by `validate:cursor-marketplace` against the pinned official Cursor JSON schema snapshots (`test/fixtures/cursor-schemas/`). `marketplace.json` `plugins[].source` is repo-root-relative (the directory containing `.cursor-plugin/`), not `.cursor-plugin/`-relative. Never claim Marketplace publication or acceptance; keep the repository submission-ready but not submitted.
5. Cursor runtime execution uses the `@latest` dist-tag with the mandatory `--prefer-online` flag (`npx -y --prefer-online --package=@brainervirus/workit-cursor@latest …`): `--prefer-online` forces fresh registry re-resolution so a stale `latest` in the `_npx` cache is never reused. The selector is intentional — no per-release manual pin bump is required, and the doctor enforces this exact launcher shape.
6. Stale-install auto-load repair is automatic and fail-open: the doctor's `stale_install` finding (legacy `mcp.json`/hook selectors, or a local-dist install behind the current/published runtime) is enforced by `install-cursor-plugin.sh` via a `doctor-check.ts cursor --stale` pre-check — exit 2 triggers a refresh + canonical re-registration, a healthy install is byte-untouched, and a registry-unreachable comparison warns as `registry_unreachable` (never `stale_install`, never an install failure). Canonical `@latest` installs never fail on version metadata.

## Workflow contract

- Specs/plans live in `docs/<slug>/`; spec+plan are committed, `sdd/` is gitignored.
- Approvals bind to the exact SHA-256 digest of the approved document bytes; editing an approved spec/plan invalidates the approval and forces a fresh reapproval (drift resets the whole approval chain in spec-before-plan order).
- Execution lifecycle is exactly `pending` → `active` → `paused`/`active` → `completed`; completion requires a complete SDD ledger and passing repository verification. Subagent-driven product edits are intercepted while the plan is active.
- The execution contract mandates ending each run with `workit_plan_complete` (or the CLI `workit flow complete`) after the final task once the SDD ledger is complete (all task IDs appended) and repository verification passes; a run never finishes while the plan is still `active`.
- Each SDD task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite an active review range, and each progress line records the task's real `base..head` shas. `sddReviewPackage` and the progress-line validator reject empty (`base == head` or empty-diff) ranges with a structured error; the CLI exposes the review path as `workit flow review-package --plan <path> --base <sha> --head <sha> [--confirm]`.
- An ordinary post-plan session presents five choices; a handoff-destination session presents exactly four (never the originating Handoff option) and carries the handoff-destination marker.
- Approval evidence: OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity). Receipt and menu labels are compared semantically: host qualifiers such as `(Recommended)` and `(new session only)` are normalized at comparison time, and the original label bytes are preserved. Receipts are purpose-bound: each gate consumes the newest unconsumed fresh receipt for exactly its purpose (`spec-approval`, `plan-approval`, `execution-menu`, `plan-pause`, `plan-resume`, `plan-complete`); unrelated questions never authorize or mask a gate.
- Delegated authority is direct-child-only: a worker's host `parentID` must equal the activating coordinator's recorded `coordinator_session_id`; mismatched or multi-owner lineage fails closed (`delegation_lineage_denied`), nested `opencode` launches are denied during active delegated work, and authorized children receive compact worker-only context. On Cursor, delegated authority is lease/token-based instead of parentage-based: the one-time `coordinator_lease` from an accepted subagent-driven menu mints task-scoped `delegation_token`s via `workit_delegate` (fail-closed, hash-only persistence), which OpenCode does not use — its delegation stays parentID-derived.
- VCS routing is per-workspace: `workspaces.json` `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow, resolved in the order explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The active `vcs.json` carries no global `defaultTargetBranch`; a global default can no longer shadow a matched workspace's branchPolicy default. On GitHub, `prCreate` pushes the branch before `gh pr create` when `pr.pushBranch` is enabled (default), and a caller-supplied target equal to the resolved default is accepted even though protected. The runtime reads only the active `~/.config/workit/` config dir; legacy `~/.config/workflow-toolkit/` non-secret files were cleaned up once the active config passed status checks.
- Never use worktrees; use guarded in-place branch setup.
